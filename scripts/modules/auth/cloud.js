// ============================================================
// 雲端同步層：Google Sheets（via Google Apps Script Web App）
// ------------------------------------------------------------
// 設計原則（同 db.js 的「覆寫 / 鏡像」雙層快取完全一致）：
//
//   · 讀取（Read）＝ 本機優先，雲端做背景校驗
//       登入／啟動時先讀 localStorage（零網絡、零 await → 秒開），
//       之後背景向雲端要最新版本，較新才覆寫本機並通知 UI 重繪。
//
//   · 寫入（Write）＝ 本機即時、雲端非阻塞
//       任何改動先同步寫入 localStorage（用戶永遠唔會等），
//       再排入佇列非阻塞推送；網絡失敗就留喺佇列，下次啟動／上線自動補送。
//
//   · 離線佇列只存「帳號 id」，唔會複製頭像 Base64，
//       補送時才由 authAccounts 取最新資料，避免 localStorage 撐爆。
//
// ⚠ CORS 關鍵：POST 必須用 Content-Type: text/plain;charset=utf-8。
//   若用 application/json，瀏覽器會先送 OPTIONS preflight，
//   而 Apps Script 唔支援 OPTIONS，請求會直接失敗。
// ============================================================

const CLOUD_STATE_KEY = 'appdb_v1_cloud_state';      // { id: { updatedAt, cloudUpdatedAt } }
const CLOUD_QUEUE_KEY = 'appdb_v1_cloud_queue';      // [ { action:'upsert'|'delete', id, at } ]
const CLOUD_LAST_SYNC_KEY = 'appdb_v1_cloud_last_sync';

// 客戶端 → 雲端的欄位白名單（同 GAS 的 HEADERS 對應）
const CLOUD_PUSH_FIELDS = [
    'id', 'name', 'email', 'provider', 'salt', 'passwordHash', 'avatar',
    'classId', 'className', 'schedulePath', 'customClass', 'createdAt', 'lastLoginAt'
];

let cloudState = {};            // 每個帳號「已同步版本」的本地時間戳
let cloudQueue = [];            // 待補送的寫入
let cloudPhase = 'idle';        // idle | syncing | pending | offline | error
let cloudLastError = '';
let cloudLastSyncAt = 0;
let cloudReady = false;         // 是否已由 localStorage 載入狀態
let cloudPushTimer = null;
let cloudFlushPromise = null;
const cloudListeners = [];

/* ================= 設定 ================= */

function cloudConfig() {
    const config = (typeof window !== 'undefined' && window.APP_AUTH_CONFIG) ? window.APP_AUTH_CONFIG : {};
    const cloud = config.cloud || {};
    return {
        enabled: cloud.enabled !== false,
        endpoint: String(cloud.endpoint || '').trim(),
        timeoutMs: Number(cloud.timeoutMs) || 12000,
        retry: Number(cloud.retry)
    };
}

// 冇填 endpoint 就等同「純本機模式」：所有雲端函式都會安全地變成 no-op
function cloudEnabled() {
    const config = cloudConfig();
    return !!(config.enabled && config.endpoint);
}

function cloudRequestRetries() {
    const value = cloudConfig().retry;
    return Number.isFinite(value) ? Math.max(0, value) : 2;
}

/* ================= 持久化（狀態 + 佇列） ================= */

function cloudEnsureLoaded() {
    if (cloudReady) return;
    cloudReady = true;

    try {
        const state = Storage.get(CLOUD_STATE_KEY, null);
        cloudState = (state && typeof state === 'object' && !Array.isArray(state)) ? state : {};
    } catch (e) {
        cloudState = {};
    }

    try {
        const queue = Storage.get(CLOUD_QUEUE_KEY, null);
        cloudQueue = Array.isArray(queue) ? queue.filter(job => job && job.id) : [];
    } catch (e) {
        cloudQueue = [];
    }

    cloudLastSyncAt = Number(Storage.get(CLOUD_LAST_SYNC_KEY, 0)) || 0;
    cloudPhase = cloudQueue.length ? 'pending' : 'idle';
}

