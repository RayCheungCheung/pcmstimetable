// ============================================================
// devtools.js —— 開發者模式（伺服器端驗證）
// ------------------------------------------------------------
// ⚠ 前端「永遠」唔會持有密碼，亦唔會做任何密碼比對。
//   本檔只係一條傳輸通道：送密碼上 Supabase → 收返角色。
//   真正嘅判斷喺 public.dev_verify_password()
//   （見 supabase/developer-mode.sql，部署前必須先執行）。
//
// ⚠ 角色以「伺服器」為準。下面嘅 localStorage 只係顯示快取，
//   用嚟避免每次開 App 都閃一下未解鎖狀態。
//   任何權限判斷都必須先經 devSyncRole() 向伺服器確認 ——
//   改 localStorage 唔會拎到任何權限（呢點同舊版 dev_mode_enabled
//   完全相反，舊版就係因為可以被手改而整個刪除）。
//
// ⚠ 未登入雲端（純本機模式）時開發者模式一律不可用：
//   冇雲端就冇伺服器可以驗證，唔可以退回本機比對。
//
// ⚠ 入口：「個人中心」（個人主頁）頁尾嘅版本號連點 5 下
//   （見下方「版本號『連點 5 下』入口」一段）。
//   全站只有呢一個入口，唔好喺其他地方再加第二個 —— 安全性嚟自下面嘅
//   伺服器端驗證，唔係嚟自「冇人知道有呢一頁」。
// ============================================================

const DEV_CACHE_KEY = 'dev_role_cache_v1';
const DEV_CACHE_TTL_MS = 30 * 60 * 1000;

// 角色層級：數字越大權限越高（單一來源，唔喺其他地方另寫一份）
const DEV_ROLE_RANK = { maintainer: 1, mod: 2, super_admin: 3 };
const DEV_ROLE_LABEL = {
    maintainer: '初級管理員（維護者）',
    mod: '中級管理員',
    super_admin: '最高管理員'
};

// 目前角色。唯一可信來源係伺服器，下面只係佢最近一次確認嘅副本。
let devCurrentRole = null;

function devRoleRank(role) { return DEV_ROLE_RANK[role] || 0; }
function devRoleLabel(role) { return DEV_ROLE_LABEL[role] || ''; }

/** 目前角色（可能係 null） */
function devGetRole() { return devCurrentRole; }

/** 權限檢查：目前角色是否達到 minRole 或以上 */
function devHasRole(minRole) {
    const need = devRoleRank(minRole);
    return need > 0 && devRoleRank(devCurrentRole) >= need;
}

// ---------- 顯示快取（唔係權限來源） ----------
function devCacheClear() {
    try { if (typeof Storage !== 'undefined') Storage.remove(DEV_CACHE_KEY); } catch (e) { /* 略過 */ }
}

function devCacheWrite(role) {
    try {
        if (typeof Storage === 'undefined') return;
        Storage.set(DEV_CACHE_KEY, { role: role, at: Date.now() });
    } catch (e) { /* 私密模式等情況下略過 */ }
}

function devSetRole(role) {
    devCurrentRole = role || null;
    if (devCurrentRole) devCacheWrite(devCurrentRole); else devCacheClear();
    document.dispatchEvent(new CustomEvent('dev-role-changed', { detail: { role: devCurrentRole } }));
}

function devClearRole() { devSetRole(null); }

// ---------- RPC 通道 ----------
async function devRpc(fnName, body) {
    if (typeof cloudEnabled !== 'function' || !cloudEnabled()) {
        return { ok: false, code: 'DISABLED', message: '雲端同步未啟用，開發者模式無法使用' };
    }
    if (typeof sbRequest !== 'function') {
        return { ok: false, code: 'NO_CLIENT', message: '雲端模組未載入' };
    }
    return sbRequest('/rest/v1/rpc/' + fnName, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body || {}
    }, { auth: 'user', retry: 0 });
}

/** 由 RPC 回應抽出角色字串（PostgREST 嘅 scalar set 可能係物件或陣列） */
function devRoleFromResponse(res) {
    if (!res || !res.ok) return null;
    const row = Array.isArray(res.data) ? res.data[0] : res.data;
    if (!row) return null;
    return (typeof row === 'string') ? row : (row.granted_role || null);
}

/**
 * 送密碼上伺服器驗證。
 * ⚠ 呢個函式唔會、亦唔可以自行判斷密碼是否正確 —— 完全取決於伺服器回應。
 * @returns {Promise<{ok:boolean, role?:string, code?:string, message?:string}>}
 */
