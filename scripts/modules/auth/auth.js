// ============================================================
// 帳號驗證核心（Real Auth Core）
//  · Email + 密碼註冊 / 登入
//  · Session 保持（localStorage 長期 / sessionStorage 單次）
//  · 班級清單載入與「班級 → 課表」綁定
// ------------------------------------------------------------
// ⚠ 密碼處理方式已變更（重要）：
//   舊版由前端自行計算 salted SHA-256（authHashPassword）再存進 Google Sheets。
//   該做法有兩個問題：① 前端雜湊對離線攻擊幾乎無防護力，
//   ② 密碼雜湊值會連同帳號資料一齊在裝置之間傳遞。
//   現已全面改由 Supabase Auth 處理：前端只把明文密碼經 HTTPS 交給
//   伺服器，由伺服器以 bcrypt 儲存，前端永不計算、永不保存任何雜湊或鹽值。
//   ⇒ authHashPassword / authVerifyPassword / autSecureAvailable 已移除，
//     帳號物件亦唔再有 salt / passwordHash 欄位。
//
// 本機帳號快取（localStorage）仍然保留，用途改為：
//   · 離線讀取帳號資料（班級、頭像）→ 秒開
//   · 保存每個帳號自己的 Supabase 續期權杖（account.sbRefreshToken），
//     令一部裝置可以儲存多個帳號並即時切換（切換時換權杖，唔需要再打密碼）
// ⚠ 續期權杖只留在本機，永遠唔會推送雲端（見 cloud.js 的 SB_PUSH_FIELDS）。
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

/* ================= 密碼驗證 ================= */

// ⚠ 前端密碼雜湊（authHashPassword / authVerifyPassword / autSecureAvailable）
//   已整段移除。密碼由 Supabase Auth 於伺服器以 bcrypt 儲存及比對，
//   前端只負責把明文經 HTTPS 送出，唔會、亦唔可以自行驗證密碼。

// 密碼長度下限：同 Supabase 專案的 Password Policy 保持一致（預設 6，建議 8）
function authPasswordMinLength() {
    const configured = Number(authConfig().passwordMinLength);
    return Number.isFinite(configured) && configured >= 6 ? configured : 6;
}

function authPasswordCheck(password) {
    const value = String(password == null ? '' : password);
    if (!value) return { ok: false, error: '請輸入密碼' };
    if (value.length < authPasswordMinLength()) {
        return { ok: false, error: '密碼至少需要 ' + authPasswordMinLength() + ' 個字元' };
    }
    if (value.length > 72) {
        // bcrypt 只取前 72 bytes，超出部分會被忽略 → 直接擋掉避免使用者誤會
        return { ok: false, error: '密碼太長（最多 72 個字元）' };
    }
    return { ok: true };
}

/* ================= 帳號資料庫 ================= */