function cloudPersistState() {
    try { Storage.set(CLOUD_STATE_KEY, cloudState); } catch (e) { /* quota：忽略 */ }
}

function cloudPersistQueue() {
    try { Storage.set(CLOUD_QUEUE_KEY, cloudQueue); } catch (e) { /* quota：忽略 */ }
}

function cloudPersistLastSync() {
    try { Storage.set(CLOUD_LAST_SYNC_KEY, cloudLastSyncAt); } catch (e) { /* 忽略 */ }
}

/* ================= 狀態通知（供 UI 訂閱） ================= */

function cloudSubscribe(listener) {
    if (typeof listener !== 'function') return function () {};
    cloudListeners.push(listener);
    return function unsubscribe() {
        const index = cloudListeners.indexOf(listener);
        if (index >= 0) cloudListeners.splice(index, 1);
    };
}

function cloudSetPhase(phase, error) {
    const changed = (phase !== cloudPhase) || (String(error || '') !== cloudLastError);
    cloudPhase = phase;
    cloudLastError = String(error || '');
    if (changed) {
        cloudListeners.slice().forEach(listener => {
            try { listener(cloudStatus()); } catch (e) { /* 個別訂閱者出錯唔影響其他 */ }
        });
    }
}

/**
 * 真正「仲未上到雲端」的項目數＝佇列 + 已改動但未入佇列的帳號。
 * 點解要加後者：本機寫入之後有 400ms 防抖，呢段空窗期若只睇佇列長度，
 * 狀態標籤會仍然顯示「已同步」——對用戶嚟講就係呃佢。
 */
function cloudPendingCount() {
    cloudEnsureLoaded();
    if (!cloudEnabled()) return 0;
    return Math.max(cloudQueue.length, cloudDirtyCount());
}

/** 本地版本未推送過的帳號數目 */
function cloudDirtyCount() {
    cloudEnsureLoaded();
    if (!cloudEnabled() || typeof authGetAccounts !== 'function') return 0;

    let count = 0;
    (authGetAccounts() || []).forEach(account => {
        if (!account || !account.id) return;
        const synced = cloudState[account.id];
        if (!synced || Number(synced.updatedAt) !== Number(account.updatedAt)) count += 1;
    });
    return count;
}

/**
 * 對外狀態快照。UI 只需要讀呢個物件就可以畫出提示。
 * @returns {{enabled:boolean, phase:string, pending:number, lastSyncAt:number, label:string, tone:string}}
 */
function cloudStatus() {
    cloudEnsureLoaded();

    const pending = cloudPendingCount();

    // 有嘢未送出去時，網絡狀態優先於「idle」顯示，否則用戶會以為已同步
    let phase = cloudPhase;
    if (phase === 'idle' && pending) phase = 'pending';
    if (phase !== 'syncing' && typeof navigator !== 'undefined' && navigator.onLine === false) {
        phase = 'offline';
    }

    const map = {
        idle:    { label: '雲端已同步', tone: 'synced' },
        syncing: { label: '同步中…', tone: 'syncing' },
        pending: { label: pending ? ('待同步 ' + pending + ' 項') : '待同步', tone: 'pending' },
        offline: { label: pending ? ('離線 · 待同步 ' + pending + ' 項') : '離線模式', tone: 'offline' },
        error:   { label: '同步失敗 · 點擊重試', tone: 'error' }
    };

    const view = map[phase] || map.idle;

    return {
        enabled: cloudEnabled(),
        phase: phase,
        pending: pending,
        lastSyncAt: cloudLastSyncAt,
        label: cloudEnabled() ? view.label : '本機模式',
        tone: cloudEnabled() ? view.tone : 'off'
    };
}

/* ================= 網絡請求 ================= */

function cloudAbortableFetch(url, options, timeoutMs) {
    const opts = Object.assign({ cache: 'no-store' }, options || {});

    if (typeof AbortController !== 'function') return fetch(url, opts);

    const controller = new AbortController();
    opts.signal = controller.signal;
    const timer = setTimeout(() => {
        try { controller.abort(); } catch (e) { /* 已 abort：忽略 */ }
    }, timeoutMs);

    return fetch(url, opts).finally(() => clearTimeout(timer));
}

function cloudSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** 互動式認證（登入／註冊）的整體時間預算：由用戶按下按鈕起計，唔係逐個請求計 */
const CLOUD_INTERACTIVE_BUDGET_MS = 8000;

/** 建立一個共用截止時間，令同一條流程內的多個請求加起來唔會超過預算 */
function cloudMakeDeadline(budgetMs) {
    const budget = Number(budgetMs) || CLOUD_INTERACTIVE_BUDGET_MS;
    return Date.now() + budget;
}

/** 逾時／網絡類錯誤 → 上層可據此顯示「已切換離線模式」 */
function cloudIsOfflineCode(code) {
    return code === 'NETWORK' || code === 'TIMEOUT' || code === 'BAD_JSON';
}

/**
 * 呼叫 GAS API。
 * @param {string} action  動作名稱
 * @param {Object} payload 參數
 * @param {Object} [opts]  { timeoutMs, retry }
 * @returns {Promise<Object>} 永遠 resolve；失敗時回傳 { status:'error', code:'NETWORK'|... }
 */
async function cloudRequest(action, payload, opts) {
    if (!cloudEnabled()) {
        return { status: 'error', code: 'DISABLED', message: '雲端同步未啟用' };
    }

    const config = cloudConfig();
    const options = opts || {};
    const timeoutMs = Number(options.timeoutMs) || config.timeoutMs;
    const maxRetry = Number.isFinite(options.retry) ? options.retry : cloudRequestRetries();

    // 整體截止時間（絕對時間戳）。一條流程會連續發多個請求，
    // 若只做「每個請求各自逾時」，累加起來用戶要等 30 秒以上才見到錯誤。
    const deadline = Number(options.deadline) || 0;

    const body = JSON.stringify(Object.assign({ action: action }, payload || {}));
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetry; attempt += 1) {
        // 每次嘗試只可以用「剩餘預算」，確保總時間唔會超出 deadline
        let budget = timeoutMs;
        if (deadline) {
            budget = deadline - Date.now();
            if (budget <= 0) {
                lastError = { code: 'TIMEOUT', message: '雲端無回應（整體逾時）' };
                break;
            }
            budget = Math.min(budget, timeoutMs);
        }

        try {
            const response = await cloudAbortableFetch(config.endpoint, {
                method: 'POST',
                // ⚠ 必須維持 text/plain：改做 application/json 會觸發 preflight 而失敗
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: body,
                redirect: 'follow'
            }, budget);

            if (!response.ok) {
                lastError = { code: 'HTTP_' + response.status, message: 'HTTP ' + response.status };
            } else {
                const text = await response.text();

                // 部署權限設錯（唔係「任何人」）時，Google 會回傳 HTML 登入頁
                if (/^\s*</.test(text)) {
                    lastError = {
                        code: 'NOT_DEPLOYED',
                        message: '回應唔係 JSON（請把 GAS 部署權限設為「任何人」）'
                    };
                } else {
                    try {
                        return JSON.parse(text);
                    } catch (parseError) {
                        lastError = { code: 'BAD_JSON', message: '無法解析伺服器回應' };
                    }
                }
            }
        } catch (error) {
            // AbortError 獨立成 TIMEOUT，令上層能準確顯示「逾時」而唔係籠統的網絡錯誤
            const aborted = !!(error && error.name === 'AbortError');
            lastError = {
                code: aborted ? 'TIMEOUT' : 'NETWORK',
                message: aborted
                    ? ('雲端無回應（' + budget + 'ms 逾時）')
                    : String((error && error.message) || error)
            };
        }

        if (attempt < maxRetry) {
            // 補送前先確認仲有預算，免得白等 sleep 之後才放棄
            if (deadline && deadline - Date.now() <= 0) break;
            await cloudSleep(600 * (attempt + 1));
        }
    }

    return {
        status: 'error',
        code: (lastError && lastError.code) || 'NETWORK',
        message: (lastError && lastError.message) || '雲端連線失敗'
    };
}