async function devVerifyPassword(password) {
    const res = await devRpc('dev_verify_password', { p_password: String(password || '') });

    if (!res.ok) {
        // ⚠ 呢度刻意分開幾種失敗原因。全部都報「密碼錯誤」的話，
        //   「SQL 未執行」同「打錯密碼」會長得一模一樣，除錯時會捉錯方向。
        if (res.code === 'DISABLED' || res.code === 'NO_CLIENT') {
            return { ok: false, code: res.code, message: res.message };
        }
        // 404 ＝ PostgREST 找不到 dev_verify_password()，
        // 幾乎必然係 supabase/developer-mode.sql 未執行
        if (res.code === 'HTTP_404') {
            return {
                ok: false,
                code: res.code,
                message: '驗證服務未部署（請先執行 supabase/developer-mode.sql）'
            };
        }
        if (res.code === 'UNAUTHORIZED' || res.code === 'NO_SESSION') {
            return { ok: false, code: res.code, message: '請先登入雲端帳號再試' };
        }
        return { ok: false, code: res.code, message: '無法驗證身分，請稍後再試' };
    }

    const role = devRoleFromResponse(res);
    // 伺服器回傳空集合 ＝ 密碼錯誤（刻意唔區分「唔喺白名單」，
    // 避免回報方式洩漏某帳號是否為管理員）
    if (!role) return { ok: false, code: 'BAD_PASSWORD', message: '密碼錯誤，無法存取開發者模式' };

    devSetRole(role);
    return { ok: true, role: role };
}

/** 開機時向伺服器確認目前角色（唯一可信來源） */
async function devSyncRole() {
    if (typeof cloudEnabled !== 'function' || !cloudEnabled()) { devClearRole(); return null; }
    const res = await devRpc('dev_my_role');
    if (!res.ok) { devClearRole(); return null; }
    const role = devRoleFromResponse(res);
    devSetRole(role);
    return role;
}

/** 登出開發者模式（伺服器端一併刪除角色列） */
async function devRevokeRole() {
    await devRpc('dev_revoke_role');
    devClearRole();
}

// ============================================================
// 密碼輸入介面
// ⚠ 舊版嘅 .dev-pwd-overlay DOM 已隨開發者模式一併刪除，
//   所以呢度改用 JS 即場建立（同 profile 子頁面一樣，唔預先塞 DOM）。
// ============================================================

function devPromptEl() { return document.getElementById('dev-pwd-overlay'); }

function devPromptClose() {
    const el = devPromptEl();
    if (!el) return;
    el.classList.remove('is-open');
    const input = el.querySelector('.dev-pwd__input');
    if (input) input.value = '';
    const err = el.querySelector('.dev-pwd__error');
    if (err) err.textContent = '';
}

function devPromptEnsure() {
    if (devPromptEl()) return devPromptEl();

    const wrap = document.createElement('div');
    wrap.id = 'dev-pwd-overlay';
    wrap.className = 'dev-pwd-overlay';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', '開發者模式驗證');
    wrap.innerHTML =
        '<div class="dev-pwd">' +
            '<p class="dev-pwd__title">開發者模式</p>' +
            '<p class="dev-pwd__desc">請輸入驗證密碼</p>' +
            '<input class="dev-pwd__input" type="password" inputmode="text"' +
            ' autocomplete="off" spellcheck="false" placeholder="密碼">' +
            '<p class="dev-pwd__error" role="alert"></p>' +
            '<div class="dev-pwd__actions">' +
                '<button class="dev-pwd__btn" type="button" data-dev-cancel>取消</button>' +
                '<button class="dev-pwd__btn dev-pwd__btn--primary" type="button" data-dev-submit>確認</button>' +
            '</div>' +
        '</div>';

    document.body.appendChild(wrap);

    wrap.addEventListener('click', function (ev) {
        if (ev.target === wrap) devPromptClose();
    });
    wrap.querySelector('[data-dev-cancel]').addEventListener('click', devPromptClose);
    wrap.querySelector('[data-dev-submit]').addEventListener('click', devSubmitPassword);
    wrap.querySelector('.dev-pwd__input').addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); devSubmitPassword(); }
    });

    if (typeof hydrateIcons === 'function') hydrateIcons(wrap);
    return wrap;
}

/** 開啟密碼驗證彈窗 */
function devRequestAccess() {
    if (typeof cloudEnabled !== 'function' || !cloudEnabled()) {
        if (typeof profileToast === 'function') profileToast('雲端未啟用，開發者模式無法使用');
        return;
    }
    const el = devPromptEnsure();
    el.classList.add('is-open');
    const input = el.querySelector('.dev-pwd__input');
    if (input) { input.value = ''; input.focus(); }
}

/** 提交密碼（驗證中停用按鈕，避免連點產生多筆稽核記錄） */
async function devSubmitPassword() {
    const el = devPromptEl();
    if (!el) return;

    const input = el.querySelector('.dev-pwd__input');
    const errEl = el.querySelector('.dev-pwd__error');
    const submit = el.querySelector('[data-dev-submit]');
    const password = input ? input.value : '';

    if (!password) {
        if (errEl) errEl.textContent = '請輸入密碼';
        return;
    }

    if (submit) submit.disabled = true;
    if (errEl) errEl.textContent = '驗證中…';

    let result;
    try {
        result = await devVerifyPassword(password);
    } catch (error) {
        result = { ok: false, message: '驗證失敗，請稍後再試' };
    }

    if (submit) submit.disabled = false;

    if (!result.ok) {
        if (errEl) errEl.textContent = result.message || '密碼錯誤，無法存取開發者模式';
        if (input) input.value = '';
        return;
    }

    devPromptClose();
    if (typeof profileToast === 'function') {
        profileToast('已進入開發者模式（' + devRoleLabel(result.role) + '）');
    }
    if (typeof devOpenPanel === 'function') devOpenPanel();
}