// 舊版本（只有名字）建立的帳號要補齊欄位，避免升版後整個壞掉
function authNormalizeAccount(raw) {
    const acc = Object.assign({}, raw);
    // 有 Supabase 身分之後，id 就係 auth.users.id（uuid）；舊版本機帳號
    // （acc_xxx）喺第一次成功登入／註冊後會自動換成 uuid。
    acc.id = acc.id || ('acc_' + authRandomHex(6));
    acc.name = acc.name || '未命名用戶';
    acc.email = authNormalizeEmail(acc.email);
    acc.provider = acc.provider || 'email';
    acc.avatar = acc.avatar || '';
    acc.avatarUrl = acc.avatarUrl || '';
    // ⚠ 舊版的 salt / passwordHash 欄位已不再使用（密碼交由 Supabase Auth 管理）。
    //   喺正規化時直接刪走，下一次 authPersistAccounts() 寫檔就會真正清乾淨。
    delete acc.salt;
    delete acc.passwordHash;
    // Supabase 身分：sbUserId ＝ auth.users.id（uuid，同 acc.id 一致）；
    // sbRefreshToken ＝ 本機限定的續期權杖，用於免密碼切換帳號。兩者都唔會上雲。
    acc.sbUserId = acc.sbUserId ? String(acc.sbUserId) : '';
    acc.sbRefreshToken = acc.sbRefreshToken ? String(acc.sbRefreshToken) : '';
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
 * @returns {Object|null} 合併後的本機帳號
 */
function authUpsertAccount(remote) {
    if (!remote || !remote.id) return null;

    const normalized = authNormalizeAccount(remote);
    let index = authAccounts.findIndex(item => item && item.id === normalized.id);

    // 由舊版（Google Sheets 的本機帳號，id = acc_xxx）升級過來時，
    // 同一個 Email 會撞到舊紀錄：呢個情況要「接手」舊紀錄，
    // 換成 Supabase uuid 而唔係多開一個重複帳號。
    let adopted = null;
    if (index < 0 && normalized.email) {
        const legacyIndex = authAccounts.findIndex(item =>
            item && authNormalizeEmail(item.email) === normalized.email);
        if (legacyIndex >= 0) {
            adopted = authAccounts[legacyIndex];
            index = legacyIndex;
        }
    }

    if (index < 0) {
        authAccounts.push(normalized);
        authPersistAccounts({ silent: true });
        return normalized;
    }

    const merged = Object.assign({}, authAccounts[index]);
    Object.keys(normalized).forEach(key => {
        // ⚠ 本機限定憑證唔可以畀雲端資料覆蓋（雲端唔會回傳，亦唔應該清空）
        if ((key === 'sbRefreshToken' || key === 'sbUserId') && !normalized[key]) return;
        // 加入日期要保留「最早」的那個，避免接手舊帳號時被重設成今日
        if (key === 'createdAt') {
            const older = Math.min(Number(merged.createdAt || 0) || Infinity, Number(normalized.createdAt || 0) || Infinity);
            if (Number.isFinite(older)) merged.createdAt = older;
            return;
        }
        merged[key] = normalized[key];
    });

    if (adopted) merged.createdAt = Number(adopted.createdAt) || merged.createdAt;
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
    // ⚠ 登出要一併撤銷 Supabase session：本機即刻登出，網絡請求只係背景清理，
    //   失敗（例如離線）唔應該阻擋使用者。
    //   注意：這裡只清掉「目前 session」，各帳號自己儲存的續期權杖仍然保留，
    //   所以由帳號選單切換返去時唔需要重新輸入密碼（與舊版行為一致）。
    if (typeof cloudSignOut === 'function' && typeof cloudEnabled === 'function' && cloudEnabled()) {
        try { cloudSignOut(); } catch (error) { /* 背景清理失敗唔影響登出 */ }
    }
    authSession = null;
    authPersistSession();
    Storage.remove('profile_current_id');
}

// ============================================================
// 安全登出（使用者主動按「登出」時走這條路徑）
// ------------------------------------------------------------
// 與 authSignOut() 的分工：
//   authSignOut()       —— 程式內部狀態切換（session 過期、移除帳號時呼叫），
//                          刻意保留各帳號的續期權杖，令切換帳號免密碼。
//   authSignOutSecure() —— 使用者主動登出，必須「唔留痕」。
//
// ⚠ 舊版係 fire-and-forget（cloudSignOut() 冇 await），
//   造成「UI 已顯示已登出，但撤銷請求仲喺度跑」的窗口 ——
//   公用電腦上使用者一撳登出就走人，嗰個請求有機會從未送出，
//   伺服器端的 refresh token 就會繼續有效。這裡改為 await。
//
// 清除範圍（全部屬「身分／憑證」，唔包括使用者的課表內容）：
//   ① Supabase access + refresh token        → appdb_v1_sb_session
//   ② 該帳號儲在本機的續期權杖               → account.sbRefreshToken
//   ③ 該帳號未推送的待送佇列（可能含頭像）   → appdb_v1_cloud_queue
//   ④ 該帳號的最後同步時間戳                 → appdb_v1_cloud_state / _last_sync
//   ⑤ sessionStorage 內所有 auth_* / appdb_* 鍵
//   ⑥ 登入旗標與個資（userEmail / userName / isLoggedIn / profile_current_id）
//
// ⚠ 刻意「唔清」的鍵：user_class（裝置層班級偏好）、theme（主題）、
//   appdb_v1_<課表集合>（使用者自己嘅內容）。
//   登出唔應該令課表消失 —— 嗰個係資料損毀，唔係安全加固。
//   公用電腦情境請用 { wipeLocalData: true }。
//
// @param {{revokeCredential?: boolean, wipeLocalData?: boolean}} [options]
// @returns {Promise<{ok: boolean, revoked: boolean, purgedJobs: number}>}
// ============================================================
async function authSignOutSecure(options) {
    const opts = options || {};
    const cfg = authConfig();

    // 預設跟隨設定檔；設定檔沒寫就採用最安全的值（銷毀）
    const revokeCredential = (opts.revokeCredential !== undefined)
        ? !!opts.revokeCredential
        : (cfg.logoutRevokesCredential !== false);
    const wipeLocalData = (opts.wipeLocalData === true);

    const account = authGetCurrentAccount();
    const accountId = (account && account.id) ? String(account.id) : '';

    let revoked = false;

    // ① 先向伺服器撤銷 session。
    //    cloudSignOut() 內部有 5 秒逾時，所以唔會無限等；
    //    離線時會拋錯，但唔可以因此中止 —— 否則會留下「半登出」狀態。
    if (typeof cloudSignOut === 'function' && typeof cloudEnabled === 'function' && cloudEnabled()) {
        try {
            await cloudSignOut();
            revoked = true;
        } catch (error) {
            revoked = false;
        }
    }

    // ② 銷毀本機的續期權杖（令它唔可以再被用嚟靜默換新權杖）
    if (revokeCredential && accountId && typeof sbForgetCredential === 'function') {
        try { sbForgetCredential(accountId); } catch (error) { /* 略過 */ }
    }

    // ③ 清雲端待送佇列與逐帳號同步狀態
    let purgedJobs = 0;
    if (typeof cloudPurgeAccountData === 'function') {
        try {
            const purged = cloudPurgeAccountData(accountId);
            purgedJobs = (purged && purged.purgedJobs) || 0;
        } catch (error) { /* 略過 */ }
    }

    // ④ 一般登出（清 session / 旗標 / profile_current_id）
    authSignOut();

    // ⑤ 清掃殘留鍵
    authSweepSensitiveKeys();

    // ⑥ 可選：連使用者課表內容一併抹除（公用電腦／裝置移交）
    if (wipeLocalData) authWipeLocalData();

    return { ok: true, revoked: revoked, purgedJobs: purgedJobs };
}

/**
 * 只含「身分／憑證」的鍵清單。
 * ⚠ 唔可以加入 user_class / theme / appdb_v1_<課表集合>：
 *   嗰啲係裝置設定同使用者內容，登出時清除會造成非預期的資料遺失。
 */
const AUTH_SENSITIVE_KEYS = [
    'auth_session',
    'isLoggedIn',
    'userEmail',
    'userName',
    'profile_current_id',
    'profile_accounts',
    'appdb_v1_sb_session',
    'appdb_v1_cloud_queue',
    'appdb_v1_cloud_state',
    'appdb_v1_cloud_last_sync'
];

/** 清掃本機殘留的身分／憑證鍵（localStorage + sessionStorage） */
function authSweepSensitiveKeys() {
    // localStorage：逐一刪除，⚠ 唔可以用 clear()——
    // clear() 會連 theme、user_class 一齊殺，令使用者登出後主題同班級都跑掉。
    AUTH_SENSITIVE_KEYS.forEach(function (key) {
        try { Storage.remove(key); } catch (error) { /* 略過 */ }
    });

    // sessionStorage：本 App 只用嚟存短期 session，一次過掃走相關前綴
    try {
        const doomed = [];
        for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i) || '';
            if (key.indexOf('auth_') === 0 || key.indexOf('appdb_') === 0) doomed.push(key);
        }
        doomed.forEach(function (key) {
            try { sessionStorage.removeItem(key); } catch (error) { /* 略過 */ }
        });
    } catch (error) {
        // 私密模式可能停用 sessionStorage，唔影響登出流程
    }
}