/** 連線測試（開發者面板／除錯用） */
async function cloudPing() {
    return cloudRequest('ping', {}, { retry: 0 });
}

/* ================= 讀取：登入／背景校驗 ================= */

/**
 * 由雲端驗證登入。分兩步：先取 salt，再送本地計算的雜湊值。
 * 明碼密碼永遠唔會離開裝置。
 * @returns {Promise<{ok:boolean, account?:Object, code?:string, message?:string, offline?:boolean}>}
 */
async function cloudSignIn(email, password) {
    const normalized = String(email || '').trim().toLowerCase();

    // ⚠ salt 同 login 必須共用同一份 8 秒預算。
    // 若分開計算，兩步各自逾時疊加起來最壞要等 33 秒，用戶會以為當機。
    const deadline = cloudMakeDeadline(CLOUD_INTERACTIVE_BUDGET_MS);

    const saltResult = await cloudRequest('salt', { email: normalized }, { retry: 1, deadline: deadline });

    if (saltResult.status !== 'success') {
        // 雲端明確回報查無此帳號 → 同「連線失敗」係兩件事，唔可以當成離線
        if (saltResult.code === 'NO_ACCOUNT') {
            return { ok: false, code: 'NO_ACCOUNT', offline: false, message: '這個 Email 尚未註冊' };
        }
        return { ok: false, code: saltResult.code || 'NETWORK',
                 offline: cloudIsOfflineCode(saltResult.code),
                 message: saltResult.message || '無法連線到雲端' };
    }

    if (typeof authHashPassword !== 'function') {
        return { ok: false, code: 'NO_HASH', offline: true, message: '密碼雜湊模組未載入' };
    }

    const passwordHash = await authHashPassword(password, saltResult.salt);
    const loginResult = await cloudRequest('login', {
        email: normalized,
        passwordHash: passwordHash
    }, { retry: 1, deadline: deadline });

    if (loginResult.status !== 'success') {
        return {
            ok: false,
            code: loginResult.code || 'NETWORK',
            offline: cloudIsOfflineCode(loginResult.code),
            message: loginResult.message || '登入失敗'
        };
    }

    const account = authNormalizeAccount(loginResult.account || {});
    // 伺服器回傳的 updatedAt 代表雲端版本；本地未改過 → 直接當作已同步
    cloudMarkSynced(account, Number(loginResult.account && loginResult.account.updatedAt) || 0);

    return { ok: true, account: account };
}

/**
 * 下載單一帳號最新版本（不含密碼欄位）。
 * 主要供啟動時的背景校驗使用。
 */
async function cloudFetchAccount(id, email) {
    const query = id ? { id: id } : { email: String(email || '').trim().toLowerCase() };
    if (!query.id && !query.email) return { ok: false, code: 'BAD_REQUEST' };

    const result = await cloudRequest('get', query, { retry: 1 });
    if (result.status !== 'success') {
        return { ok: false, code: result.code || 'NETWORK', message: result.message || '' };
    }
    return { ok: true, account: result.account || {} };
}

/* ================= 寫入：註冊 / 更新 / 佇列 ================= */

function cloudPushPayload(account) {
    const payload = {};
    CLOUD_PUSH_FIELDS.forEach(key => {
        if (account[key] !== undefined) payload[key] = account[key];
    });
    return payload;
}

/** 記錄「這個版本已同步到雲端」 */
function cloudMarkSynced(account, cloudUpdatedAt) {
    cloudEnsureLoaded();
    if (!account || !account.id) return;

    cloudState[account.id] = {
        updatedAt: Number(account.updatedAt) || 0,
        cloudUpdatedAt: Number(cloudUpdatedAt) || Number(account.updatedAt) || 0
    };
    cloudPersistState();
    cloudPersistLastSync();
}

function cloudMarkSent(account) {
    cloudEnsureLoaded();
    if (!account || !account.id) return;
    cloudState[account.id] = Object.assign({}, cloudState[account.id], {
        updatedAt: Number(account.updatedAt) || 0
    });
    cloudPersistState();
}

