// ============================================================
// 雲端同步層：Supabase（Auth + PostgreSQL / PostgREST）
// ------------------------------------------------------------
// ⚠ 舊版為 Google Sheets（via Google Apps Script），已徹底移除：
//   GAS Web App 網址等同「萬能鑰匙」，任何拿到網址的人都可以讀寫全部帳號，
//   而且每次請求 0.5~1.5 秒、無並發保護，多裝置同時寫入會互相覆蓋。
//
// 傳輸方式：官方 CDN SDK（Auth）＋ 原生 fetch（PostgREST）
//   本 App 係「離線優先」PWA，service-worker.js 會 precache 所有本機資源，
//   斷網都開得著。所以 supabase-js 由 CDN 載入時**只可以**係選用層而唔可以係
//   必要依賴 —— 否則 CDN 掛掉或首次離線開 App 就會拖死整個帳號層。
//
//   分工如下（刻意如此，唔係兩套重複實作）：
//     · Auth 端點（登入／註冊／續期）→ 優先走 SDK
//         supabase.auth.signInWithPassword({...}) → POST /auth/v1/token?grant_type=password
//         supabase.auth.signUp({...})             → POST /auth/v1/signup
//         supabase.auth.refreshSession({...})     → POST /auth/v1/token?grant_type=refresh_token
//       原因：SDK 會回傳穩定的 error.code（invalid_credentials、email_not_confirmed、
//       user_already_exists、weak_password…），比自行用正則猜 message 可靠得多，
//       而呢三條路徑正是最需要準確報錯、最唔可以出錯的地方。
//     · PostgREST 資料端點 → 維持原生 fetch 的 sbRequest()
//         supabase.from('profiles').select('*')   → GET   /rest/v1/profiles?select=*
//         supabase.from('profiles').upsert([...]) → POST  /rest/v1/profiles
//         supabase.from('profiles').update({...}) → PATCH /rest/v1/profiles?id=eq.<id>
//       原因：本層已圍繞 fetch 建立了 upsert 合併、離線佇列、整體逾時預算
//       （deadline）等自訂行為，改用 SDK 只會多一層轉接而無實質好處。
//
//   ⚠ 每個 SDK 分支都有原生 fetch 後備，SDK 唔可用時行為與舊版完全一致。
//
// 讀寫策略（與 auth.js 的「本機優先」一致）：
//   · 讀取 ＝ 本機優先：啟動／登入先讀 localStorage（零網絡、秒開），
//            雲端只做背景校驗，成功就靜默覆蓋本機。
//   · 寫入 ＝ 本機即時寫入 + 雲端背景補送：離線時排入佇列，恢復連線自動補送。
//   · 併發保護：版本比對只用「本機 updatedAt > 已同步的 updatedAt」，
//            雲端時間戳由伺服器寫入（見 supabase/schema.sql 的 trigger），
//            避免裝置時鐘不準造成誤判。
//
// 對外介面（cloud* 函式）刻意保持與舊版完全相同，
// 因此 auth.js / main.js / profile.js 唔需要改寫呼叫方式。
// ============================================================

// 本機快取鍵（沿用舊鍵名，令已存在的雲端狀態紀錄可以無痛沿用）
const CLOUD_STATE_KEY = 'appdb_v1_cloud_state';
const CLOUD_QUEUE_KEY = 'appdb_v1_cloud_queue';
const CLOUD_LAST_SYNC_KEY = 'appdb_v1_cloud_last_sync';

// Supabase Session（access token 用於 REST，refresh token 用於續期）
const SB_SESSION_KEY = 'appdb_v1_sb_session';

// 互動式操作（登入／註冊）的整體逾時，避免使用者乾等
const _SB_INTERACTIVE_BUDGET_MS = 15000;

// 需要推送到 profiles 的欄位（⚠ 不含 id／時間戳／任何 sb* 憑證欄位）
const SB_PUSH_FIELDS = ['name', 'email', 'provider', 'classId', 'className', 'schedulePath', 'customClass', 'avatar'];

let cloudPhase = 'idle';
let cloudLastError = '';
let cloudLastSyncAt = 0;
let cloudReady = false;
let cloudPushTimer = null;
let cloudFlushPromise = null;
let cloudState = {};
let cloudQueue = [];

// Supabase session 記憶體副本（延遲載入，避免 Storage 未就緒時出錯）
let sbSession = null;
let sbSessionLoaded = false;

const cloudListeners = [];

// ============================================================
// 基礎工具
// ============================================================

function cloudSleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function cloudAbortableFetch(url, options, timeoutMs) {
    if (typeof AbortController !== 'function') return fetch(url, options);
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    const init = Object.assign({}, options, { signal: controller.signal });
    return fetch(url, init).then(function (response) {
        clearTimeout(timer);
        return response;
    }, function (error) {
        clearTimeout(timer);
        throw error;
    });
}

function cloudMakeDeadline(budgetMs) {
    return Date.now() + (Number(budgetMs) || _SB_INTERACTIVE_BUDGET_MS);
}

function cloudConfig() {
    const config = (typeof window !== 'undefined' && window.APP_AUTH_CONFIG) ? window.APP_AUTH_CONFIG : {};
    const sb = config.supabase || {};
    return {
        enabled: sb.enabled !== false,
        url: String(sb.url || '').trim().replace(/\/+$/, ''),
        anonKey: String(sb.anonKey || '').trim(),
        table: String(sb.table || 'profiles').trim() || 'profiles',
        timeoutMs: Number(sb.timeoutMs) || 12000,
        retry: sb.retry,
        refreshSkewMs: Number(sb.refreshSkewMs) || 60000
    };
}

function cloudRequestRetries() {
    const retry = cloudConfig().retry;
    return Number.isFinite(retry) && retry >= 0 ? retry : 2;
}

// 佔位字串／明顯未填完的 key 一律視為「未設定」，退回純本機模式
const SB_KEY_PLACEHOLDER_RE = /_REPLACE_WITH_FULL_KEY|^YOUR_|^sb_publishable_\.\.\.$/;

function cloudConfigured() {
    const config = cloudConfig();
    if (!config.url || !config.anonKey) return false;
    if (!/^https:\/\/[^\s]+/i.test(config.url)) return false;
    if (SB_KEY_PLACEHOLDER_RE.test(config.anonKey)) return false;
    if (config.anonKey.length < 30) return false;
    return true;
}

/** 雲端同步是否可用（未填 url/anonKey 時自動退回純本機模式） */
function cloudEnabled() {
    return cloudConfig().enabled && cloudConfigured();
}

/** 處理「連唔到線」類錯誤碼：呼叫者據此決定樂觀接受或直接失敗 */
function cloudIsOfflineCode(code) {
    return code === 'NETWORK' || code === 'TIMEOUT' || code === 'BAD_JSON';
}

// ============================================================
// Supabase 官方 CDN SDK（Auth 用的強化層，選用）
// ------------------------------------------------------------
// index.html 已在 <head> 用 defer 載入 @supabase/supabase-js 的 UMD 版。
// defer 會在本檔（body 內的普通 script）之後才執行，故此處**不可以**在檔案
// 頂層就建立用戶端，一律改成「第一次真的要呼叫時才惰性建立」。
// ============================================================

let _sbSdk = null;

// 本次 SDK 呼叫可用的毫秒預算，由 sbSdkFetch() 落實成 AbortController 逾時。
// ⚠ 用「呼叫前設定、完成後還原」而唔係單向寫入：sbRefreshSession() 有可能
//    在 REST 路徑中被嵌套呼叫（例如登入後的背景同步），還原才唔會互相污染。
let _sbSdkBudgetMs = 0;

/**
 * 取得 Supabase SDK 用戶端；SDK 不可用（CDN 被封、未載入、設定未填）時回 null。
 * ⚠ 唔快取「失敗」結果：只在成功建立後才快取，令 CDN 遲到都可以自動補上。
 */