/**
 * 徹底抹除本機使用者資料（公用電腦／裝置移交情境）。
 * ⚠ 破壞性操作：課表、頭像、班級綁定全部消失且無法復原。
 *   只有 authSignOutSecure({ wipeLocalData: true }) 會呼叫它。
 */
function authWipeLocalData() {
    const doomed = [];
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i) || '';
            // 涵蓋 db.js 的課表集合（appdb_v1_*）與雲端鏡像（appdb_mirror_v1_*）
            if (key.indexOf('appdb_v1_') === 0 || key.indexOf('appdb_mirror_v1_') === 0) {
                doomed.push(key);
            }
        }
    } catch (error) { /* 略過 */ }

    doomed.forEach(function (key) {
        try { Storage.remove(key); } catch (error) { /* 略過 */ }
    });
}

// 切換到本機已有的另一個帳號（裝置層級的帳號切換，不需重新輸入密碼）
function authSwitchAccount(accountId, remember) {
    const account = authFindAccount(accountId);
    if (!account) return { ok: false, error: '找不到這個帳號' };
    authStartSession(account, remember !== false);

    // 切換帳號＝同時切換雲端身分：用該帳號自己的續期權杖換一張新權杖。
    // 背景進行、唔阻塞 UI；換唔到（憑證過期／離線）只會令雲端同步暫停，
    // 本機功能完全不受影響。
    if (typeof cloudActivateAccount === 'function' && typeof cloudEnabled === 'function' && cloudEnabled()) {
        try { cloudActivateAccount(account.id); } catch (error) { /* 背景 */ }
    }
    return { ok: true, account: account };
}