/* ---------- 佇列 ---------- */

function cloudEnqueueUpsert(id) {
    cloudEnsureLoaded();
    if (!id) return;

    cloudQueue = cloudQueue.filter(job => !(job.id === id && job.action === 'upsert'));
    cloudQueue.push({ action: 'upsert', id: id, at: Date.now() });
    cloudPersistQueue();
    cloudSetPhase(navigator && navigator.onLine === false ? 'offline' : 'pending');
}

function cloudEnqueueDelete(id) {
    cloudEnsureLoaded();
    if (!id) return;

    cloudQueue = cloudQueue.filter(job => job.id !== id);
    cloudQueue.push({ action: 'delete', id: id, at: Date.now() });
    cloudPersistQueue();
    cloudSetPhase(navigator && navigator.onLine === false ? 'offline' : 'pending');
}

function cloudResolveAccount(id) {
    if (typeof authGetAccounts !== 'function') return null;
    const list = authGetAccounts() || [];
    return list.find(item => item && item.id === id) || null;
}

/**
 * 註冊帳號到雲端（同步等待，因為需要即時知道 Email 是否已被使用）。
 * 連線失敗 → 改為排入佇列，本機繼續運作（離線優先）。
 */
async function cloudRegisterAccount(account) {
    if (!cloudEnabled()) return { ok: true, skipped: true };

    // 註冊同樣係互動式操作，套用同一份總預算，避免按鈕長時間卡在「建立中…」
    const deadline = cloudMakeDeadline(CLOUD_INTERACTIVE_BUDGET_MS);
    const result = await cloudRequest('register', { account: cloudPushPayload(account) }, { retry: 1, deadline: deadline });

    if (result.status === 'success') {
        cloudMarkSynced(account, Number(result.account && result.account.updatedAt) || 0);
        return { ok: true, account: result.account };
    }

    // 業務層錯誤（Email 重複）要即刻告訴用戶，唔可以樂觀放行
    if (result.code === 'EMAIL_EXISTS' || result.code === 'ID_EXISTS') {
        return { ok: false, code: result.code, message: result.message, fatal: true };
    }

    // 網絡問題 → 樂觀接受，稍後補送
    cloudEnqueueUpsert(account.id);
    return { ok: true, queued: true, message: result.message };
}

/**
 * 更新帳號（更換班級、頭像等）。
 * 預設非阻塞：本機已寫好就立即回傳，雲端在背景推送。
 */
async function cloudUpdateAccount(account, opts) {
    if (!cloudEnabled()) return { ok: true, skipped: true };

    const options = opts || {};
    const result = await cloudRequest('update', {
        id: account.id,
        patch: cloudPushPayload(account)
    }, { retry: options.retry });

    if (result.status === 'success') {
        cloudMarkSynced(account, Number(result.account && result.account.updatedAt) || 0);
        return { ok: true };
    }

    if (result.code === 'NO_ACCOUNT') {
        // 雲端冇呢一筆（例如舊裝置建立但從未同步）→ 改用 upsert 補上
        return cloudRegisterAccount(account);
    }

    cloudEnqueueUpsert(account.id);
    return { ok: false, queued: true, message: result.message };
}

/** 刪除雲端帳號（目前只有開發者面板會用到） */
async function cloudDeleteAccount(id) {
    if (!cloudEnabled()) return { ok: true, skipped: true };

    const result = await cloudRequest('delete', { id: id }, { retry: 1 });
    if (result.status === 'success' || result.code === 'NO_ACCOUNT') {
        cloudEnsureLoaded();
        delete cloudState[id];
        cloudPersistState();
        cloudQueue = cloudQueue.filter(job => job.id !== id);
        cloudPersistQueue();
        return { ok: true };
    }

    cloudEnqueueDelete(id);
    return { ok: false, queued: true, message: result.message };
}