function sbSdkClient() {
    if (_sbSdk) return _sbSdk;
    const lib = (typeof window !== 'undefined') ? window.supabase : null;
    if (!lib || typeof lib.createClient !== 'function') return null;
    if (!cloudConfigured()) return null;

    const config = cloudConfig();
    try {
        _sbSdk = lib.createClient(config.url, config.anonKey, {
            auth: {
                // ⚠ 三個都必須關掉。本 App 支援「同一部裝置多個帳號」，
                //    續期權杖係按帳號存放（appdb_v1_sb_session 及帳號物件的
                //    sbRefreshToken）。若交由 SDK 管理 session，SDK 會用
                //    sb-<ref>-auth-token 這條固定 key 覆寫，切換帳號時就會互相蓋掉。
                persistSession: false,
                autoRefreshToken: false,
                detectSessionInUrl: false
            },
            // 所有請求都經本層的逾時包裝，維持既有 deadline 行為
            global: { fetch: sbSdkFetch }
        });
    } catch (error) {
        _sbSdk = null;
    }
    return _sbSdk;
}

/** 供 SDK 使用的 fetch：套用本層既有的一次性逾時機制 */
function sbSdkFetch(url, init) {
    const budget = _sbSdkBudgetMs > 0 ? _sbSdkBudgetMs : cloudConfig().timeoutMs;
    return cloudAbortableFetch(url, init, budget);
}

/**
 * 在設好逾時預算的情況下執行一次 SDK 呼叫。
 * @returns {Promise<null|object>} SDK 不可用時回 null（呼叫者據此走原生 fetch 後備）
 */
async function sbSdkCall(deadline, fn) {
    const client = sbSdkClient();
    if (!client) return null;

    const config = cloudConfig();
    const previousBudget = _sbSdkBudgetMs;
    // 用整體預算（deadline）同單次逾時兩者中較小者，避免連續請求疊加超時
    _sbSdkBudgetMs = deadline
        ? Math.max(1, Math.min(config.timeoutMs, deadline - Date.now()))
        : config.timeoutMs;

    try {
        return await fn(client);
    } finally {
        _sbSdkBudgetMs = previousBudget;
    }
}

/**
 * SDK 的 AuthError → 本層既有錯誤碼。
 * ⚠ 一律回傳 { ok:false, code, message } 這個 sbRequest() 的形狀，
 *   令上層（cloudSignIn / auth.js / profile.js）完全唔需要知道底層換了傳輸方式。
 */
function sbSdkError(error) {
    const raw = error || {};
    const status = Number(raw.status) || 0;
    const code = String(raw.code || '');
    const message = String(raw.message || raw.error_description || '');

    // ⚠ 逾時判斷要排在 status === 0 之前：
    //   supabase-js 會把 fetch 的 AbortError 包成 AuthRetryableFetchError（status 0），
    //   若先判 status 就一律變成 NETWORK，分唔清「斷網」同「伺服器好慢」。
    if (raw.name === 'AbortError' || /abort|timed? ?out/i.test(message)) {
        return { ok: false, code: 'TIMEOUT', message: '雲端連線逾時' };
    }
    // status 0 ＝ 連 fetch 都未成功（斷網／被網絡政策封鎖）
    if (status === 0) return { ok: false, code: 'NETWORK', message: '無法連線到雲端' };

    const map = {
        invalid_credentials: 'BAD_PASSWORD',
        email_not_confirmed: 'NO_CONFIRM',
        user_already_exists: 'EMAIL_EXISTS',
        email_exists: 'EMAIL_EXISTS',
        weak_password: 'WEAK_PASSWORD',
        over_email_send_rate_limit: 'RATE_LIMIT',
        over_request_rate_limit: 'RATE_LIMIT',
        user_not_found: 'NO_ACCOUNT',
        session_not_found: 'UNAUTHORIZED',
        refresh_token_not_found: 'UNAUTHORIZED',
        refresh_token_already_used: 'UNAUTHORIZED'
    };
    if (map[code]) return { ok: false, code: map[code], status: status, message: message };

    // 後備：部分專案／舊版本 SDK 唔會提供 code，只靠 message
    const lower = message.toLowerCase();
    if (/invalid login credentials|invalid password/.test(lower)) {
        return { ok: false, code: 'BAD_PASSWORD', status: status, message: message };
    }
    if (/email not confirmed|not confirmed/.test(lower)) {
        return { ok: false, code: 'NO_CONFIRM', status: status, message: message };
    }
    if (/already registered|already exists/.test(lower)) {
        return { ok: false, code: 'EMAIL_EXISTS', status: status, message: message };
    }
    if (/rate limit|too many/.test(lower)) {
        return { ok: false, code: 'RATE_LIMIT', status: status, message: message };
    }
    if (/weak password|password should be/.test(lower)) {
        return { ok: false, code: 'WEAK_PASSWORD', status: status, message: message };
    }

    if (status === 401 || status === 403) {
        return { ok: false, code: 'UNAUTHORIZED', status: status, message: message };
    }
    return {
        ok: false,
        code: status ? ('HTTP_' + status) : 'NETWORK',
        status: status,
        message: message || '雲端操作失敗'
    };
}

/**
 * 把 SDK 的一次 Auth 呼叫結果正規化成 sbRequest() 的形狀。
 * @param {object} response SDK 回傳的 { data, error }
 * @param {boolean} sessionOnly true ＝ 只接受 session（登入／續期），
 *                              false ＝ 同時接受只有 user 的情況（註冊待確認）
 */
function sbSdkResult(response, sessionOnly) {
    const res = response || {};
    if (res.error) return sbSdkError(res.error);

    const data = res.data || {};
    if (data.session && data.session.access_token) return { ok: true, data: data.session };

    // 專案開啟了「Confirm email」時，註冊只會回傳 user（無 session）。
    // 補上 { id, user } 這個形狀，令呼叫者可以取得 pendingConfirmation 的 userId。
    if (!sessionOnly && data.user) return { ok: true, data: { id: data.user.id, user: data.user } };

    return { ok: false, code: 'BAD_JSON', message: '雲端回應不完整' };
}

// ============================================================
// 最底層：Supabase REST 請求
// ============================================================

function sbApiUrl(path) {
    return cloudConfig().url + path;
}

/** 把 PostgREST / GoTrue 的錯誤回應轉成穩定的錯誤碼 */
function sbErrorFromResponse(response, data) {
    const raw = data || {};
    const text = String(raw.message || raw.msg || raw.error_description || raw.error || '').trim();
    const lower = text.toLowerCase();
    let code = 'HTTP_' + response.status;

    if (response.status === 401 || response.status === 403) code = 'UNAUTHORIZED';
    if (response.status === 429) code = 'RATE_LIMIT';

    if (/invalid login credentials|invalid_grant/.test(lower)) code = 'BAD_PASSWORD';
    else if (/email not confirmed/.test(lower)) code = 'NO_CONFIRM';
    else if (/already registered|already exists|user_already_exists|email_exists/.test(lower)) code = 'EMAIL_EXISTS';
    else if (/rate limit|too many|over_email_send_rate_limit/.test(lower)) code = 'RATE_LIMIT';
    else if (/weak password|password should be|password is too short/.test(lower)) code = 'WEAK_PASSWORD';
    else if (/user not found|no rows/.test(lower)) code = 'NO_ACCOUNT';

    return { code: code, status: response.status, message: text || ('HTTP ' + response.status) };
}

/**
 * 送出一個 Supabase REST 請求。
 * @param {string} path   例如 '/rest/v1/profiles?id=eq.xxx'
 * @param {object} options fetch 選項（method / headers）
 * @param {object} opts   { auth:'anon'|'user', body, timeoutMs, retry, deadline }
 * @returns {Promise<{ok:boolean, status?:number, data?:*, code?:string, message?:string}>}
 */
