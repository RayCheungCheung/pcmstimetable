// ============================================================
// 帳號驗證核心（Real Auth Core）
//  · Email + 密碼註冊 / 登入（WebCrypto SHA-256 + 隨機 salt，永不儲存明碼）
//  · Session 保持（localStorage 長期 / sessionStorage 單次）
//  · 班級清單載入與「班級 → 課表」綁定
// ============================================================

const AUTH_ACCOUNTS_KEY = 'auth_accounts';       // 帳號資料庫
const AUTH_SESSION_KEY = 'auth_session';         // 登入 Session
const AUTH_CLASSES_KEY = 'auth_classes_cache';   // 班級清單快取
const AUTH_FLAG_KEY = 'isLoggedIn';              // 登入旗標（true / false）
const AUTH_EMAIL_KEY = 'userEmail';              // 目前登入 Email
const AUTH_NAME_KEY = 'userName';                // 目前登入顯示名稱
// 裝置層班級偏好：值 = 班級 id（例如 junior2-wang）。
// 課表要跟「這部裝置揀過邊班」走，未登入都用得，所以唔可以只綁在帳號上。
const AUTH_USER_CLASS_KEY = 'user_class';

let authAccounts = [];
let authSession = null;
let authClasses = null;          // { classes:[], defaultClassId, defaultSchedule }
let authSecureContext = true;    // crypto.subtle 是否可用

/* ================= 設定 ================= */

function authConfig() {
    return (typeof window !== 'undefined' && window.APP_AUTH_CONFIG) ? window.APP_AUTH_CONFIG : {};
}

/* ================= 小工具 ================= */