/**
 * 掃描本機帳號，把「本地版本未推送過」的排入佇列。
 * 判斷依據係 account.updatedAt（任何改動都會更新它）。
 * 只用於 upsert —— 刪除雲端帳號必須由用戶明確觸發，
 * 唔可以因為「本機清單冇咗」就當作用戶想刪雲端資料。
 */
function cloudScanLocalChanges() {
    cloudEnsureLoaded();
    if (!cloudEnabled()) return [];

    const accounts = (typeof authGetAccounts === 'function') ? (authGetAccounts() || []) : [];
    const dirty = [];

    accounts.forEach(account => {
        if (!account || !account.id) return;
        const synced = cloudState[account.id];
        if (!synced || Number(synced.updatedAt) !== Number(account.updatedAt)) {
            cloudEnqueueUpsert(account.id);
            dirty.push(account.id);
        }
    });

    return dirty;
}

/* ================= 推送排程（防抖 + 併發去重） ================= */

/** 任何本機寫入之後呼叫：排程一次非阻塞推送 */
function cloudSchedulePush(delayMs) {
    if (!cloudEnabled() || typeof window === 'undefined') return;

    if (cloudPushTimer) clearTimeout(cloudPushTimer);
    cloudPushTimer = setTimeout(() => {
        cloudPushTimer = null;
        cloudFlush().catch(() => { /* 已入佇列，下次啟動／上線再試 */ });
    }, Number.isFinite(delayMs) ? delayMs : 400);
}

/**
 * 把佇列一次過補送到雲端。
 * 同一時間只會有一個 flush 在跑（多次呼叫會共用同一個 Promise）。
 */
function cloudFlush() {
    if (cloudFlushPromise) return cloudFlushPromise;

    cloudFlushPromise = (async () => {
        if (!cloudEnabled()) return { ok: true, skipped: true };

        cloudEnsureLoaded();
        cloudScanLocalChanges();

        if (!cloudQueue.length) {
            cloudSetPhase('idle');
            return { ok: true, applied: 0 };
        }

        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            cloudSetPhase('offline');
            return { ok: false, offline: true };
        }

        cloudSetPhase('syncing');

        const jobs = cloudQueue.slice();
        const upserts = [];
        const deletes = [];
        const deleteIds = {};

        jobs.forEach(job => {
            if (job.action === 'delete') {
                deleteIds[job.id] = true;
                deletes.push(job.id);
            }
        });

        jobs.forEach(job => {
            if (job.action !== 'upsert' || deleteIds[job.id]) return;
            const account = cloudResolveAccount(job.id);
            if (account) upserts.push(account);
        });

        let applied = 0;
        let failed = false;
        let lastMessage = '';

        if (upserts.length) {
            const payloads = upserts.map(cloudPushPayload);
            const result = await cloudRequest('bulkUpsert', { accounts: payloads }, {
                timeoutMs: 20000,
                retry: 1
            });

            if (result.status === 'success') {
                upserts.forEach(account => cloudMarkSent(account));
                applied += upserts.length;
            } else {
                failed = true;
                lastMessage = result.message || '';
            }
        }

        for (let i = 0; i < deletes.length; i += 1) {
            const result = await cloudRequest('delete', { id: deletes[i] }, { retry: 0 });
            if (result.status === 'success' || result.code === 'NO_ACCOUNT') {
                cloudEnsureLoaded();
                delete cloudState[deletes[i]];
                cloudPersistState();
                applied += 1;
            } else {
                failed = true;
                lastMessage = result.message || lastMessage;
            }
        }

        if (failed) {
            cloudSetPhase('error', lastMessage);
            return { ok: false, applied: applied, message: lastMessage };
        }

        cloudQueue = [];
        cloudPersistQueue();
        cloudLastSyncAt = Date.now();
        cloudPersistLastSync();
        cloudSetPhase('idle');
        return { ok: true, applied: applied };
    })().finally(() => {
        cloudFlushPromise = null;
    });

    return cloudFlushPromise;
}

/* ================= 背景校驗（雲端 → 本機） ================= */

/**
 * 用雲端版本更新本機帳號。
 * 只有「雲端比本機新」才覆寫，避免覆蓋用戶剛剛在離線時的改動。
 * @returns {Promise<boolean>} 本機是否有更新
 */