async function sbRequest(path, options, opts) {
    if (!cloudEnabled()) return { ok: false, code: 'DISABLED', message: '雲端同步未啟用' };

    const config = cloudConfig();
    const o = opts || {};
    const timeoutMs = Number(o.timeoutMs) || config.timeoutMs;
    const maxRetry = Number.isFinite(o.retry) ? o.retry : cloudRequestRetries();
    const deadline = Number(o.deadline) || 0;

    // 資料庫請求要帶使用者 JWT（RLS 靠它判斷 auth.uid()）；
    // 註冊／登入／續期則用 anon key。
    let bearer = config.anonKey;
    if (o.auth === 'user') {
        const token = await sbAccessToken();
        if (!token) return { ok: false, code: 'NO_SESSION', message: '尚未登入雲端帳號' };
        bearer = token;
    }

    const headers = Object.assign({
        apikey: config.anonKey,
        Authorization: 'Bearer ' + bearer,
        'Content-Type': 'application/json'
    }, o.headers || {});

    const init = Object.assign({}, options || {}, { headers: headers });
    if (o.body !== undefined) init.body = JSON.stringify(o.body);

    let lastError = null;

    for (let attempt = 0; attempt <= maxRetry; attempt += 1) {
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
            const response = await cloudAbortableFetch(sbApiUrl(path), init, budget);
            if (response.status === 204) return { ok: true, status: 204, data: null };

            const text = await response.text();
            let data = null;
            let parsed = true;
            if (text) {
                try {
                    data = JSON.parse(text);
                } catch (parseError) {
                    parsed = false;
                    lastError = response.ok
                        ? { code: 'BAD_JSON', message: '無法解析雲端回應' }
                        : { code: 'HTTP_' + response.status, status: response.status, message: 'HTTP ' + response.status };
                }
            }

            if (parsed) {
                if (response.ok) return { ok: true, status: response.status, data: data };
                lastError = sbErrorFromResponse(response, data);
            }
        } catch (error) {
            const aborted = !!(error && error.name === 'AbortError');
            lastError = {
                code: aborted ? 'TIMEOUT' : 'NETWORK',
                message: aborted ? ('雲端無回應（' + budget + 'ms 逾時）') : String((error && error.message) || error)
            };
        }

        if (attempt < maxRetry) {
            if (deadline && deadline - Date.now() <= 0) break;
            await cloudSleep(600 * (attempt + 1));
        }
    }

    return {
        ok: false,
        status: lastError && lastError.status,
        code: (lastError && lastError.code) || 'NETWORK',
        message: (lastError && lastError.message) || '雲端連線失敗'
    };
}

/** 把錯誤碼轉成可直接顯示的中文訊息 */
function sbAuthMessage(result) {
    const code = result && result.code;
    const map = {
        BAD_PASSWORD: '密碼不正確，請重新輸入',
        NO_CONFIRM: '這個 Email 尚未完成驗證，請先到信箱點擊確認連結',
        EMAIL_EXISTS: '這個 Email 已經註冊過了，請直接登入',
        RATE_LIMIT: '嘗試次數過多，請稍後再試',
        WEAK_PASSWORD: '密碼強度不足，請改用更長的密碼',
        NO_ACCOUNT: '找不到這個帳號',
        UNAUTHORIZED: '登入狀態已失效，請重新登入',
        NO_SESSION: '尚未登入雲端帳號',
        NETWORK: '無法連線到雲端，已切換至離線模式',
        TIMEOUT: '雲端連線逾時，已切換至離線模式',
        DISABLED: '雲端同步未啟用'
    };
    return map[code] || (result && result.message) || '雲端操作失敗';
}

// ============================================================
// Supabase Session（訪問權杖 + 續期權杖）
// ============================================================

function sbSessionLoad() {
    if (sbSessionLoaded) return;
    sbSessionLoaded = true;
    try {
        const raw = Storage.get(SB_SESSION_KEY, null);
        sbSession = (raw && typeof raw === 'object' && raw.refreshToken) ? raw : null;
    } catch (error) {
        sbSession = null;
    }
}

function sbSessionPersist() {
    try {
        if (sbSession) Storage.set(SB_SESSION_KEY, sbSession);
        else Storage.remove(SB_SESSION_KEY);
    } catch (error) {
        // Storage 不可用時（私密模式）只保留在記憶體
    }
}

function sbSessionClear() {
    sbSessionLoaded = true;
    sbSession = null;
    sbSessionPersist();
}

/** 目前是否有可用的雲端身分（未過期或可續期） */
function sbHasSession() {
    sbSessionLoad();
    return !!(sbSession && sbSession.refreshToken);
}

function sbCurrentUserId() {
    sbSessionLoad();
    return sbSession ? String(sbSession.userId || '') : '';
}

/** 把 Supabase Auth 回應中的 session 收下並持久化 */
function sbApplyAuthSession(payload) {
    if (!payload || !payload.access_token) return null;
    const expiresIn = Number(payload.expires_in) || 3600;
    const user = payload.user || {};
    sbSession = {
        userId: String(user.id || (sbSession && sbSession.userId) || ''),
        email: String(user.email || (sbSession && sbSession.email) || ''),
        accessToken: String(payload.access_token),
        refreshToken: String(payload.refresh_token || (sbSession && sbSession.refreshToken) || ''),
        expiresAt: Date.now() + Math.max(30, expiresIn) * 1000
    };
    sbSessionLoaded = true;
    sbSessionPersist();
    return sbSession;
}

/** 用續期權杖換新的訪問權杖；失敗（被撤銷／過期）就清掉 session */
async function sbRefreshSession(refreshToken, opts) {
    if (!refreshToken) return null;
    const options = opts || {};

    // ① SDK 路徑（有 error.code，可準確分辨「被撤銷」同「純斷網」）
    let result = await sbSdkCall(Number(options.deadline) || 0, function (client) {
        return client.auth.refreshSession({ refresh_token: String(refreshToken) })
            .then(function (response) { return sbSdkResult(response, true); })
            .catch(function (error) { return sbSdkError(error); });
    });

    // ② 後備：SDK 不可用（CDN 被封／首頁離線）→ 行為與舊版完全一致
    if (!result) {
        result = await sbRequest('/auth/v1/token?grant_type=refresh_token', {
            method: 'POST',
            body: { refresh_token: String(refreshToken) }
        }, Object.assign({ retry: 1 }, options));
    }

    if (!result.ok || !result.data) {
        // 只有「明確被拒絕」才清 session；純網絡問題要保留，等下次再試
        if (!cloudIsOfflineCode(result.code)) sbSessionClear();
        return null;
    }
    return sbApplyAuthSession(result.data);
}

/** 取得可用的訪問權杖（快過期就自動續期） */
async function sbAccessToken() {
    sbSessionLoad();
    if (!sbSession || !sbSession.accessToken) return null;
    const skew = cloudConfig().refreshSkewMs;
    if (sbSession.expiresAt - skew > Date.now()) return sbSession.accessToken;
    const refreshed = await sbRefreshSession(sbSession.refreshToken, { retry: 1 });
    return refreshed ? refreshed.accessToken : null;
}

/**
 * 確保「目前 session」屬於指定帳號。
 * 多帳號切換時，記憶體中的 session 可能仍屬上一個帳號，
 * 這裡會用該帳號自己儲存的續期權杖換一個新 session（唔需要再打密碼）。
 */
async function sbEnsureAccountSession(account) {
    const targetId = account && account.id ? String(account.id) : '';
    sbSessionLoad();

    if (sbSession && sbSession.accessToken && (!targetId || String(sbSession.userId || '') === targetId)) {
        if (await sbAccessToken()) return true;
    }

    const token = account && account.sbRefreshToken ? String(account.sbRefreshToken) : '';
    if (!token) return false;
    const session = await sbRefreshSession(token, { retry: 1 });
    return !!(session && session.accessToken);
}

// ============================================================
// profiles 資料表 ↔ 帳號物件 的欄位對應
// ============================================================

function sbToMillis(value) {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'number') return value;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
}

// ============================================================
// 輸入淨化（雲端邊界唯一出入口）
// ------------------------------------------------------------
// 為什麼要在「推送 Supabase 之前」再做一次淨化：
//   本 App 係「本機優先」，值有可能經由 Console、舊版本殘留資料、
//   或匯入的備份進入本機紀錄。這些值一推上雲端，就會跨裝置回流到
//   每一部裝置（包括其他版本的前端）。
//   所以喺唯一嘅雲端出入口做一次正規化，最省成本亦最難繞過。
//
// ⚠ 這**不是**防 SQL 注入 —— PostgREST 全程使用參數化查詢，
//   把值當成資料而非 SQL 語法，注入本身唔存在。
//   真正要擋嘅係三件事：
//     ① 超長字串撐爆資料列、拖慢同步（配合同步限制）
//     ② 控制字元（尤其 \u0000）會令 PostgreSQL 直接拒絕整筆寫入
//     ③ avatar 被塞入 javascript: / data:text/html / 帶引號嘅字串 ——
//        它會被 profile.js 組進 innerHTML 的 <img src="…">，
//        呢個才係真正嘅 XSS 入口（見下方 sbCleanAvatar）
//
// ⚠ 刻意唔喺呢度做 HTML 轉義：轉義屬於「輸出」階段（escapeHtml）。
//   喺寫入階段轉義會永久污染儲存值（真名 "A&B" 會存成 "A&amp;B"），
//   之後任何非 HTML 用途（例如匯出）都會拿到錯誤資料。
// ============================================================