/**
 * 從「這部裝置」的帳號清單移除帳號。
 * ⚠ 刻意唔會刪除雲端（Supabase profiles）上的紀錄：
 *   呢個動作只係本機清單整理，帳號資料本身應該永續保存。
 *   真正要刪除雲端紀錄，請用 cloudDeleteAccount(id)（開發者面板）。
 * ⚠ 但本機儲存的續期權杖一定要清走，否則移除之後仍然可以用它偷偷同步。
 */
function authRemoveAccount(accountId) {
    const index = authAccounts.findIndex(a => a.id === accountId);
    if (index < 0) return false;

    // 必須在 splice 之前清憑證（之後就查唔到這個帳號了）
    if (typeof sbForgetCredential === 'function') sbForgetCredential(accountId);

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

    const current = String(currentPassword == null ? '' : currentPassword);
    if (!current) return { ok: false, error: '請輸入目前密碼' };

    const check = authPasswordCheck(newPassword);
    if (!check.ok) return { ok: false, error: check.error };
    // 先做本機檢查，避免明明唔合法都送一次網絡請求出去
    if (String(newPassword) === current) return { ok: false, error: '新密碼不可以與目前密碼相同' };

    // ⚠ 密碼由 Supabase Auth 管理：前端唔再計算雜湊，亦唔再保存任何雜湊值。
    //   變更前必須先通過「目前密碼」驗證，否則任何人拿到未鎖定的裝置就可直接改密碼。
    if (typeof cloudEnabled !== 'function' || !cloudEnabled() || typeof cloudUpdatePassword !== 'function') {
        return { ok: false, error: '雲端同步未啟用，無法變更密碼' };
    }

    const result = await cloudUpdatePassword(account.email, current, newPassword);
    if (!result || !result.ok) {
        return {
            ok: false,
            error: (result && result.message) || '無法變更密碼，請檢查網絡後再試',
            offline: !!(result && result.offline)
        };
    }

    // 本機唔再保存任何密碼資料，所以呢度冇欄位需要更新
    return { ok: true, account: account };
}