async function cloudMergeAccount(account) {
    if (!account || !account.id) return false;
    if (typeof authGetAccounts !== 'function') return false;

    const local = cloudResolveAccount(account.id);
    if (!local) return false;

    cloudEnsureLoaded();
    const synced = cloudState[account.id] || {};
    const cloudUpdatedAt = Number(account.updatedAt) || 0;
    const knownCloud = Number(synced.cloudUpdatedAt) || 0;

    // 雲端沒有更新過 → 唔需要做任何事
    if (cloudUpdatedAt && knownCloud && cloudUpdatedAt <= knownCloud) return false;

    // 本機有未推送的改動 → 以本機為準（雲端稍後會被覆蓋）
    const localDirty = !synced.updatedAt || Number(synced.updatedAt) !== Number(local.updatedAt);
    if (localDirty) return false;

    let changed = false;
    // 只合併「用戶資料」欄位；密碼欄位雲端唔會回傳，所以本機的登入能力不受影響
    ['name', 'email', 'provider', 'avatar', 'classId', 'className',
     'schedulePath', 'customClass'].forEach(key => {
        if (account[key] === undefined) return;
        const next = key === 'customClass' ? !!account[key] : account[key];
        if (local[key] !== next) {
            local[key] = next;
            changed = true;
        }
    });

    if (!changed) {
        cloudState[account.id] = Object.assign({}, synced, { cloudUpdatedAt: cloudUpdatedAt });
        cloudPersistState();
        return false;
    }

    local.updatedAt = Number(local.updatedAt) || Date.now();
    cloudState[account.id] = {
        updatedAt: Number(local.updatedAt),
        cloudUpdatedAt: cloudUpdatedAt
    };
    cloudPersistState();

    if (typeof authPersistAccounts === 'function') authPersistAccounts({ silent: true });
    return true;
}

/* ================= 啟動流程 ================= */

/**
 * App 啟動時的雲端入口。刻意設計成「永遠唔會 throw、唔會阻塞首屏」：
 *   ① 先把離線期間累積的寫入補送（有網才做）
 *   ② 再背景校驗目前登入帳號
 * 由 main.js 在 Splash 之後以非阻塞方式呼叫。
 */
async function cloudBootstrap(account) {
    if (!cloudEnabled()) return { ok: true, skipped: true };

    cloudEnsureLoaded();
    cloudScanLocalChanges();

    const result = { ok: true, pushed: 0, pulled: false };

    try {
        const flush = await cloudFlush();
        if (flush && flush.applied) result.pushed = flush.applied;
    } catch (e) {
        result.ok = false;
    }

    if (account && account.id) {
        try {
            const remote = await cloudFetchAccount(account.id, account.email);
            if (remote.ok) result.pulled = await cloudMergeAccount(remote.account);
        } catch (e) { /* 背景校驗失敗唔影響任何功能 */ }
    }

    return result;
}

/** 手動同步（個人中心點擊狀態標籤時呼叫） */
async function cloudSyncNow(account) {
    if (!cloudEnabled()) return { ok: false, code: 'DISABLED' };
    return cloudBootstrap(account);
}

/** 清除這部裝置的雲端狀態與佇列（登出／重置用，唔會刪雲端資料） */
function cloudResetLocal() {
    cloudState = {};
    cloudQueue = [];
    cloudLastSyncAt = 0;
    cloudPhase = 'idle';
    cloudLastError = '';
    Storage.remove(CLOUD_STATE_KEY);
    Storage.remove(CLOUD_QUEUE_KEY);
    Storage.remove(CLOUD_LAST_SYNC_KEY);
    cloudSetPhase('idle');
}

/* ================= 上線自動補送 ================= */

if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
        if (!cloudEnabled()) return;
        cloudSetPhase('pending');
        cloudFlush().catch(() => {});
    });

    window.addEventListener('offline', () => {
        if (!cloudEnabled()) return;
        cloudSetPhase('offline');
    });
}