/**
 * 各欄位長度上限（字元）。
 * ⚠ 必須與 supabase/schema.sql 的 profiles_field_guard CHECK 約束一致，
 *   否則會出現「前端話送得出、伺服器話唔收」嘅落差。
 */
const SB_FIELD_LIMITS = {
    name: 50,
    email: 254,
    provider: 20,
    class_id: 64,
    class_name: 60,
    schedule_path: 200,
    // 頭像經 profile.js 壓成 320px JPEG，dataURL 通常 20–40KB，這裡留大量餘裕
    avatar: 400000
};

/** 前端欄位名 → 資料庫欄位名（只保留真正需要推送嘅欄位） */
const SB_COLUMN_BY_FIELD = {
    name: 'name',
    email: 'email',
    provider: 'provider',
    classId: 'class_id',
    className: 'class_name',
    schedulePath: 'schedule_path',
    customClass: 'custom_class',
    avatar: 'avatar'
};

/**
 * 正規化單一字串欄位：剝除控制字元、去頭尾空白、截斷至上限。
 * @param {*} value      原始值（任何型別都會被安全地轉成字串）
 * @param {number} limit 長度上限（字元）
 * @returns {string}
 */
function sbCleanText(value, limit) {
    let text = String(value === null || value === undefined ? '' : value);
    // C0 控制字元（保留 \t \n \r 之外的全部）＋ C1 控制字元。
    // \u0000 是 PostgreSQL text 型別不接受的位元組，不清掉會令寫入整筆失敗。
    text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
    text = text.trim();
    if (limit && text.length > limit) text = text.slice(0, limit);
    return text;
}

/**
 * 頭像欄位的 scheme 白名單。
 * 只接受兩種來源，其餘一律回空字串（UI 會退回「姓名首字母」SVG）：
 *   ① data:image/…;base64,…  —— profileFileToDataURL 壓縮後的標準結果
 *   ② https://…              —— 未來的圖片網址
 *
 * ⚠ 為什麼唔可以直接放行：profile.js 會用
 *     btn.innerHTML = '<img src="' + profileAvatarSrc(account) + '" …>'
 *   直接把頭像字串接進 HTML 屬性。若放任寫入 `"><script>…` 或
 *   `javascript:…`，就等於一個可經同步派發到所有裝置的 XSS 載荷。
 *   白名單（而非黑名單）係唯一可靠嘅做法。
 */