function authRandomHex(bytes) {
    const arr = new Uint8Array(bytes);
    const c = (typeof window !== 'undefined' && window.crypto) ? window.crypto : null;
    if (c && c.getRandomValues) {
        c.getRandomValues(arr);
    } else {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function authNormalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

// 只做寬鬆格式檢查：有 @、有網域、沒有空白
function authValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(authNormalizeEmail(email));
}

/* ================= 密碼雜湊 ================= */

// 回傳 "演算法:雜湊值"。優先用 WebCrypto；file:// 等非安全來源會退回 FNV-1a 變體。
async function authHashPassword(password, salt) {
    const text = salt + '::' + password;

    if (autSecureAvailable()) {
        const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return 'sha256:' + Array.from(new Uint8Array(buf))
            .map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // 退化方案：仍然加鹽，但強度遠低於 SHA-256
    let h1 = 0x811c9dc5;
    let h2 = 0x1000193;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        h1 = (h1 ^ code) >>> 0;
        h1 = Math.imul(h1, 16777619) >>> 0;
        h2 = (h2 + code * (i + 1)) >>> 0;
        h2 = Math.imul(h2 ^ (h2 >>> 15), 2246822519) >>> 0;
    }
    return 'fnv:' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function autSecureAvailable() {
    return !!(window.crypto && window.crypto.subtle && typeof window.crypto.subtle.digest === 'function');
}

async function authVerifyPassword(account, password) {
    if (!account || !account.passwordHash || !account.salt) return false;
    const hash = await authHashPassword(password, account.salt);
    return hash === account.passwordHash;
}

/* ================= 帳號資料庫 ================= */

// 舊版本（只有名字）建立的帳號要補齊欄位，避免升版後整個壞掉
function authNormalizeAccount(raw) {
    const acc = Object.assign({}, raw);
    acc.id = acc.id || ('acc_' + authRandomHex(6));
    acc.name = acc.name || '未命名用戶';
    acc.email = authNormalizeEmail(acc.email);
    acc.provider = acc.provider || (acc.passwordHash ? 'email' : 'local');
    acc.avatar = acc.avatar || '';
    acc.avatarUrl = acc.avatarUrl || '';
    acc.salt = acc.salt || '';
    acc.passwordHash = acc.passwordHash || '';
    acc.classId = acc.classId || '';
    acc.className = acc.className || '';
    acc.schedulePath = acc.schedulePath || '';
    acc.customClass = !!acc.customClass;
    // ⚠ 「裝置層級雙重認證」功能已刪除：twoFactor 欄位唔再使用，亦唔會再被讀取。
    //   舊帳號可能仲帶住呢個旗標，喺正規化時直接刪走，避免留低一個冇人讀嘅狀態
    //   （刪完之後，下一次 authPersistAccounts() 寫檔就會真正同佢講再見）。
    delete acc.twoFactor;
    acc.createdAt = acc.createdAt || acc.joinedAt || Date.now();
    acc.lastLoginAt = acc.lastLoginAt || acc.createdAt;
    acc.joinedAt = acc.joinedAt || acc.createdAt;
    // updatedAt ＝「本機最後改動時間」，係雲端同步判斷「有咩未推送」的唯一依據。
    // ⚠ 任何改動帳號資料的地方都必須 authTouch(account)，
    //   否則雲端會永遠停留在舊版本（靜默不同步，最難查）。
    acc.updatedAt = Number(acc.updatedAt) || acc.createdAt;
    return acc;
}

/** 標記帳號已改動 → 令雲端同步層知道要重新推送 */
function authTouch(account) {
    if (!account) return account;
    account.updatedAt = Date.now();
    return account;
}

function authLoadStore() {
    authSecureContext = autSecureAvailable();

    const list = Storage.get(AUTH_ACCOUNTS_KEY, null);
    if (Array.isArray(list) && list.length) {
        authAccounts = list.map(authNormalizeAccount);
    } else {
        // 第一次升級：把舊版 profile_accounts 的帳號搬過來
        const legacy = Storage.get('profile_accounts', []);
        authAccounts = Array.isArray(legacy) ? legacy.map(authNormalizeAccount) : [];
        if (authAccounts.length) Storage.set(AUTH_ACCOUNTS_KEY, authAccounts);
    }

    const legacyCurrent = Storage.get('profile_current_id', null);
    const session = Storage.get(AUTH_SESSION_KEY, null);
    if (session && session.accountId) {
        authSession = session;
    } else if (legacyCurrent) {
        authSession = { accountId: legacyCurrent, token: authRandomHex(16), expiresAt: 0 };
    } else {
        authSession = null;
    }

    if (authSession && !authFindAccount(authSession.accountId)) authSession = null;
    authPersistSession();
}

/**
 * 把帳號寫入本機（同步、必然成功優先），並排程一次非阻塞的雲端推送。
 * @param {{silent?:boolean}} [options] silent = 只寫本機，唔觸發雲端推送
 *        （用於「由雲端下載」之後的回寫，否則會變成自己推自己）
 */
function authPersistAccounts(options) {
    Storage.set(AUTH_ACCOUNTS_KEY, authAccounts);
    // 同步 DB 記憶體快取，令開發者面板見到嘅永遠係最新版本
    if (typeof DB !== 'undefined' && DB.isLoaded('accounts')) DB.setMemory('accounts', authAccounts);

    // 寫入本機之後才排程上雲：用戶唔會等網絡，失敗亦唔影響任何操作
    if (!(options && options.silent) && typeof cloudSchedulePush === 'function') {
        cloudSchedulePush();
    }
}

/**
 * 把雲端回傳的帳號併入本機清單（新增或更新）。
 * 雲端回應可能已遮蔽密碼欄位（例如 get），所以空字串唔可以覆蓋本機已有的雜湊值。
 * @returns {Object|null} 合併後的本機帳號
 */
function authUpsertAccount(remote) {
    if (!remote || !remote.id) return null;

    const normalized = authNormalizeAccount(remote);
    const index = authAccounts.findIndex(item => item && item.id === normalized.id);

    if (index < 0) {
        authAccounts.push(normalized);
        authPersistAccounts({ silent: true });
        return normalized;
    }

    const merged = Object.assign({}, authAccounts[index]);
    Object.keys(normalized).forEach(key => {
        // 雲端遮蔽欄位唔可以清空本機的登入能力
        if ((key === 'salt' || key === 'passwordHash') && !normalized[key]) return;
        merged[key] = normalized[key];
    });

    authAccounts[index] = merged;
    authPersistAccounts({ silent: true });
    return merged;
}

function authPersistSession() {
    if (authSession) {
        // 沒設 expiresAt（0）＝只保留這次瀏覽階段
        if (authSession.expiresAt) Storage.set(AUTH_SESSION_KEY, authSession);
        else {
            Storage.remove(AUTH_SESSION_KEY);
            try { sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(authSession)); } catch (e) { /* ignore */ }
        }
    } else {
        Storage.remove(AUTH_SESSION_KEY);
        try { sessionStorage.removeItem(AUTH_SESSION_KEY); } catch (e) { /* ignore */ }
    }

    authPersistFlags();
}

// 對外可讀的登入狀態旗標（給其他模組／除錯直接查 localStorage）
// isLoggedIn: true / userEmail / userName —— 與 auth_session 同步
function authPersistFlags() {
    const account = authGetCurrentAccount();
    if (account) {
        Storage.set(AUTH_FLAG_KEY, true);
        Storage.set(AUTH_EMAIL_KEY, account.email || '');
        Storage.set(AUTH_NAME_KEY, account.name || '');
    } else {
        Storage.set(AUTH_FLAG_KEY, false);
        Storage.remove(AUTH_EMAIL_KEY);
        Storage.remove(AUTH_NAME_KEY);
    }
}

// 目前是否已登入（供 UI 快速判斷）
function authIsLoggedIn() {
    return !!authGetCurrentAccount();
}

function authGetAccounts() {
    return authAccounts;
}

function authFindAccount(id) {
    return authAccounts.find(a => a.id === id) || null;
}

function authFindByEmail(email) {
    const target = authNormalizeEmail(email);
    if (!target) return null;
    return authAccounts.find(a => authNormalizeEmail(a.email) === target) || null;
}

function authGetCurrentAccount() {
    if (!authSession) return null;
    return authFindAccount(authSession.accountId);
}

function autSessionExpired() {
    if (!authSession) return true;
    if (!authSession.expiresAt) return false;   // 0 = 這個瀏覽階段有效
    return Date.now() > authSession.expiresAt;
}

/**
 * Session 唯讀快照（供 UI 顯示登入狀態用）。
 * ⚠ 刻意唔回傳 token：呢個物件會喺「已連結裝置」頁顯示，token 冇任何理由離開 auth.js。
 * ⚠ expiresAt = 0 代表「只在本次瀏覽階段有效」（未勾選記住我），唔係已過期。
 * @returns {{accountId:string, persistent:boolean, expiresAt:number}|null}
 */
function authSessionInfo() {
    if (!authSession) return null;
    return {
        accountId: authSession.accountId,
        persistent: !!authSession.expiresAt,
        expiresAt: Number(authSession.expiresAt) || 0
    };
}

function authStartSession(account, remember) {
    const days = Number(authConfig().sessionDays) || 30;
    authSession = {
        accountId: account.id,
        token: authRandomHex(16),
        expiresAt: remember ? (Date.now() + days * 86400000) : 0
    };
    account.lastLoginAt = Date.now();
    authPersistAccounts();
    authPersistSession();
}

function authSignOut() {
    authSession = null;
    authPersistSession();
    Storage.remove('profile_current_id');
}

// 切換到本機已有的另一個帳號（裝置層級的帳號切換，不需重新輸入密碼）
function authSwitchAccount(accountId, remember) {
    const account = authFindAccount(accountId);
    if (!account) return { ok: false, error: '找不到這個帳號' };
    authStartSession(account, remember !== false);
    return { ok: true, account: account };
}

/**
 * 從「這部裝置」的帳號清單移除帳號。
 * ⚠ 刻意唔會刪除雲端（Google Sheets）上的紀錄：
 *   呢個動作只係本機清單整理，帳號資料本身應該永續保存。
 *   真正要刪除雲端帳號，請用 cloudDeleteAccount(id)（開發者面板）。
 */
function authRemoveAccount(accountId) {
    const index = authAccounts.findIndex(a => a.id === accountId);
    if (index < 0) return false;

    authAccounts.splice(index, 1);
    authPersistAccounts();

    if (authSession && authSession.accountId === accountId) authSignOut();
    return true;
}

/* ================= 帳號維護（個人中心：登入和安全 / 你的帳號） =================
   以下函式只改動「本機帳號」，與雲端無關：改完之後 authPersistAccounts() 會排程推送，
   雲端同步有開的話會自動補上，沒有開也不影響任何本機功能。 */

/**
 * 變更密碼。必須先通過目前密碼驗證，避免有人拿到未鎖定的裝置就直接改密碼。
 * @param {string} accountId
 * @param {string} currentPassword 目前密碼（用來驗證身份）
 * @param {string} newPassword 新密碼
 * @returns {Promise<{ok:boolean, error?:string, account?:Object}>}
 */
async function authChangePassword(accountId, currentPassword, newPassword) {
    const account = authFindAccount(accountId);
    if (!account) return { ok: false, error: '找不到這個帳號' };
    if (!account.passwordHash || !account.salt) {
        return { ok: false, error: '這個帳號沒有密碼，無法變更' };
    }

    const passed = await authVerifyPassword(account, currentPassword);
    if (!passed) return { ok: false, error: '目前密碼不正確' };

    // 每次改密碼都換一組新的鹽值：舊雜湊值連同舊鹽一併失效
    account.salt = authRandomHex(16);
    account.passwordHash = await authHashPassword(newPassword, account.salt);
    authTouch(account);
    authPersistAccounts();
    return { ok: true, account: account };
}

/**
 * 變更帳號綁定的電郵。同一個電郵不可以同時屬於兩個本機帳號，
 * 否則 authFindByEmail() 會出現不確定的結果。
 */
function authUpdateEmail(accountId, email) {
    const account = authFindAccount(accountId);
    if (!account) return { ok: false, error: '找不到這個帳號' };

    const next = authNormalizeEmail(email);
    if (!authValidEmail(next)) return { ok: false, error: 'Email 格式不正確' };

    const occupied = authAccounts.find(item =>
        item && item.id !== accountId && authNormalizeEmail(item.email) === next);
    if (occupied) return { ok: false, error: '這個 Email 已被另一個帳號使用' };

    account.email = next;
    account.provider = account.passwordHash ? 'email' : account.provider;
    authTouch(account);
    authPersistAccounts();
    authPersistFlags();
    return { ok: true, account: account };
}

/** 變更顯示名稱（用戶名稱），並同步登入旗標中的 userName */
function authUpdateName(accountId, name) {
    const account = authFindAccount(accountId);
    if (!account) return { ok: false, error: '找不到這個帳號' };

    const next = String(name || '').trim();
    if (next.length < 2) return { ok: false, error: '名稱至少需要 2 個字元' };
    if (next.length > 20) return { ok: false, error: '名稱最多 20 個字元' };

    const occupied = authAccounts.find(item =>
        item && item.id !== accountId && String(item.name || '').trim() === next);
    if (occupied) return { ok: false, error: '已有一個帳號使用相同名稱' };

    account.name = next;
    authTouch(account);
    authPersistAccounts();
    authPersistFlags();
    return { ok: true, account: account };
}

/* ⚠ 已刪除 authHasTwoFactor() 與 authSetTwoFactor()：
   隨「裝置層級雙重認證」功能一併移除（唯一呼叫者係 profile.js 嘅
   profileToggleTwoFactor() 同 profileSwitchAccount() 嘅 2FA 閘門，兩者都已刪）。
   authSetTwoFactor() 係唯一會寫入 account.twoFactor 嘅地方，冇咗開關就唔應該留住。 */

/* ================= Email 註冊 / 登入 ================= */

async function authSignUpWithEmail(input) {
    const name = String(input.name || '').trim();
    const email = authNormalizeEmail(input.email);
    const password = String(input.password || '');
    const confirm = String(input.confirm != null ? input.confirm : input.password);

    if (!name) return { ok: false, error: '請輸入你的名字' };
    if (name.length > 20) return { ok: false, error: '名字最多 20 個字' };
    if (!authValidEmail(email)) return { ok: false, error: 'Email 格式不正確' };
    if (password.length < 6) return { ok: false, error: '密碼至少需要 6 個字元' };
    if (password !== confirm) return { ok: false, error: '兩次輸入的密碼不一致' };
    if (authFindByEmail(email)) return { ok: false, error: '這個 Email 已經註冊過了，請直接登入' };

    const salt = authRandomHex(16);
    const passwordHash = await authHashPassword(password, salt);

    const account = authNormalizeAccount({
        id: 'acc_' + authRandomHex(6),
        name: name,
        email: email,
        provider: 'email',
        salt: salt,
        passwordHash: passwordHash,
        avatar: input.avatar || '',
        createdAt: Date.now(),
        lastLoginAt: Date.now()
    });

    // 雲端註冊要「等」：必須即時知道這個 Email 有冇在其他裝置用過，
    // 唔可以樂觀放行（否則會出現同一個 Email 兩份互不相干的帳號）。
    let cloudOffline = false;
    if (typeof cloudRegisterAccount === 'function') {
        const cloud = await cloudRegisterAccount(account);
        if (cloud && !cloud.ok && cloud.fatal) {
            return { ok: false, error: '這個 Email 已經在雲端註冊過了，請直接登入' };
        }
        // 連線失敗 → 已排入佇列，本機照常可用，上線後自動補送
        cloudOffline = !!(cloud && cloud.queued);
    }

    authAccounts.push(account);
    authPersistAccounts();
    authStartSession(account, input.remember !== false);

    return { ok: true, account: account, cloudOffline: cloudOffline };
}

/**
 * Email 登入。讀取策略＝「雲端為真實來源，本機為離線後備」：
 *   ① 雲端同步（有網時）：由 Google Sheets 驗證，成功就一併把最新資料寫回本機快取
 *   ② 離線／雲端查唔到 → 落回本機快取驗證（離線優先，地鐵／校內弱網都用得）
 */
async function authSignInWithEmail(input) {
    const email = authNormalizeEmail(input.email);
    const password = String(input.password || '');

    if (!email) return { ok: false, error: '請輸入 Email' };
    if (!password) return { ok: false, error: '請輸入密碼' };

    let account = authFindByEmail(email);
    const cloudOn = typeof cloudEnabled === 'function' && cloudEnabled();
    let remote = null;

    if (cloudOn) {
        // salt 係明文無妨（它的作用只係令相同密碼產生唔同雜湊）；
        // 明碼密碼永遠唔會離開裝置，送去雲端的只有雜湊值。
        remote = await cloudSignIn(email, password);

        if (remote.ok) {
            const merged = authUpsertAccount(remote.account);
            if (merged) {
                authStartSession(merged, input.remember !== false);
                return { ok: true, account: merged, fromCloud: true };
            }
        }

        // 雲端明確判定密碼錯 → 直接回報，唔可以再落本機（否則改完密碼仍然登入得到）
        if (remote.code === 'BAD_PASSWORD') {
            return { ok: false, error: '密碼錯誤，請重新輸入', reason: 'BAD_PASSWORD' };
        }
        if (remote.code === 'NO_PASSWORD') {
            return { ok: false, error: '這個帳號未設定密碼，請重新註冊', reason: 'NO_PASSWORD' };
        }
        // NO_ACCOUNT / 連線失敗 → 落到本機快取（可能係離線期間建立的帳號）
    }

    if (!account) {
        // 雲端明確話冇呢個帳號，而本機亦冇快取 → 直接引導去註冊
        if (remote && remote.code === 'NO_ACCOUNT') {
            return { ok: false, error: '帳號不存在，請先切換至註冊', reason: 'NO_ACCOUNT' };
        }
        // 逾時／連線失敗，而且本機冇快取 → 講清楚係網絡問題，唔好講成「帳號問題」
        if (remote && remote.offline) {
            return {
                ok: false,
                error: '雲端連線逾時，已切換至離線模式',
                reason: 'TIMEOUT',
                offline: true
            };
        }
        if (cloudOn) {
            return { ok: false, error: '這部裝置沒有這個帳號的快取，而且目前無法連線到雲端，請檢查網絡後再試' };
        }
        return { ok: false, error: '找不到這個 Email 的帳號', reason: 'NO_ACCOUNT' };
    }

    if (!account.passwordHash) {
        return { ok: false, error: '這個帳號是用「' + authProviderLabel(account.provider) + '」建立的，請用同一方式登入' };
    }

    const ok = await authVerifyPassword(account, password);
    if (!ok) {
        // 離線時本機雜湊對不上，未必等於密碼錯（可能雲端改過密碼），唔應該誤導用戶
        if (remote && remote.offline) {
            return {
                ok: false,
                error: '雲端連線逾時，已切換至離線模式，請稍後再試',
                reason: 'TIMEOUT',
                offline: true
            };
        }
        return { ok: false, error: '密碼不正確', reason: 'BAD_PASSWORD' };
    }

    authStartSession(account, input.remember !== false);
    // 用本機快取成功登入，但同時知道雲端今次連唔上 → 通知用戶目前係離線狀態
    return { ok: true, account: account, offlineFallback: !!(remote && remote.offline) };
}

function authProviderLabel(provider) {
    if (provider === 'email') return 'Email';
    // 舊資料相容：舊版本用第三方登入建立的帳號（provider 存的是當時的第三方名稱），
    // 新版本已經冇第三方登入，這些帳號要重新註冊。
    if (provider && provider !== 'local') return '舊版第三方帳號';
    return '本機帳號';
}

/* ================= 班級：清單 / 綁定 / 課表 ================= */

async function authLoadClasses(forceReload) {
    if (authClasses && !forceReload) return authClasses;

    // 班級清單統一由 DataManager 讀取：
    // localStorage（auth_classes_cache，開發者面板改過）→ data/classes.json → 內建備援
    let loaded = null;
    try {
        loaded = await DB.load('classes', { force: !!forceReload });
    } catch (e) {
        console.warn('[auth] 載入班級清單失敗:', e);
    }

    const built = authBuildClassDoc(loaded);
    if (built) {
        authClasses = built;
    } else {
        // 最後防線：清單完全讀唔到時，至少保留一個可選班級，唔會出現空白畫面
        authClasses = {
            classes: [{ id: 'junior2-zheng', name: '初二正', code: 'S2E', stage: '初中', schedule: null }],
            defaultClassId: 'junior2-zheng',
            defaultSchedule: 'data/schedule.json'
        };
    }

    dbRegisterAllSchedules(authClasses);
    return authClasses;
}

function authGetClassList() {
    return authClasses ? authClasses.classes : [];
}

/**
 * 將 DB／開發者面板傳入嘅班級資料正規化成標準文件。
 * 同時接受 { classes: [...] } 與純陣列 [...]；冇有效班級時回傳 null。
 */
function authBuildClassDoc(doc) {
    const list = Array.isArray(doc)
        ? doc
        : ((doc && Array.isArray(doc.classes)) ? doc.classes : []);

    const classes = list
        .filter(cls => cls && cls.id && cls.name)
        .map(cls => ({
            id: String(cls.id),
            name: String(cls.name),
            code: cls.code ? String(cls.code).trim().toUpperCase() : '',
            stage: cls.stage || '初中',
            schedule: cls.schedule || null
        }));

    if (!classes.length) return null;

    return {
        classes: classes,
        defaultClassId: (doc && doc.defaultClassId) || classes[0].id,
        defaultSchedule: (doc && doc.defaultSchedule) || 'data/schedule.json'
    };
}

// 開發者面板直接改動班級清單後，同步更新 auth.js 嘅記憶體狀態
function authSetClasses(doc) {
    const built = authBuildClassDoc(doc);
    if (!built) return authClasses;

    authClasses = built;
    dbRegisterAllSchedules(authClasses);

    // 清單換咗 → 即刻修復帳號上已經失效嘅班級綁定（否則會一直卡在舊班級）
    authRepairAccountClasses();
    return authClasses;
}

function authFindClass(classId) {
    return authGetClassList().find(c => c.id === classId) || null;
}

/**
 * 英文代號 → 中文班名 後備對照表（初二級）。
 * 正式資料源係 classes.json 嘅 code 欄位（開發者面板可改）；
 * 呢張表係保險：即使 JSON 未填 code，輸入 S2A 都仍然認得。
 */
const AUTH_CLASS_CODE_MAP = {
    S2A: '初二信',
    S2B: '初二望',
    S2C: '初二愛',
    S2D: '初二善',
    S2E: '初二正',
    S2F: '初二光'
};

// 比對前先正規化：轉大寫、去掉空格/連字符，令 "s2a"、"S2-A"、"S2 A" 都認得
function authNormalizeCodeKey(value) {
    return String(value == null ? '' : value).trim().toUpperCase().replace(/[\s\-_]/g, '');
}

/**
 * 把使用者輸入解析成班級物件。
 * 支援三種寫法：英文代號（S2A / s2a / S2-A）、班級 id（junior2-xin）、中文班名（初二信）。
 * 回傳 null 代表無法對應 —— 呼叫方應視為「自訂班級」處理。
 */
function authResolveClassInput(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return null;

    const list = authGetClassList();
    const key = authNormalizeCodeKey(text);

    // 1) 直接比對 id / 中文班名 / 資料內的 code
    let hit = list.find(cls => {
        if (String(cls.id) === text) return true;
        if (String(cls.name) === text) return true;
        const code = authNormalizeCodeKey(cls.code);
        return !!code && code === key;
    });
    if (hit) return hit;

    // 2) 後備代號表 → 再用中文班名找回班級
    const mappedName = AUTH_CLASS_CODE_MAP[key];
    if (mappedName) {
        hit = list.find(cls => String(cls.name) === mappedName);
        if (hit) return hit;
    }

    return null;
}

// 取得班級嘅英文代號（優先讀資料，冇填就查對照表）
function authClassCode(cls) {
    if (!cls) return '';
    if (cls.code) return String(cls.code).toUpperCase();
    return Object.keys(AUTH_CLASS_CODE_MAP).find(k => AUTH_CLASS_CODE_MAP[k] === cls.name) || '';
}

// 把班級寫進帳號（含自訂班級）
function authBindClass(accountId, classId, customName) {
    const account = authFindAccount(accountId);
    if (!account) return { ok: false, error: '找不到帳號' };

    let name = '';
    let schedulePath = '';

    if (customName) {
        name = String(customName).trim().slice(0, 20);
        if (!name) return { ok: false, error: '請輸入班級名稱' };
        classId = 'custom:' + name;
        account.customClass = true;
    } else {
        const cls = authFindClass(classId);
        if (!cls) return { ok: false, error: '請選擇班級' };
        name = cls.name;
        schedulePath = cls.schedule || '';
        account.customClass = false;
    }

    account.classId = classId;
    account.className = name;
    account.schedulePath = schedulePath;
    authTouch(account);
    authPersistAccounts();

    return { ok: true, account: account };
}

/* ================= 裝置層班級偏好（user_class） =================
   課表應該跟「這部裝置揀過邊班」走，唔應該靠帳號，亦唔應該在未揀之前
   隨便派一份預設班級課表。所以獨立存一個 user_class key，未登入都用得。 */

function authGetStoredClassId() {
    try {
        return String(localStorage.getItem(AUTH_USER_CLASS_KEY) || '').trim();
    } catch (e) {
        return '';
    }
}

function authSetStoredClassId(value) {
    const id = String(value == null ? '' : value).trim();
    try {
        if (id) localStorage.setItem(AUTH_USER_CLASS_KEY, id);
        else localStorage.removeItem(AUTH_USER_CLASS_KEY);
    } catch (e) {
        console.warn('[auth] 無法儲存班級偏好:', e);
    }
    return id;
}

/**
 * 讀出裝置層班級偏好並解析成課表來源。
 * 值接受班級 id（junior2-wang）、英文代號（S2B）或中文班名（初二望）；
 * 若該班級已經唔存在於最新清單（清單換版）→ 當作「未選擇」，回傳 null。
 */
function authStoredClassChoice() {
    const raw = authGetStoredClassId();
    if (!raw) return null;

    const list = authLoadClassesSync();
    const fallback = (list && list.defaultSchedule) || 'data/schedule.json';

    // 自訂班級：冇專屬課表 → 沿用預設課表
    if (raw.indexOf('custom:') === 0) {
        const name = raw.slice(7).trim();
        if (!name) return null;
        return { url: fallback, isDefault: true, className: name, classId: raw, reason: 'custom' };
    }

    const cls = authFindClass(raw) || authResolveClassInput(raw);
    if (!cls) return null;

    return {
        url: cls.schedule || fallback,
        isDefault: !cls.schedule,
        className: cls.name,
        classId: cls.id,
        reason: cls.schedule ? 'stored' : 'stored-no-file'
    };
}

/**
 * 決定這部裝置／這個帳號要讀哪一份課表。
 *  · 帳號已綁班級 → 用該班課表（帳號優先）
 *  · 帳號未綁班級／未登入 → 用裝置層偏好 user_class
 *  · 完全未選擇過 → reason 'unselected'：唔派任何預設班級課表，
 *    交由 UI 顯示「請先選擇班級」並引導選班
 *  · 班級冇專屬檔案 → 退回預設課表，並標記 isDefault 讓 UI 提示
 */
function authResolveSchedule(account) {
    const list = authLoadClassesSync();
    const fallback = (list && list.defaultSchedule) || 'data/schedule.json';

    // 自訂班級（帳號自己打嘅名）→ 一律沿用預設課表
    if (account && account.customClass) {
        return {
            url: fallback,
            isDefault: true,
            className: account.className || '',
            classId: account.classId || '',
            reason: 'custom'
        };
    }

    const classId = (account && account.classId) || '';

    // 1) 帳號綁定嘅班級最優先
    if (classId) {
        const cls = authFindClass(classId);

        // 班級已經唔存在於最新清單（清單被修正／換版本）：
        // 呢個時候絕對唔可以再信舊嘅 account.schedulePath，
        // 否則會永遠鎖死在舊檔案，出現「切換班級冇反應」嘅死鎖。
        if (!cls) {
            return {
                url: fallback,
                isDefault: true,
                className: account.className || '',
                classId: classId,
                reason: 'stale'
            };
        }

        // 以「現時班級清單」為準重新解析課表路徑，而唔係直接信 account.schedulePath。
        // 否則班級清單一改動，所有舊帳號都會被舊路徑釘死。
        if (cls.schedule) {
            return {
                url: cls.schedule,
                isDefault: false,
                className: cls.name || account.className || '',
                classId: classId,
                reason: 'class'
            };
        }

        return {
            url: fallback,
            isDefault: true,
            className: cls.name || account.className || '',
            classId: classId,
            reason: 'no-file'
        };
    }

    // 2) 未登入／帳號未綁班級 → 讀裝置層偏好（選過一次就記得）
    const stored = authStoredClassChoice();
    if (stored) return stored;

    // 3) 完全未選擇過班級 → 唔可以派預設班級課表
    return { url: '', isDefault: true, className: '', classId: '', reason: 'unselected' };
}

// 這部裝置／這個帳號到底揀過班級未？未揀 → UI 要引導選班，唔可以顯示任何班級課表
function authHasClassChoice(account) {
    return authResolveSchedule(account || null).reason !== 'unselected';
}

/**
 * 自我修復：班級清單更新之後，帳號可能仍然綁住已經唔存在嘅班級。
 * 呢個係「選完班級後無法再次更換」死鎖嘅另一成因——
 * 舊 classId／schedulePath 一直留喺帳號上，切換班級永遠對唔上新清單。
 *
 * 處理方式：
 *   · 班級已從清單消失 → 清空綁定，強制重新選班
 *   · 班級仍然存在但課表路徑變咗 → 同步成最新路徑
 *   · 自訂班級 → 清掉可能殘留嘅 schedulePath
 * 回傳被修正嘅帳號數量。
 */
function authRepairAccountClasses() {
    if (!Array.isArray(authAccounts) || !authAccounts.length) return 0;

    let fixed = 0;

    authAccounts.forEach(account => {
        if (!account) return;

        if (account.customClass) {
            if (account.schedulePath) {
                account.schedulePath = '';
                authTouch(account);
                fixed += 1;
            }
            return;
        }

        if (!account.classId) return;

        const cls = authFindClass(account.classId);

        if (!cls) {
            // 班級已從清單消失 → 解除綁定，重新走選班引導
            account.classId = '';
            account.className = '';
            account.schedulePath = '';
            authTouch(account);
            fixed += 1;
            return;
        }

        const expectedPath = cls.schedule || '';
        if ((account.schedulePath || '') !== expectedPath || account.className !== cls.name) {
            account.schedulePath = expectedPath;
            account.className = cls.name;
            authTouch(account);
            fixed += 1;
        }
    });

    if (fixed) authPersistAccounts();
    return fixed;
}

// 同步版本：需要時用已載入／已快取的清單，避免 resolve 時還要 await
function authLoadClassesSync() {
    if (authClasses) return authClasses;

    const fromDb = (typeof DB !== 'undefined') ? DB.get('classes') : null;
    const fromDbDoc = authBuildClassDoc(fromDb);
    if (fromDbDoc) {
        authClasses = fromDbDoc;
        return authClasses;
    }

    // 注意：呢個 key 就係 DB 嘅 auth_classes_cache。
    // 若果版本檢查（dbEnsureClassesSchema）判定快取過期，呢個 key 已經被清走，
    // 所以唔會再讀到舊班級清單。
    const cachedDoc = authBuildClassDoc(Storage.get(AUTH_CLASSES_KEY, null));
    if (cachedDoc) {
        authClasses = cachedDoc;
        return authClasses;
    }
    return { classes: [], defaultClassId: 'junior2-zheng', defaultSchedule: 'data/schedule.json' };
}

/* ================= 初始化 ================= */

function authInit() {
    authLoadStore();
    if (authSession && autSessionExpired()) authSignOut();

    // 班級清單可能已經更新（或舊快取已被清除）→ 修復帳號上失效嘅班級綁定。
    // 唔修復的話，舊 classId 會令課表一直指住舊檔案，
    // 出現「切換班級冇反應 / 無法再次更換班級」嘅死鎖。
    if (authGetClassList().length) {
        authRepairAccountClasses();
    }

    return authGetCurrentAccount();
}