/**
 * 變更帳號綁定的電郵。同一個電郵不可以同時屬於兩個本機帳號，
 * 否則 authFindByEmail() 會出現不確定的結果。
 * ⚠ Email 同時係 Supabase Auth 的登入身分，所以必須「先改雲端、後改本機」；
 *   而且 Supabase 預設會寄確認連結到新信箱，確認前唔可以改本機，
 *   否則本機 Email 同 auth.users 唔一致，使用者會即刻登入唔到。
 * @returns {Promise<{ok:boolean, error?:string, pendingConfirmation?:boolean, account?:Object}>}
 */
async function authUpdateEmail(accountId, email) {
    const account = authFindAccount(accountId);
    if (!account) return { ok: false, error: '找不到這個帳號' };

    const next = authNormalizeEmail(email);
    if (!authValidEmail(next)) return { ok: false, error: 'Email 格式不正確' };
    if (next === authNormalizeEmail(account.email)) return { ok: false, error: '這與目前的 Email 相同' };

    const occupied = authAccounts.find(item =>
        item && item.id !== accountId && authNormalizeEmail(item.email) === next);
    if (occupied) return { ok: false, error: '這個 Email 已被另一個帳號使用' };

    if (typeof cloudEnabled !== 'function' || !cloudEnabled() || typeof cloudUpdateUserEmail !== 'function') {
        return { ok: false, error: '雲端同步未啟用，無法變更 Email' };
    }

    const result = await cloudUpdateUserEmail(next);
    if (!result || !result.ok) {
        return { ok: false, error: (result && result.message) || '無法變更 Email，請檢查網絡後再試' };
    }

    if (result.pendingConfirmation) {
        return { ok: true, pendingConfirmation: true, email: next, account: account };
    }

    account.email = next;
    account.provider = 'email';
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

    const check = authPasswordCheck(password);
    if (!check.ok) return { ok: false, error: check.error };
    if (password !== confirm) return { ok: false, error: '兩次輸入的密碼不一致' };
    if (authFindByEmail(email)) return { ok: false, error: '這個 Email 已經註冊過了，請直接登入' };

    const account = authNormalizeAccount({
        name: name,
        email: email,
        provider: 'email',
        avatar: input.avatar || '',
        createdAt: Date.now(),
        lastLoginAt: Date.now()
    });

    // ⚠ 註冊必須連線：帳號由 Supabase Auth 建立（密碼於伺服器以 bcrypt 儲存），
    //   前端無能力離線建立一個「之後真係登入得到」的帳號。
    //   舊版可以樂觀寫入本機再排隊補送，但咁樣只會產生幽靈帳號（登入唔到、又同步唔到），
    //   所以改為直接回報失敗。
    const cloudOn = typeof cloudEnabled === 'function' && cloudEnabled();
    if (!cloudOn) {
        return { ok: false, error: '雲端同步未啟用，無法註冊帳號（請在 auth-config.js 填寫 Supabase 設定）', reason: 'DISABLED' };
    }

    const cloud = await cloudRegisterAccount(account, password);
    if (!cloud || !cloud.ok) {
        return {
            ok: false,
            error: (cloud && cloud.message) || '無法完成註冊，請檢查網絡後再試',
            reason: (cloud && cloud.code) || 'CLOUD_FAIL',
            offline: !!(cloud && cloud.offline)
        };
    }

    // 專案開啟了「Confirm email」→ 未有 session，唔可以當作已登入
    if (cloud.pendingConfirmation) {
        return { ok: true, pendingConfirmation: true, account: null, email: email };
    }

    const remote = authUpsertAccount(cloud.account || account) || account;
    authPersistAccounts();
    authStartSession(remote, input.remember !== false);

    return { ok: true, account: remote, cloudOffline: false };
}