function sbCleanAvatar(value) {
    const raw = String(value === null || value === undefined ? '' : value).trim();
    if (!raw || raw.length > SB_FIELD_LIMITS.avatar) return '';

    // ① Base64 圖片（前端壓縮後的正常路徑）
    if (/^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(raw)) return raw;

    // ② 前端「姓名首字母」備援 SVG。
    //    ⚠ encodeURIComponent 唔會轉義單引號（' 屬於其保留字元集），
    //      所以規則只可以禁止 < > " 三個真正危險嘅字元 ——
    //      單引號在雙引號屬性內是純文字，加上 < 被封死就無法引入標籤。
    if (/^data:image\/svg\+xml,[^<>"]+$/.test(raw)) return raw;

    // ③ 圖片網址：只准 https，且唔可以有引號／角括號／空白
    if (/^https:\/\/[^\s"'<>]+$/.test(raw)) return raw;

    return '';
}

/**
 * 依資料庫欄位名淨化單一值。
 * 型別轉換集中在這裡，避免每個呼叫點各寫一次而出現不一致。
 */
function sbCleanField(column, value) {
    if (column === 'custom_class') return !!value;
    if (column === 'avatar') return sbCleanAvatar(value);
    if (column === 'email') return sbCleanText(value, SB_FIELD_LIMITS.email).toLowerCase();
    return sbCleanText(value, SB_FIELD_LIMITS[column]);
}

/**
 * 資料庫列 → 前端帳號物件（欄位名轉 camelCase）。
 * ⚠ 讀取時同樣淨化：資料庫裡的舊資料、或由其他（可能被改過的）用戶端
 *   寫入的值，都唔應該當成可信。
 */
function sbFromRow(row) {
    if (!row) return null;
    return {
        id: String(row.id || ''),
        name: sbCleanField('name', row.name),
        email: sbCleanField('email', row.email),
        provider: sbCleanText(row.provider, SB_FIELD_LIMITS.provider) || 'email',
        classId: sbCleanField('class_id', row.class_id),
        className: sbCleanField('class_name', row.class_name),
        schedulePath: sbCleanField('schedule_path', row.schedule_path),
        customClass: !!row.custom_class,
        avatar: sbCleanAvatar(row.avatar),
        createdAt: sbToMillis(row.created_at),
        lastLoginAt: sbToMillis(row.last_login_at),
        updatedAt: sbToMillis(row.updated_at)
    };
}

/**
 * 前端帳號物件 → 資料庫列（所有值都經過淨化）。
 * ⚠ 刻意唔送 created_at／last_login_at／updated_at：
 *   updated_at 由伺服器 trigger 寫入（避免裝置時鐘不準），
 *   created_at 由伺服器 default now() 寫入（避免每次推送覆蓋加入日期）。
 *   last_login_at 只經 sbTouchLastLogin 由伺服器時間寫入。
 * ⚠ 亦唔會送任何 sb* 憑證欄位（續期權杖只留在本機）。
 */
function sbToRow(account) {
    const row = {};
    if (!account || !account.id) return row;
    row.id = String(account.id);
    SB_PUSH_FIELDS.forEach(function (field) {
        if (account[field] === undefined) return;
        const column = SB_COLUMN_BY_FIELD[field];
        if (!column) return;
        row[column] = sbCleanField(column, account[field]);
    });
    return row;
}

function sbIdFilter(id) {
    return 'id=eq.' + encodeURIComponent(String(id));
}

/** 批次 upsert（merge-duplicates ＝ 有則更新、無則新增） */
async function sbUpsertProfiles(accounts, opts) {
    const config = cloudConfig();
    const rows = (accounts || []).map(sbToRow).filter(function (row) { return !!row.id; });
    if (!rows.length) return { ok: true, rows: [] };

    const result = await sbRequest('/rest/v1/' + config.table, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: rows
    }, Object.assign({ auth: 'user', timeoutMs: 20000, retry: 1 }, opts || {}));

    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    return { ok: true, rows: Array.isArray(result.data) ? result.data : [] };
}

/** 讀取單一帳號的雲端資料（列不存在時回 ok:false / NO_ACCOUNT） */
async function sbSelectProfile(id) {
    const config = cloudConfig();
    const result = await sbRequest('/rest/v1/' + config.table + '?' + sbIdFilter(id) + '&select=*', {
        method: 'GET'
    }, { auth: 'user', retry: 1 });

    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    if (!Array.isArray(result.data) || !result.data.length) return { ok: false, code: 'NO_ACCOUNT', message: '雲端沒有這筆資料' };
    return { ok: true, account: sbFromRow(result.data[0]) };
}

/** 刪除單一帳號的雲端資料（注意：無法刪除 auth.users，見 cloudDeleteAccount） */
async function sbDeleteProfile(id) {
    const config = cloudConfig();
    const result = await sbRequest('/rest/v1/' + config.table + '?' + sbIdFilter(id), {
        method: 'DELETE'
    }, { auth: 'user', retry: 1 });
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    return { ok: true };
}

/** 背景更新最後登入時間（失敗唔影響登入流程） */
function sbTouchLastLogin(id) {
    if (!id) return;
    const config = cloudConfig();
    sbRequest('/rest/v1/' + config.table + '?' + sbIdFilter(id), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: { last_login_at: new Date().toISOString() }
    }, { auth: 'user', retry: 0 }).catch(function () { /* 非關鍵欄位，失敗即略過 */ });
}

// ============================================================
// 每帳號憑證（支援免密碼切換帳號）
// ------------------------------------------------------------
// Supabase Auth 一個瀏覽器只會持有「一個 session」，但本 App 允許
// 一部裝置存多個帳號並即時切換。做法：把每個帳號自己的續期權杖
// 存在該帳號的本機紀錄裡（只在本機，永不推送雲端），
// 切換時用它換一張新的訪問權杖，唔需要重新輸入密碼。
// ============================================================

function sbRememberCredential(accountId, session) {
    if (!accountId || !session) return;
    const account = cloudResolveAccount(accountId);
    if (!account) return;
    account.sbUserId = String(session.userId || account.sbUserId || '');
    account.sbRefreshToken = String(session.refreshToken || account.sbRefreshToken || '');
    if (typeof authPersistAccounts === 'function') authPersistAccounts({ silent: true });
}

function sbForgetCredential(accountId) {
    const account = cloudResolveAccount(accountId);
    if (!account) return;
    delete account.sbUserId;
    delete account.sbRefreshToken;
    if (typeof authPersistAccounts === 'function') authPersistAccounts({ silent: true });
}

// ============================================================
// 本機雲端狀態／待送佇列
// ============================================================

function cloudEnsureLoaded() {
    if (cloudReady) return;
    cloudReady = true;
    try {
        const state = Storage.get(CLOUD_STATE_KEY, null);
        cloudState = (state && typeof state === 'object') ? state : {};
    } catch (error) {
        cloudState = {};
    }
    try {
        const queue = Storage.get(CLOUD_QUEUE_KEY, null);
        cloudQueue = Array.isArray(queue) ? queue : [];
    } catch (error) {
        cloudQueue = [];
    }
    try {
        cloudLastSyncAt = Number(Storage.get(CLOUD_LAST_SYNC_KEY, 0)) || 0;
    } catch (error) {
        cloudLastSyncAt = 0;
    }
}

function cloudPersistState() {
    try { Storage.set(CLOUD_STATE_KEY, cloudState); } catch (error) { /* 略過 */ }
}

function cloudPersistQueue() {
    try { Storage.set(CLOUD_QUEUE_KEY, cloudQueue); } catch (error) { /* 略過 */ }
}

function cloudNow() {
    return Date.now();
}

/** 依 id 取本機帳號 */
function cloudResolveAccount(id) {
    if (typeof authGetAccounts !== 'function') return null;
    const accounts = authGetAccounts() || [];
    for (let i = 0; i < accounts.length; i += 1) {
        if (String(accounts[i].id) === String(id)) return accounts[i];
    }
    return null;
}

function cloudSetPhase(phase, error) {
    const next = phase || 'idle';
    const nextError = String(error || '');
    if (cloudPhase === next && cloudLastError === nextError) return;
    cloudPhase = next;
    cloudLastError = nextError;
    cloudListeners.slice().forEach(function (listener) {
        try { listener(cloudStatus()); } catch (e) { /* 監聽器自身的錯不影響雲端流程 */ }
    });
}

function cloudSubscribe(listener) {
    if (typeof listener !== 'function') return function () {};
    cloudListeners.push(listener);
    return function () {
        const index = cloudListeners.indexOf(listener);
        if (index >= 0) cloudListeners.splice(index, 1);
    };
}

function cloudStatus() {
    cloudEnsureLoaded();
    const pending = cloudDirtyCount();
    let label = '已同步';
    let tone = 'ok';

    if (!cloudConfig().enabled) { label = '未開啟'; tone = 'muted'; }
    else if (!cloudConfigured()) { label = '未設定'; tone = 'muted'; }
    else if (typeof navigator !== 'undefined' && navigator.onLine === false) { label = '離線模式'; tone = 'pending'; }
    else if (!sbHasSession()) { label = '待登入雲端'; tone = 'pending'; }
    else if (cloudPhase === 'syncing') { label = '同步中…'; tone = 'pending'; }
    else if (cloudPhase === 'error') { label = '同步失敗'; tone = 'error'; }
    else if (pending > 0) { label = '待同步 ' + pending; tone = 'pending'; }
    else if (cloudPhase === 'offline') { label = '離線模式'; tone = 'pending'; }

    return {
        enabled: cloudEnabled(),
        phase: cloudPhase,
        label: label,
        tone: tone,
        pending: pending,
        lastError: cloudLastError,
        lastSyncAt: cloudLastSyncAt
    };
}

/** 待處理筆數（包含佇列內尚未送出的操作） */
function cloudPendingCount() {
    cloudEnsureLoaded();
    return cloudDirtyCount();
}

/** 尚未推送到雲端的筆數（比對本機 updatedAt 與最後成功推送的版本） */
function cloudDirtyCount() {
    cloudEnsureLoaded();
    const ids = {};
    let count = 0;
    const accounts = (typeof authGetAccounts === 'function') ? (authGetAccounts() || []) : [];
    accounts.forEach(function (account) {
        const image = cloudState[account.id];
        const known = image && image.updatedAt ? Number(image.updatedAt) : 0;
        if (Number(account.updatedAt || 0) > known) { ids[account.id] = true; count += 1; }
    });
    cloudQueue.forEach(function (job) {
        if (job && job.id && !ids[job.id]) { ids[job.id] = true; count += 1; }
    });
    return count;
}

// ============================================================
// 佇列
// ============================================================

/** 佇列內同 id 的操作會被取代（例如連續改班級，只需留最後一次） */
function cloudEnqueueUpsert(id) {
    cloudEnsureLoaded();
    if (!id) return;
    cloudQueue = cloudQueue.filter(function (job) { return !(job && job.action === 'upsert' && String(job.id) === String(id)); });
    cloudQueue.push({ action: 'upsert', id: String(id), at: cloudNow() });
    cloudPersistQueue();
}

function cloudRemoveQueueFor(id) {
    cloudEnsureLoaded();
    const key = String(id);
    const next = cloudQueue.filter(function (job) { return !(job && String(job.id) === key); });
    if (next.length !== cloudQueue.length) {
        cloudQueue = next;
        cloudPersistQueue();
    }
}

/** 已成功同步 → 記下「最後同步成功時的版本」 */
function cloudMarkSynced(account, cloudUpdatedAt) {
    if (!account || !account.id) return;
    cloudEnsureLoaded();
    const previous = cloudState[account.id] || {};
    cloudState[account.id] = {
        updatedAt: Number(account.updatedAt || 0),
        cloudUpdatedAt: cloudUpdatedAt ? sbToMillis(cloudUpdatedAt) : Number(previous.cloudUpdatedAt || 0)
    };
    cloudPersistState();
}

/** 以伺服器回傳的最新版本為準（含伺服器寫入的 updated_at） */
function cloudMarkSent(account) {
    if (!account || !account.id) return;
    cloudEnsureLoaded();
    cloudState[account.id] = {
        updatedAt: Number(account.updatedAt || 0),
        cloudUpdatedAt: Number(account.updatedAt || 0)
    };
    cloudPersistState();
}

/** 把雲端版本較新的資料合併回本機（唔覆蓋本機較新的版本） */
function cloudMergeAccount(account) {
    if (!account || !account.id) return false;
    const local = cloudResolveAccount(account.id);
    if (!local) return false;

    const remoteUpdatedAt = Number(account.updatedAt || 0);
    const localUpdatedAt = Number(local.updatedAt || 0);
    if (remoteUpdatedAt <= localUpdatedAt) {
        cloudMarkSynced(local, account.updatedAt);
        return false;
    }

    const fields = ['name', 'email', 'provider', 'classId', 'className', 'schedulePath', 'customClass', 'avatar'];
    fields.forEach(function (field) {
        if (account[field] === undefined) return;
        local[field] = account[field];
    });
    // ⚠ 唔可以覆蓋本機憑證：雲端唔會回傳 sbRefreshToken，
    //   亦唔可以因為合併而令使用者要重新登入。
    local.updatedAt = remoteUpdatedAt;
    if (account.lastLoginAt) local.lastLoginAt = account.lastLoginAt;
    if (typeof authPersistAccounts === 'function') authPersistAccounts({ silent: true });
    cloudMarkSynced(local, account.updatedAt);
    return true;
}

// ============================================================
// 帳號：登入 / 註冊 / 讀取 / 更新 / 刪除
// ============================================================

/** 連線檢查：打 Supabase Auth 的健康端點（唔需要登入） */
async function cloudPing() {
    if (!cloudEnabled()) return { ok: false, skipped: true };
    const result = await sbRequest('/auth/v1/health', { method: 'GET' }, { retry: 0, timeoutMs: 6000 });
    return { ok: result.ok, code: result.code, message: result.message, data: result.data };
}

/** 讀取自己的 profiles（含 RLS 權限檢查） */
async function cloudLoadProfile(userId, email) {
    const base = { id: String(userId || ''), email: String(email || '').trim().toLowerCase() };
    if (!base.id) return { ok: false, code: 'BAD_REQUEST' };

    const result = await sbSelectProfile(base.id);
    if (result.ok) return { ok: true, account: result.account };

    if (result.code === 'NO_ACCOUNT') {
        // 帳號存在但 profiles 尚未建立（例如未執行 schema.sql 的 trigger）
        // → 用最基本資料頂住，稍後 upsert 會自動補上
        console.warn('[cloud] profiles 尚未建立，稍後會自動補寫：', base.id);
        return { ok: true, account: null, missing: true };
    }
    return { ok: false, code: result.code, message: result.message };
}

/**
 * 登入：改用 Supabase Auth 驗證密碼。
 * 成功後把帳號資料（含存取權杖）交回 auth.js 寫入本機快取。
 */
async function cloudSignIn(email, password) {
    if (!cloudEnabled()) return { ok: false, code: 'DISABLED', offline: false, message: '雲端同步未啟用' };

    const normalizedEmail = String(email || '').trim().toLowerCase();
    const secret = String(password == null ? '' : password);
    const deadline = cloudMakeDeadline();

    // ① SDK 路徑：error.code 為 invalid_credentials / email_not_confirmed 等，
    //    唔需要再靠正則猜 message，登入報錯準確度最高
    let result = await sbSdkCall(deadline, function (client) {
        return client.auth.signInWithPassword({ email: normalizedEmail, password: secret })
            .then(function (response) { return sbSdkResult(response, true); })
            .catch(function (error) { return sbSdkError(error); });
    });

    // ② 後備：SDK 不可用 → 原生 fetch，行為同舊版一致
    if (!result) {
        result = await sbRequest('/auth/v1/token?grant_type=password', {
            method: 'POST',
            body: { email: normalizedEmail, password: secret }
        }, { retry: 1, deadline: deadline });
    }

    if (!result.ok) {
        return {
            ok: false,
            code: result.code,
            offline: cloudIsOfflineCode(result.code),
            message: sbAuthMessage(result)
        };
    }

    const session = sbApplyAuthSession(result.data);
    if (!session) {
        return { ok: false, code: 'BAD_JSON', offline: true, message: '雲端回應不完整，請稍後再試' };
    }

    const profile = await cloudLoadProfile(session.userId, normalizedEmail);
    let account;
    if (profile.ok && profile.account) {
        account = profile.account;
    } else if (profile.ok && profile.missing) {
        // profiles 缺列：先以本機既有資料（同 Email）為底，稍後補寫
        account = (typeof authFindByEmail === 'function' ? authFindByEmail(normalizedEmail) : null)
            || { id: session.userId, email: normalizedEmail, name: '', provider: 'email', classId: '', className: '', schedulePath: '', customClass: false, avatar: '' };
    } else {
        return { ok: false, code: profile.code, offline: cloudIsOfflineCode(profile.code), message: profile.message };
    }

    const normalized = typeof authNormalizeAccount === 'function' ? authNormalizeAccount(account) : account;
    normalized.id = session.userId;
    normalized.email = normalizedEmail || normalized.email;
    normalized.lastLoginAt = Date.now();

    // ⚠ 這兩個是本機限定的憑證欄位，雲端沒有、亦永遠唔會推送上去
    normalized.sbUserId = session.userId;
    normalized.sbRefreshToken = session.refreshToken;

    cloudMarkSynced(normalized, normalized.updatedAt);
    sbTouchLastLogin(session.userId);

    return { ok: true, account: normalized };
}

/**
 * 註冊：改用 Supabase Auth 建立帳號（密碼由伺服器 bcrypt 儲存）。
 * ⚠ 需要傳入明文密碼（第 2 個參數）。前端唔再計算任何雜湊值。
 * ⚠ 離線時唔可以註冊：Supabase Auth 無法離線建立帳號，
 *   若照樣寫入本機只會產生一個永遠登入唔到、又同步唔到嘅幽靈帳號。
 */
async function cloudRegisterAccount(account, password) {
    if (!cloudEnabled()) return { ok: true, skipped: true };

    const email = String((account && account.email) || '').trim().toLowerCase();
    const secret = String(password == null ? '' : password);
    if (!email || !secret) {
        return { ok: false, code: 'BAD_REQUEST', fatal: true, message: '缺少 Email 或密碼' };
    }

    const deadline = cloudMakeDeadline();
    const metadata = { name: String((account && account.name) || ''), provider: 'email' };

    // ① SDK 路徑（error.code 為 user_already_exists / weak_password 等）
    let result = await sbSdkCall(deadline, function (client) {
        return client.auth.signUp({ email: email, password: secret, options: { data: metadata } })
            .then(function (response) { return sbSdkResult(response, false); })
            .catch(function (error) { return sbSdkError(error); });
    });

    // ② 後備：SDK 不可用 → 原生 fetch，行為同舊版一致
    if (!result) {
        result = await sbRequest('/auth/v1/signup', {
            method: 'POST',
            body: { email: email, password: secret, data: metadata }
        }, { retry: 1, deadline: deadline });
    }

    if (!result.ok) {
        if (result.code === 'EMAIL_EXISTS') {
            return { ok: false, code: 'EMAIL_EXISTS', fatal: true, message: '這個 Email 已經註冊過，請直接登入' };
        }
        if (result.code === 'WEAK_PASSWORD' || result.code === 'RATE_LIMIT') {
            return { ok: false, code: result.code, fatal: true, message: sbAuthMessage(result) };
        }
        return {
            ok: false,
            code: result.code,
            fatal: false,
            offline: cloudIsOfflineCode(result.code),
            message: sbAuthMessage(result)
        };
    }

    const session = sbApplyAuthSession(result.data);
    if (!session) {
        // 專案開啟了「Confirm email」→ 尚未有 session，profiles 由伺服器 trigger 建立
        const payload = result.data || {};
        const pendingId = String(payload.id || (payload.user && payload.user.id) || '');
        return { ok: true, pendingConfirmation: true, userId: pendingId };
    }

    const remote = typeof authNormalizeAccount === 'function'
        ? authNormalizeAccount(Object.assign({}, account, { id: session.userId }))
        : Object.assign({}, account, { id: session.userId });
    remote.id = session.userId;

    const saved = await sbUpsertProfiles([remote]);
    if (!saved.ok) {
        // 帳號已建立但 profile 未寫入 → 排入佇列，登入後自動補送
        cloudEnqueueUpsert(session.userId);
        cloudSetPhase('error', saved.message);
        return {
            ok: true,
            account: remote,
            queued: true,
            message: saved.message
        };
    }

    const row = saved.rows && saved.rows[0];
    if (row) {
        const merged = sbFromRow(row);
        ['name', 'email', 'provider', 'classId', 'className', 'schedulePath', 'customClass', 'avatar'].forEach(function (field) {
            if (merged[field] !== undefined) remote[field] = merged[field];
        });
    }
    remote.sbUserId = session.userId;
    remote.sbRefreshToken = session.refreshToken;
    cloudMarkSynced(remote, remote.updatedAt);
    cloudSetPhase('idle');
    return { ok: true, account: remote };
}

/**
 * 更新帳號資料：本機即時生效，雲端背景推送。
 * 離線或未有 session 時自動排入佇列，恢復連線後補送。
 */
async function cloudUpdateAccount(account, opts) {
    if (!cloudEnabled() || !account || !account.id) return { ok: true, skipped: true };

    const options = opts || {};
    if (!options.synchronous) {
        cloudEnqueueUpsert(account.id);
        cloudSchedulePush(0);
        return { ok: true, queued: true };
    }

    if (!sbHasSession()) {
        cloudEnqueueUpsert(account.id);
        cloudSetPhase('offline', '等待登入雲端帳號');
        return { ok: false, queued: true, code: 'NO_SESSION', message: '尚未登入雲端帳號' };
    }

    const saved = await sbUpsertProfiles([account]);
    if (!saved.ok) {
        cloudEnqueueUpsert(account.id);
        cloudSetPhase(cloudIsOfflineCode(saved.code) ? 'offline' : 'error', saved.message);
        return { ok: false, queued: true, code: saved.code, message: saved.message };
    }

    cloudRemoveQueueFor(account.id);
    cloudMarkSent(account);
    cloudSetPhase('idle');
    return { ok: true };
}

/**
 * 刪除雲端帳號資料。
 * ⚠ 只會刪 public.profiles 那一列；auth.users 內的登入帳號需要
 *   service_role 權限才刪得掉，前端（Publishable key）刻意不具備，
 *   要徹底刪除請在 Supabase Dashboard → Authentication 手動移除。
 */
async function cloudDeleteAccount(id) {
    if (!cloudEnabled() || !id) return { ok: true, skipped: true };

    cloudRemoveQueueFor(id);
    if (!sbHasSession()) {
        cloudSetPhase('offline', '等待登入雲端帳號');
        return { ok: false, queued: true, code: 'NO_SESSION', message: '尚未登入雲端帳號' };
    }

    const result = await sbDeleteProfile(id);
    if (!result.ok) return { ok: false, code: result.code, message: result.message };

    cloudEnsureLoaded();
    delete cloudState[id];
    cloudPersistState();
    return { ok: true };
}

/** 讀取單一帳號（第 2 個參數保留給舊介面，改用 auth uid 查詢） */
async function cloudFetchAccount(id) {
    if (!cloudEnabled() || !id) return { ok: false, skipped: true };
    if (!sbHasSession()) return { ok: false, code: 'NO_SESSION', message: '尚未登入雲端帳號' };

    const result = await sbSelectProfile(id);
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    return { ok: true, account: result.account };
}

/** 切換帳號後，用該帳號自己的續期權杖恢復雲端身分（唔需要再輸入密碼） */
async function cloudActivateAccount(accountId) {
    if (!cloudEnabled()) return { ok: false, code: 'DISABLED' };
    const account = cloudResolveAccount(accountId);
    if (!account) return { ok: false, code: 'NO_ACCOUNT' };

    const ready = await sbEnsureAccountSession(account);
    if (!ready) {
        cloudSetPhase('offline', '這個帳號需要重新登入雲端');
        return { ok: false, code: 'NO_SESSION', message: '這個帳號需要重新登入雲端' };
    }
    cloudSetPhase('idle');
    cloudSchedulePush(0);
    return { ok: true };
}

/**
 * 登出：撤銷目前的 Supabase session（本機帳號快取與其他帳號憑證保留）
 * ⚠ 刻意繼續用原生 fetch 而唔用 SDK 的 signOut()：
 *   本檔的 SDK 用戶端係 persistSession:false 且從不 setSession（見 sbSdkClient），
 *   所以 client.auth.signOut() 根本冇帶使用者權杖，伺服器唔會撤銷該 refresh token，
 *   只會變成「本機自以為登出」。這裡直接帶 Bearer 打 /auth/v1/logout 才真正撤銷。
 * （同理：cloudPing() 的 /auth/v1/health、改密碼／改 Email 的 setSession 前置流程
 *   亦維持原生 fetch，因為 SDK 需要先 setSession 才做得，反而多一層狀態。）
 */
async function cloudSignOut() {
    sbSessionLoad();
    if (cloudEnabled() && sbSession && sbSession.accessToken) {
        try {
            await sbRequest('/auth/v1/logout', { method: 'POST' }, { auth: 'user', retry: 0, timeoutMs: 5000 });
        } catch (error) {
            // 撤銷失敗（例如離線）唔應該阻擋使用者登出
        }
    }
    sbSessionClear();
}

// ============================================================
// 變更密碼 / 變更 Email（一律交由 Supabase Auth 處理）
// ============================================================

/** 用「目前密碼」重新驗證身分（等同重新登入一次，會刷新本機 session） */
async function cloudVerifyPassword(email, password) {
    if (!cloudEnabled()) return { ok: false, code: 'DISABLED', message: '雲端同步未啟用' };

    const result = await sbRequest('/auth/v1/token?grant_type=password', {
        method: 'POST',
        body: {
            email: String(email || '').trim().toLowerCase(),
            password: String(password == null ? '' : password)
        }
    }, { retry: 0, deadline: cloudMakeDeadline() });

    if (!result.ok) {
        return {
            ok: false,
            code: result.code,
            offline: cloudIsOfflineCode(result.code),
            message: sbAuthMessage(result)
        };
    }

    const session = sbApplyAuthSession(result.data);
    if (session) sbRememberCredential(session.userId, session);
    return { ok: true };
}

/**
 * 變更密碼。
 * ⚠ 前端唔再計算雜湊：直接叫 Supabase Auth 換掉密碼（伺服器 bcrypt 儲存）。
 * ⚠ 變更前必須先通過「目前密碼」驗證，否則等於任何人拿到裝置就可以改密碼。
 */
async function cloudUpdatePassword(email, currentPassword, newPassword) {
    if (!cloudEnabled()) return { ok: false, code: 'DISABLED', message: '雲端同步未啟用' };

    const verified = await cloudVerifyPassword(email, currentPassword);
    if (!verified.ok) return { ok: false, code: verified.code, message: verified.message, offline: !!verified.offline };

    const result = await sbRequest('/auth/v1/user', {
        method: 'PUT',
        body: { password: String(newPassword == null ? '' : newPassword) }
    }, { auth: 'user', retry: 1, deadline: cloudMakeDeadline() });

    if (!result.ok) return { ok: false, code: result.code, message: sbAuthMessage(result) };

    // 有些設定下改密碼會簽發新權杖；有就一併更新，冇就沿用（續期時自然會換）
    if (result.data) sbApplyAuthSession(result.data);
    return { ok: true };
}

/**
 * 變更 Email。
 * ⚠ Supabase 預設會寄「確認連結」到新信箱，確認前 auth.users 內的 Email 唔會改；
 *   這時我們唔會改動本機帳號的 Email，避免本機與雲端不一致。
 *   若專案關閉了 email confirmation，則會即時生效（applied = true）。
 */
async function cloudUpdateUserEmail(newEmail) {
    if (!cloudEnabled()) return { ok: false, code: 'DISABLED', message: '雲端同步未啟用' };

    const email = String(newEmail || '').trim().toLowerCase();
    if (!email) return { ok: false, code: 'BAD_REQUEST', message: '請輸入新的 Email' };

    const result = await sbRequest('/auth/v1/user', {
        method: 'PUT',
        body: { email: email }
    }, { auth: 'user', retry: 1, deadline: cloudMakeDeadline() });

    if (!result.ok) return { ok: false, code: result.code, message: sbAuthMessage(result) };

    const user = result.data || {};
    const applied = !!user.email && String(user.email).trim().toLowerCase() === email;
    return { ok: true, applied: applied, pendingConfirmation: !applied, email: email };
}

/** 目前 session 對應的帳號 id（雲端身分） */
function cloudSessionAccountId() {
    return sbCurrentUserId();
}

// ============================================================
// 同步排程 / 推送 / 拉取
// ============================================================

/** 掃描本機與最後同步版本的差異 → 產生待推送項目 */
function cloudScanLocalChanges() {
    cloudEnsureLoaded();
    const accounts = (typeof authGetAccounts === 'function') ? (authGetAccounts() || []) : [];
    accounts.forEach(function (account) {
        const image = cloudState[account.id];
        const known = image && image.updatedAt ? Number(image.updatedAt) : 0;
        if (Number(account.updatedAt || 0) > known) cloudEnqueueUpsert(account.id);
    });
    return cloudPendingCount();
}

function cloudSchedulePush(delay) {
    if (!cloudEnabled()) return;
    cloudEnsureLoaded();
    if (cloudPushTimer) clearTimeout(cloudPushTimer);
    const wait = Number.isFinite(delay) ? Math.max(0, delay) : 2500;
    cloudPushTimer = setTimeout(function () {
        cloudPushTimer = null;
        cloudFlush();
    }, wait);
}

/** 送出佇列內所有待推送項目（同時只會有一個 flush 在跑） */
async function cloudFlush() {
    if (!cloudEnabled()) return;
    if (cloudFlushPromise) return cloudFlushPromise;

    cloudEnsureLoaded();
    cloudScanLocalChanges();
    if (!cloudQueue.length) return;

    if (!sbHasSession()) {
        cloudSetPhase('offline', '等待登入雲端帳號');
        return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        cloudSetPhase('offline', '目前離線');
        return;
    }

    cloudFlushPromise = (async function () {
        cloudSetPhase('syncing');
        const pending = cloudQueue.slice();

        const upsertIds = [];
        const deleteIds = [];
        pending.forEach(function (job) {
            if (!job || !job.id) return;
            if (job.action === 'delete') deleteIds.push(String(job.id));
            else upsertIds.push(String(job.id));
        });

        // 刪除的項目唔應該再被 upsert 蓋回來
        const upsertAccounts = upsertIds
            .filter(function (id) { return deleteIds.indexOf(id) < 0; })
            .map(cloudResolveAccount)
            .filter(function (account) { return !!account; });

        let failure = null;

        if (upsertAccounts.length) {
            const saved = await sbUpsertProfiles(upsertAccounts);
            if (!saved.ok) {
                failure = saved;
            } else {
                const byId = {};
                (saved.rows || []).forEach(function (row) { byId[String(row.id)] = row; });
                upsertAccounts.forEach(function (account) {
                    cloudMarkSent(account);
                    const row = byId[String(account.id)];
                    if (row) {
                        cloudEnsureLoaded();
                        cloudState[account.id] = {
                            updatedAt: Number(account.updatedAt || 0),
                            cloudUpdatedAt: sbToMillis(row.updated_at) || Number(account.updatedAt || 0)
                        };
                        cloudPersistState();
                    }
                });
            }
        }

        if (!failure && deleteIds.length) {
            for (let i = 0; i < deleteIds.length; i += 1) {
                const removed = await sbDeleteProfile(deleteIds[i]);
                if (!removed.ok) { failure = removed; break; }
            }
        }

        if (failure) {
            cloudSetPhase(cloudIsOfflineCode(failure.code) ? 'offline' : 'error', failure.message);
            return;
        }

        // 成功：清掉已完成的佇列項目
        const done = {};
        upsertIds.concat(deleteIds).forEach(function (id) { done[id] = true; });
        cloudQueue = cloudQueue.filter(function (job) { return !(job && done[String(job.id)]); });
        cloudPersistQueue();

        cloudLastSyncAt = cloudNow();
        try { Storage.set(CLOUD_LAST_SYNC_KEY, cloudLastSyncAt); } catch (error) { /* 略過 */ }
        cloudSetPhase('idle');
    })();

    try {
        await cloudFlushPromise;
    } finally {
        cloudFlushPromise = null;
    }
}

/**
 * 啟動／登入後的背景同步：
 *   1. 確保這個帳號有可用的雲端身分（用它的續期權杖換權杖）
 *   2. 推送本機待同步項目
 *   3. 拉取雲端版本，較新就靜默合併回本機
 * 任何失敗都只係記錄狀態，絕對唔會 throw（本機功能不受影響）。
 */
async function cloudBootstrap(account) {
    if (!cloudEnabled()) return { ok: true, skipped: true };
    cloudEnsureLoaded();
    cloudScanLocalChanges();

    if (!account || !account.id) {
        // 尚未登入任何帳號：只做純本機模式
        if (cloudPendingCount() > 0) cloudSetPhase('offline', '等待登入雲端帳號');
        return { ok: false, code: 'NO_ACCOUNT' };
    }

    const ready = await sbEnsureAccountSession(account);
    if (!ready) {
        cloudSetPhase('offline', '這個帳號需要重新登入雲端');
        return { ok: false, code: 'NO_SESSION' };
    }

    await cloudFlush();

    const pulled = await cloudFetchAccount(account.id);
    if (pulled.ok && pulled.account) {
        const merged = cloudMergeAccount(pulled.account);
        if (merged && typeof renderSchedule === 'function') renderSchedule();
    }
    return { ok: true, merged: cloudPendingCount() };
}

/** 手動「立即同步」（使用者按鈕）：先推後拉，並回報結果 */
async function cloudSyncNow(account) {
    if (!cloudEnabled()) return { ok: false, skipped: true, message: '雲端同步未啟用' };
    cloudEnsureLoaded();
    cloudScanLocalChanges();

    const target = account || (typeof authGetCurrentAccount === 'function' ? authGetCurrentAccount() : null);
    if (!target || !target.id) return { ok: false, code: 'NO_ACCOUNT', message: '請先登入帳號' };

    const ready = await sbEnsureAccountSession(target);
    if (!ready) {
        return { ok: false, code: 'NO_SESSION', message: '這個帳號需要重新登入雲端（請登出後再登入一次）' };
    }

    await cloudFlush();
    if (cloudPendingCount() > 0) {
        return { ok: false, code: cloudPhase === 'offline' ? 'NETWORK' : 'PARTIAL', message: cloudLastError || '部分資料尚未同步' };
    }

    const pulled = await cloudFetchAccount(target.id);
    if (!pulled.ok) return { ok: false, code: pulled.code, message: pulled.message };
    const merged = pulled.account ? cloudMergeAccount(pulled.account) : false;
    if (merged && typeof renderSchedule === 'function') renderSchedule();
    cloudSetPhase('idle');
    return { ok: true, merged: merged };
}

/** 清空本機雲端狀態（唔會刪雲端資料，主要供開發者面板使用） */
function cloudResetLocal() {
    cloudEnsureLoaded();
    cloudQueue = [];
    cloudState = {};
    cloudLastSyncAt = 0;
    cloudPersistQueue();
    cloudPersistState();
    try { Storage.set(CLOUD_LAST_SYNC_KEY, 0); } catch (error) { /* 略過 */ }
    sbSessionClear();
    cloudSetPhase('idle');
    return { ok: true };
}

/**
 * 登出時清除「這部裝置上屬於某個帳號的雲端殘留」。
 *
 * 與 cloudResetLocal() 的分工：
 *   cloudResetLocal()          —— 清空「全部」帳號的本機雲端狀態（裝置重置用）
 *   cloudPurgeAccountData(id)  —— 只清「單一帳號」，唔會誤刪其他帳號的待送佇列
 *
 * 清除範圍：
 *   ① Supabase access / refresh token（appdb_v1_sb_session）
 *   ② 該帳號尚未推送成功的待送佇列 —— 內容可能包含姓名、班級、頭像 Base64
 *   ③ 該帳號的最後同步時間戳（會洩漏使用者的活動時間）
 *
 * ⚠ 刻意「唔清」appdb_v1_<collection> 的課表資料：
 *   嗰個係使用者自己的內容，唔係憑證。強制清除等同「一登出就冇咗課表」，
 *   而且尚未同步的離線編輯會直接消失 —— 嗰個係資料損毀，唔係安全加固。
 *   公用電腦情境請用 authSignOutSecure({ wipeLocalData: true })。
 *
 * @param {string} [accountId] 目標帳號 id；留空 = 清空全部（裝置移交情境）
 * @returns {{ok: boolean, purgedJobs: number}}
 */
function cloudPurgeAccountData(accountId) {
    cloudEnsureLoaded();

    // ① 憑證：唔分帳號一律清（同一時間只會有一個 active session）
    sbSessionClear();

    // ② 待送佇列：只剔除屬於該帳號的項目（job 結構為 { action, id, at }）
    const target = accountId ? String(accountId) : '';
    const before = cloudQueue.length;
    cloudQueue = target
        ? cloudQueue.filter(function (job) { return !job || String(job.id) !== target; })
        : [];
    const purgedJobs = before - cloudQueue.length;
    cloudPersistQueue();

    // ③ 逐帳號同步狀態
    if (target) delete cloudState[target];
    else cloudState = {};
    cloudPersistState();

    // ④ 全域同步時間戳：只有「清空全部」時才重設。
    //    單一帳號登出時重設，會令其他帳號誤以為從未同步而觸發多餘的全量拉取。
    if (!target) {
        cloudLastSyncAt = 0;
        try { Storage.remove(CLOUD_LAST_SYNC_KEY); } catch (error) { /* 略過 */ }
    }

    // ⑤ 記憶體中的階段狀態重設，
    //    避免下一位登入者在進入 App 的瞬間短暫看見上一位的同步進度文字
    cloudSetPhase('idle');

    return { ok: true, purgedJobs: purgedJobs };
}