// ============================================================
// 版本號「連點 5 下」入口
// ------------------------------------------------------------
// ⚠ 呢個係開發者模式嘅「唯一」入口。歷史上入口搬過三次，唔好混亂：
//   1. v4.9.0 之前：頁尾／「關於我們」版本號連點 5 下（即本實作）；
//   2. v4.10.0 起：搬去「關於我們 → 開發者簡介」頁尾嘅「開發者模式」列；
//   3. 現在：需求改為單頁面「關於我們」，該列連同成個「開發者簡介」
//      子頁面一併刪除，入口按指示搬返「個人中心」頁尾嘅版本號（本實作）。
// ⚠ 仍然「只可以有一個入口」：唔好喺其他地方再加第二個。安全性嚟自
//   伺服器端密碼驗證（supabase/developer-mode.sql），唔係嚟自「冇人知道
//   有呢一頁」；但多過一個入口就要兩份監聽、兩份維護，出錯面係雙倍。
// ⚠ 用 document 層嘅「事件委派」而唔係逐個元素 addEventListener：
//   版本號雖然係靜態 DOM，但頁面切換（profileShowView）會令佢被隱藏／
//   顯示，而歷史上「關於我們」頁嘅版本列更係每次重新渲染 ——
//   委派一次綁定就永久有效，唔會因為重新渲染而斷。
// ⚠ 判斷目標用 closest('[data-dev-version]') 而唔係比對 id：
//   id 一旦改動就會靜靜失效；屬性標記係「意圖」嘅宣告，同 index.html
//   上嘅標記一對一，之後查「入口喺邊」只需要搜一個屬性名。
// ⚠ 刻意「唔」記錄任何 localStorage 狀態，亦唔喺連點中途中出任何提示：
//   連點唔中可以係手誤，一出提示就等於公告「呢度有個閘」。
// ============================================================
const DEV_CLICK_COUNT = 5;        // 連點次數（需求：5 下）
const DEV_CLICK_WINDOW_MS = 2000; // 由「第一下」起計嘅有效時窗

let devClickCount = 0;
let devClickFirstAt = 0;
let devVersionBound = false;

/** document 層 click 委派：只有命中 [data-dev-version] 嘅點擊才計數 */
function devHandleVersionClick(ev) {
    const target = ev.target && ev.target.closest ? ev.target.closest('[data-dev-version]') : null;
    if (!target) return;

    const now = Date.now();
    // 第一次點、或者已經超出時窗：重新起算。
    // ⚠ 一定要有呢個「重置」分支，否則「慢慢撳 5 下」都會觸發 ——
    //   嗰樣就唔係連點，而係「總共撳過 5 下」，好容易誤觸。
    if (!devClickFirstAt || now - devClickFirstAt > DEV_CLICK_WINDOW_MS) {
        devClickFirstAt = now;
        devClickCount = 1;
        return;
    }

    devClickCount += 1;
    if (devClickCount < DEV_CLICK_COUNT) return;

    // 命中：即刻歸零，令下一次要重新連點 5 下
    // （唔歸零嘅話，之後每多撳一下都會再觸發一次驗證彈窗）。
    devClickCount = 0;
    devClickFirstAt = 0;
    devRequestAccess();
}

/** 綁定入口（只綁一次；重複呼叫安全） */
function devBindVersionTrigger() {
    if (devVersionBound) return;
    devVersionBound = true;
    document.addEventListener('click', devHandleVersionClick);
}

// ============================================================
// 開機初始化
// ============================================================
// ⚠ 刻意「唔」喺 devtools.js 自己掛 DOMContentLoaded：
//   main.js 亦係用 DOMContentLoaded 觸發 initApp() → initAppShell() →
//   initProfile() → authInit()，而本檔排喺 main.js 之前 ——
//   兩個監聽器按註冊次序執行，即係 devBootstrap() 會跑喺 authInit() 之前，
//   嗰一刻 authGetCurrentAccount() 仍然係未初始化狀態，角色永遠同步唔到。
//   所以改為由 main.js 嘅 initAppShell() 明確呼叫（auth 已就緒）。
function devBootstrap() {
    // ⚠ 入口綁定必須排喺雲端檢查「之前」：純本機模式下 devRequestAccess()
    //   會自己出「雲端未啟用」嘅提示，但如果連監聽都冇綁，用戶撳極都冇反應
    //   而且查唔到原因 —— 呢個正是「隱蔽式入口」最難查嘅失敗模式。
    devBindVersionTrigger();

    if (typeof cloudEnabled !== 'function' || !cloudEnabled()) { devClearRole(); return; }
    devSyncRole().catch(function () { /* 非關鍵：失敗即維持未解鎖 */ });
}