/**
 * Email 登入。密碼一律由 Supabase Auth 驗證（前端無法、亦唔會自行比對密碼）。
 *   ① 有網時：交 Supabase Auth 驗證，成功就一併把 profiles 最新資料寫回本機快取。
 *   ② 連唔到線時：只放行「這部裝置曾經登入過、仲持有續期權杖」的帳號
 *      （等同舊版「本機快取驗證」的信任層級：信任這部裝置）。
 *      可以用 auth-config.js 的 allowOfflineSignIn:false 完全關閉此行為。
 */
async function authSignInWithEmail(input) {
    const email = authNormalizeEmail(input.email);
    const password = String(input.password || '');

    if (!email) return { ok: false, error: '請輸入 Email' };
    if (!password) return { ok: false, error: '請輸入密碼' };

    const account = authFindByEmail(email);
    const cloudOn = typeof cloudEnabled === 'function' && cloudEnabled();

    if (!cloudOn) {
        return {
            ok: false,
            error: '雲端同步未啟用，無法驗證密碼登入（請在 auth-config.js 填寫 Supabase 設定）',
            reason: 'DISABLED'
        };
    }

    const remote = await cloudSignIn(email, password);

    if (remote && remote.ok) {
        const merged = authUpsertAccount(remote.account);
        if (merged) {
            authStartSession(merged, input.remember !== false);
            return { ok: true, account: merged, fromCloud: true };
        }
    }

    // 雲端明確判定密碼錯 → 直接回報，唔可以再落本機
    // （否則改完密碼之後，用舊密碼一樣登入得到）
    if (remote && remote.code === 'BAD_PASSWORD') {
        return { ok: false, error: '密碼錯誤，請重新輸入', reason: 'BAD_PASSWORD' };
    }
    if (remote && remote.code === 'NO_CONFIRM') {
        return {
            ok: false,
            error: '這個 Email 尚未完成驗證，請先到信箱點擊確認連結',
            reason: 'NO_CONFIRM'
        };
    }
    if (remote && remote.code === 'RATE_LIMIT') {
        return { ok: false, error: '嘗試次數過多，請稍後再試', reason: 'RATE_LIMIT' };
    }
    if (remote && remote.code === 'NO_ACCOUNT') {
        return { ok: false, error: '帳號不存在，請先切換至註冊', reason: 'NO_ACCOUNT' };
    }

    // 以下為「連唔到線」路徑
    if (remote && remote.offline) {
        const allowOffline = authConfig().allowOfflineSignIn !== false;

        if (account && account.sbRefreshToken && allowOffline) {
            // 這部裝置登入過這個帳號 → 先放行本機資料，
            // 恢復連線後 cloudActivateAccount() 會換新權杖並重新校驗。
            authStartSession(account, input.remember !== false);
            if (typeof cloudActivateAccount === 'function') cloudActivateAccount(account.id);
            return { ok: true, account: account, offlineFallback: true, offlineNoVerify: true };
        }

        if (account && !allowOffline) {
            return {
                ok: false,
                error: '離線模式不支援密碼登入，請連接網絡後再試',
                reason: 'OFFLINE_NO_VERIFY',
                offline: true
            };
        }

        if (account) {
            return {
                ok: false,
                error: '離線時無法驗證密碼。這個帳號在這部裝置沒有可用的登入憑證，請連接網絡後再試',
                reason: 'OFFLINE_NO_VERIFY',
                offline: true
            };
        }

        return {
            ok: false,
            error: '這部裝置沒有這個帳號的快取，而且目前無法連線到雲端，請檢查網絡後再試',
            reason: 'TIMEOUT',
            offline: true
        };
    }

    return { ok: false, error: '登入失敗，請稍後再試', reason: 'UNKNOWN' };
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
