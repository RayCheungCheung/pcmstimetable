// ============================================================
// 用戶介面層：登入 / 註冊 / 班級引導 / 個人中心
// 認證邏輯一律委託 auth.js，這裡只負責畫面與互動
// ============================================================

const PROFILE_AVATAR_MAX = 320;   // 頭像壓縮後的最長邊（px）

// Google 官方「G」標誌（供自製按鈕使用）
const GOOGLE_G_SVG = [
    '<svg class="google-btn__g" viewBox="0 0 48 48" aria-hidden="true">',
    '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>',
    '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>',
    '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.28-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>',
    '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>',
    '</svg>'
].join('');

let profileView = 'auth';        // auth | class | home | accounts
let profileAuthMode = 'signin';  // signin | signup
let profileDraftAvatar = '';     // 註冊表單暫存的頭像 dataURL
let profileOnboarding = false;   // true = 必須完成班級選擇才能離開
let profileClassPick = '';       // 班級頁已選（未確認）的班級 id
let profileClassPickCustom = ''; // 自訂班級名稱
let profileClassesLoaded = false;
let profileToastTimer = null;

/* ================= 小工具 ================= */

function profileEscape(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function profileVal(id) {
    const node = document.getElementById(id);
    return node ? String(node.value || '').trim() : '';
}

function profileChecked(id) {
    const node = document.getElementById(id);
    return !!(node && node.checked);
}

function profileToggleField(id, show) {
    const node = document.getElementById(id);
    if (node) node.style.display = show ? '' : 'none';
}

function profileToast(message) {
    const node = document.getElementById('profile-toast');
    if (!node) return;
    node.textContent = message;
    node.classList.add('is-on');
    clearTimeout(profileToastTimer);
    profileToastTimer = setTimeout(() => node.classList.remove('is-on'), 2200);
}

function profileShowAlert(scope, message, type) {
    const box = document.getElementById(scope + '-alert');
    const text = document.getElementById(scope + '-alert-text');
    if (!box || !text) return;
    text.textContent = message;
    box.className = 'auth-alert is-on auth-alert--' + (type || 'info');
    const iconHost = box.querySelector('.auth-alert__icon');
    if (iconHost) {
        iconHost.innerHTML = icon(
            type === 'error' ? 'alert' : (type === 'ok' ? 'checkCircle' : 'info'),
            { size: 15 }
        );
    }
}

function profileHideAlert(scope) {
    const box = document.getElementById(scope + '-alert');
    if (box) box.className = 'auth-alert';
}

/* ================= 頭像 ================= */

function profileInitialAvatar(name) {
    const letter = String(name || '?').trim().charAt(0) || '?';
    const svg =
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'>" +
        "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
        "<stop offset='0' stop-color='#ff8cbb'/>" +
        "<stop offset='0.55' stop-color='#a86bff'/>" +
        "<stop offset='1' stop-color='#5f7cff'/></linearGradient></defs>" +
        "<rect width='200' height='200' fill='url(#g)'/>" +
        "<text x='100' y='100' fill='#ffffff' font-size='96' font-weight='700' " +
        "font-family='-apple-system,Helvetica,Arial,sans-serif' " +
        "text-anchor='middle' dominant-baseline='central'>" + profileEscape(letter) + "</text></svg>";
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function profileAvatarSrc(account) {
    if (!account) return profileInitialAvatar('?');
    return account.avatar || account.avatarUrl || profileInitialAvatar(account.name);
}

// 將檔案中央裁切成正方形並壓成 JPEG，避免頭像撐爆 localStorage
function profileFileToDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('讀取檔案失敗'));
        reader.onload = () => {
            const image = new Image();
            image.onerror = () => reject(new Error('這不是有效的圖片'));
            image.onload = () => {
                const side = Math.min(image.width, image.height);
                const size = Math.max(1, Math.min(PROFILE_AVATAR_MAX, side));
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                canvas.getContext('2d').drawImage(
                    image,
                    (image.width - side) / 2, (image.height - side) / 2, side, side,
                    0, 0, size, size
                );
                resolve(canvas.toDataURL('image/jpeg', 0.86));
            };
            image.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

function profileHandleAvatarPick(event) {
    const input = event.target;
    const file = input.files && input.files[0];
    if (!file) return;

    if (!/^image\//.test(file.type)) {
        profileToast('請選擇圖片檔案');
        input.value = '';
        return;
    }

    profileFileToDataURL(file).then(dataUrl => {
        profileDraftAvatar = dataUrl;
        const preview = document.getElementById('profile-avatar-preview');
        if (preview) preview.src = dataUrl;
    }).catch(() => profileToast('圖片讀取失敗'));

    input.value = '';
}

function profileClearAvatar() {
    profileDraftAvatar = '';
    const preview = document.getElementById('profile-avatar-preview');
    if (preview) preview.src = profileInitialAvatar('?');
}

/* ================= 頂部標題列 ================= */

function renderProfileHeader() {
    const btn = document.getElementById('header-user');
    if (!btn) return;

    const account = authGetCurrentAccount();

    if (account) {
        // 資料連動：標題列右側即時顯示當前登入用戶的頭像與名字
        btn.innerHTML =
            '<img class="header-user__avatar" src="' + profileAvatarSrc(account) + '" alt="用戶頭像">' +
            '<span class="header-user__name">' + profileEscape(account.name) + '</span>';
        btn.setAttribute('aria-label', '開啟個人中心：' + account.name);
        btn.title = account.name + ' 的個人中心';
        btn.classList.add('is-logged-in');
    } else {
        btn.innerHTML = '<span class="header-user__icon">+</span><span class="header-user__name">登入</span>';
        btn.setAttribute('aria-label', '登入 / 註冊');
        btn.title = '登入 / 註冊';
        btn.classList.remove('is-logged-in');
    }
}

/* ================= 面板與視圖切換 ================= */

const PROFILE_VIEW_NODES = {
    auth: 'profile-view-auth',
    class: 'profile-view-class',
    home: 'profile-view-home',
    accounts: 'profile-view-accounts'
};

const PROFILE_VIEW_TITLES = {
    auth: '登入 / 註冊',
    class: '選擇班級',
    home: '個人中心',
    accounts: '切換帳號'
};

function profileShowView(view) {
    profileView = view;

    Object.keys(PROFILE_VIEW_NODES).forEach(key => {
        const node = document.getElementById(PROFILE_VIEW_NODES[key]);
        if (!node) return;
        const on = key === view;
        // 同時加 is-on 與 active：CSS 兩邊都認，避免類名不一致令視圖隱形
        node.classList.toggle('is-on', on);
        node.classList.toggle('active', on);
    });

    const title = document.getElementById('profile-topbar-title');
    if (title) title.textContent = PROFILE_VIEW_TITLES[view] || '';

    // 返回鍵：帳號清單與（非強制引導的）班級頁才需要
    const back = document.getElementById('profile-back');
    if (back) back.style.display = (view === 'accounts' || (view === 'class' && !profileOnboarding)) ? 'flex' : 'none';

    // 關閉鍵一律可用：引導流程中也不可以把使用者鎖在彈窗內
    const close = document.getElementById('profile-close');
    if (close) close.style.display = 'flex';

    const scroll = document.getElementById('profile-scroll');
    if (scroll) scroll.scrollTop = 0;
}

// 這部裝置／這個帳號揀過班級未？（未揀 → 開 App 就要引導選班）
function profileNeedsClassChoice(account) {
    if (typeof authHasClassChoice === 'function') return !authHasClassChoice(account || null);
    return !!(account && !account.classId);
}

function openProfilePanel(view) {
    const overlay = document.getElementById('profile-overlay');
    if (!overlay) return;

    const account = authGetCurrentAccount();

    // 這部裝置／這個帳號揀過班級未？未揀 → 一律優先引導選班，
    // 唔可以因為未登入就直接顯示預設班級課表。
    const needsClass = profileNeedsClassChoice(account);

    // 只有「已登入但未綁班級」才算強制引導；
    // 未登入者一樣會被引導，但保留返回鍵去登入頁，唔會被鎖住。
    profileOnboarding = needsClass && !!account;

    let target = view || '';
    if (!target) {
        if (needsClass) target = 'class';
        else if (!account) target = authGetAccounts().length ? 'accounts' : 'auth';
        else target = 'home';
    }

    if (target === 'auth' && account) target = 'home';
    if (target === 'class') profilePrepareClassView();

    overlay.classList.add('active');

    if (target === 'home') renderProfileHome();
    if (target === 'accounts') renderAccountsList();

    profileShowView(target);

    if (target === 'auth') profileMountGoogle();
}

function closeProfilePanel(event) {
    if (event && event.target !== event.currentTarget) return;

    const overlay = document.getElementById('profile-overlay');
    if (overlay) overlay.classList.remove('active');

    // 引導尚未完成時只提示，仍然允許關閉（否則使用者會被永久困在彈窗內）
    if (profileOnboarding) profileToast('還沒選班級，可隨時點右上角頭像回來完成');
}

function profileBackView() {
    if (profileView === 'class') {
        if (profileOnboarding) return;
        profileShowView(authGetCurrentAccount() ? 'home' : 'auth');
        return;
    }
    if (profileView === 'accounts') {
        profileShowView(authGetCurrentAccount() ? 'home' : 'auth');
    }
}

/* ================= 登入 / 註冊 表單 ================= */

function profileSetAuthMode(mode) {
    profileAuthMode = (mode === 'signup') ? 'signup' : 'signin';
    const isSignup = profileAuthMode === 'signup';

    const tabSignin = document.getElementById('auth-tab-signin');
    const tabSignup = document.getElementById('auth-tab-signup');
    if (tabSignin) tabSignin.classList.toggle('is-on', !isSignup);
    if (tabSignup) tabSignup.classList.toggle('is-on', isSignup);

    // 只有註冊要填名字 / 確認密碼 / 頭像；只有登入要「記住我」
    profileToggleField('field-name', isSignup);
    profileToggleField('field-confirm', isSignup);
    profileToggleField('field-avatar', isSignup);
    profileToggleField('field-remember', !isSignup);

    const submit = document.getElementById('auth-submit');
    if (submit) submit.textContent = isSignup ? '建立帳號' : '登入';

    const password = document.getElementById('auth-password-input');
    if (password) password.setAttribute('autocomplete', isSignup ? 'new-password' : 'current-password');

    // 標題與底部切換連結（參考範例圖：Welcome back / Don't have an account yet?）
    const heroTitle = document.getElementById('auth-hero-title');
    if (heroTitle) heroTitle.textContent = isSignup ? '建立你的帳號' : '歡迎回來';
    const heroDesc = document.getElementById('auth-hero-desc');
    if (heroDesc) {
        heroDesc.textContent = isSignup
            ? '填寫以下資料，即可建立本機帳號並同步你的課表。'
            : '請輸入你的帳號資料以繼續。';
    }
    const switchText = document.getElementById('auth-switch-text');
    if (switchText) switchText.textContent = isSignup ? '已經有帳號了？' : '還沒有帳號？';
    const switchBtn = document.getElementById('auth-switch-btn');
    if (switchBtn) switchBtn.textContent = isSignup ? '立即登入' : '立即註冊';

    profileClearBad();
    profileHideAlert('auth');
}

// 登入 / 註冊 互相切換（底部連結）
function profileToggleAuthMode() {
    profileSetAuthMode(profileAuthMode === 'signup' ? 'signin' : 'signup');
}

// 密碼顯示 / 隱藏
function profileTogglePassword(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;

    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';

    if (btn) {
        btn.classList.toggle('is-on', show);
        btn.setAttribute('aria-label', show ? '隱藏密碼' : '顯示密碼');
        const host = btn.querySelector('[data-icon]');
        if (host) {
            host.setAttribute('data-icon', show ? 'eyeOff' : 'eye');
            host.innerHTML = icon(show ? 'eyeOff' : 'eye', { size: 17 });
        }
    }
}

// 本機帳號沒有伺服器，說明可行的替代做法
function profileForgotPassword() {
    profileShowAlert('auth',
        '這個 App 的帳號只儲存在本機裝置（沒有伺服器），因此無法寄送重設信。' +
        '可以改用 Google 登入，或註冊一個新帳號——舊的課表與設定都會保留。',
        'info');
}

const PROFILE_AUTH_INPUTS = ['auth-name-input', 'auth-email-input', 'auth-password-input', 'auth-confirm-input'];

function profileClearBad() {
    PROFILE_AUTH_INPUTS.forEach(id => {
        const node = document.getElementById(id);
        if (node) node.classList.remove('is-bad');
    });
}

// 前端即時驗證：非空 / 格式 / 密碼一致性，回傳第一個問題
function profileAuthProblem(payload, isSignup) {
    if (isSignup && !payload.name) return { id: 'auth-name-input', message: '請輸入姓名或帳號' };
    if (!payload.email) return { id: 'auth-email-input', message: '請輸入 Email' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return { id: 'auth-email-input', message: 'Email 格式不正確' };
    if (!payload.password) return { id: 'auth-password-input', message: '請輸入密碼' };
    if (payload.password.length < 6) return { id: 'auth-password-input', message: '密碼至少 6 個字元' };
    if (isSignup && !payload.confirm) return { id: 'auth-confirm-input', message: '請再輸入一次密碼' };
    if (isSignup && payload.confirm !== payload.password) return { id: 'auth-confirm-input', message: '兩次輸入的密碼不一致' };
    return null;
}

function profileResetAuthForm() {
    ['auth-name-input', 'auth-email-input', 'auth-password-input', 'auth-confirm-input', 'client-id-input']
        .forEach(id => { const node = document.getElementById(id); if (node) node.value = ''; });

    const remember = document.getElementById('auth-remember');
    if (remember) remember.checked = true;

    // 重設密碼可見狀態（只還原 type=password 的欄位）與錯誤標記
    ['auth-password-input', 'auth-confirm-input'].forEach(id => {
        const node = document.getElementById(id);
        if (node) node.type = 'password';
    });
    document.querySelectorAll('.auth-eye').forEach(btn => {
        btn.classList.remove('is-on');
        const host = btn.querySelector('[data-icon]');
        if (host) {
            host.setAttribute('data-icon', 'eye');
            host.innerHTML = icon('eye', { size: 17 });
        }
    });

    profileClearBad();
    profileClearAvatar();
    profileHideAlert('auth');
}

async function profileSubmitAuth() {
    const submit = document.getElementById('auth-submit');
    if (submit && submit.disabled) return;

    const isSignup = profileAuthMode === 'signup';
    const payload = {
        name: profileVal('auth-name-input'),
        email: profileVal('auth-email-input'),
        password: profileVal('auth-password-input'),
        confirm: profileVal('auth-confirm-input'),
        avatar: profileDraftAvatar,
        remember: profileChecked('auth-remember')
    };

    profileHideAlert('auth');

    // 前端先驗證（非空 / 格式 / 密碼一致），不合格就直接攔下並標紅
    const problem = profileAuthProblem(payload, isSignup);
    if (problem) {
        PROFILE_AUTH_INPUTS.forEach(id => {
            const node = document.getElementById(id);
            if (node) node.classList.toggle('is-bad', id === problem.id);
        });
        profileShowAlert('auth', problem.message, 'error');
        const focusNode = document.getElementById(problem.id);
        if (focusNode) setTimeout(() => focusNode.focus(), 0);
        return;
    }
    profileClearBad();

    if (submit) { submit.disabled = true; submit.textContent = isSignup ? '建立中…' : '登入中…'; }

    try {
        const result = isSignup
            ? await authSignUpWithEmail(payload)
            : await authSignInWithEmail(payload);

        if (!result.ok) {
            profileShowAlert('auth', result.error, 'error');
            return;
        }

        profileResetAuthForm();
        await profileAfterAuth(result.account, result.isNew);
    } catch (error) {
        console.error('[profile] 認證失敗:', error);
        profileShowAlert('auth', (error && error.message) || '發生錯誤，請再試一次', 'error');
    } finally {
        if (submit) {
            submit.disabled = false;
            submit.textContent = profileAuthMode === 'signup' ? '建立帳號' : '登入';
        }
    }
}

/* ================= Google 登入 ================= */

function profileToggleClientSetup(show) {
    const panel = document.getElementById('client-setup');
    if (!panel) return;
    panel.classList.toggle('is-on', !!show);
    if (show) {
        const origin = document.getElementById('client-origin');
        if (origin) origin.textContent = window.location.origin;
    }
}

function profileSaveClientId(clear) {
    if (clear) {
        authSetGoogleClientId('');
        profileShowAlert('auth', '已清除 Google Client ID', 'info');
        profileMountGoogle();
        return;
    }

    const value = profileVal('client-id-input');
    if (!/\.apps\.googleusercontent\.com$/i.test(value)) {
        profileShowAlert('auth', 'Client ID 格式不正確，結尾應該是 .apps.googleusercontent.com', 'error');
        return;
    }

    authSetGoogleClientId(value);
    const input = document.getElementById('client-id-input');
    if (input) input.value = '';
    profileShowAlert('auth', '已儲存，正在載入 Google 按鈕…', 'ok');
    profileMountGoogle();
}

/**
 * 掛載 Google 官方按鈕。
 * 三種結果：官方按鈕 / 自製「未設定」按鈕 / 載入失敗提示
 */
async function profileMountGoogle() {
    const slot = document.getElementById('google-slot');
    if (!slot) return;

    slot.innerHTML = '<div class="auth-hint">正在連接 Google…</div>';
    profileToggleClientSetup(false);

    let result;
    try {
        result = await authMountGoogleButton(slot, profileHandleGoogleResult);
    } catch (error) {
        result = { ok: false, reason: 'load-failed', message: error && error.message };
    }

    if (result && result.ok) return;

    const reason = result ? result.reason : 'load-failed';

    if (reason === 'no-client-id') {
        slot.innerHTML =
            '<button class="google-btn is-dim" type="button" onclick="profileToggleClientSetup(true)">' +
            GOOGLE_G_SVG + '<span>使用 Google 帳號登入</span></button>' +
            '<div class="auth-notice" role="status">' +
            '<span>Google 登入尚未啟用，可改用 Email 繼續</span>' +
            '</div>';
        return;
    }

    // GIS 腳本載入失敗 / 被攔截：不讓表單崩潰，改用 Email 一樣可以完成登入註冊
    slot.innerHTML =
        '<button class="google-btn is-dim" type="button" onclick="profileToggleClientSetup(true)">' +
        GOOGLE_G_SVG + '<span>Google 登入暫時不可用</span></button>' +
        '<div class="auth-notice auth-notice--warn" role="status">' +
        '<span>Google 服務暫時無法載入，請改用 Email</span>' +
        '</div>' +
        '<div class="auth-hint">' + profileEscape((result && result.message) || '請檢查網絡連線') + '</div>';
}

// 收到 Google 授權結果後的處理：有帳號就登入，沒有就自動註冊
function profileHandleGoogleResult(result) {
    if (!result || !result.ok) {
        profileShowAlert('auth', (result && result.error) || 'Google 登入失敗', 'error');
        return;
    }

    const profile = result.profile || {};
    const signed = authSignInWithGoogleProfile({
        sub: profile.sub,
        email: profile.email,
        name: profile.name,
        picture: profile.picture
    });

    if (!signed.ok) {
        profileShowAlert('auth', signed.error, 'error');
        return;
    }

    profileResetAuthForm();
    profileAfterAuth(signed.account, signed.isNew);
}

/* ================= 認證成功後的流程分派 ================= */

async function profileAfterAuth(account, isNew) {
    renderProfileHeader();
    profileHideAlert('auth');

    // 未有班級 → 進 Onboarding，完成前無法進入課表
    if (!account.classId) {
        profileOnboarding = true;

        // 這部裝置之前揀過班級（user_class）→ 先預選，用家撳一下就完成
        const stored = (typeof authStoredClassChoice === 'function') ? authStoredClassChoice() : null;
        if (stored && stored.reason === 'custom') {
            profileClassPickCustom = stored.className || '';
            profileClassPick = stored.classId || '';
        } else if (stored && stored.classId) {
            profileClassPick = stored.classId;
            profileClassPickCustom = '';
        } else {
            profileClassPick = '';
            profileClassPickCustom = '';
        }

        await profilePrepareClassView();
        profileShowView('class');
        profileShowAlert('class',
            isNew ? '帳號建立成功！最後一步：選擇你的班級' : '請先選擇班級，才可以載入你的課表',
            'info');
        return;
    }

    profileOnboarding = false;
    await profileApplyAccountSchedule(account);
    renderProfileHome();
    profileShowView('home');

    // 登入 / 註冊成功 → 自動關閉彈窗，回到原本的頁面
    closeProfilePanel();
    profileToast((isNew ? '歡迎加入，' : '歡迎回來，') + account.name + '！');
}

// 把「這個帳號的班級課表」交給 main.js 載入
// force = true：強制重新解析並重繪，唔受「同一份課表已載入」嘅短路影響，
//               確保切換班級一定有反應（消除「套用之後畫面冇變」嘅死鎖感）
async function profileApplyAccountSchedule(account, force) {
    if (typeof applyClassSchedule !== 'function') return null;
    try {
        return await applyClassSchedule(account, !!force);
    } catch (error) {
        console.error('[profile] 載入班級課表失敗:', error);
        return null;
    }
}

/* ================= 班級選擇（Onboarding） ================= */

async function profilePrepareClassView() {
    const groups = document.getElementById('class-groups');
    if (!groups) return;

    // 未載入，或者載入過但清單係空（例如上次讀到壞快取）→ 都重新讀一次
    if (!profileClassesLoaded || !authGetClassList().length) {
        groups.innerHTML = '<div class="auth-hint">正在載入班級清單…</div>';
        try {
            // 已經載入過但係空 = 資料有問題，強制重讀而唔用記憶體快取
            await authLoadClasses(profileClassesLoaded === true);
        } catch (e) {
            console.warn('[profile] 載入班級清單失敗:', e);
        }
        profileClassesLoaded = true;

        // 清單有變 → 順手修復帳號上已經失效嘅班級綁定
        if (typeof authRepairAccountClasses === 'function') authRepairAccountClasses();
    }

    // 依 stage（初中 / 高中）分組
    const staged = [];
    authGetClassList().forEach(cls => {
        const stage = cls.stage || '其他';
        let bucket = staged.find(item => item.name === stage);
        if (!bucket) {
            bucket = { name: stage, items: [] };
            staged.push(bucket);
        }
        bucket.items.push(cls);
    });

    groups.innerHTML = staged.map(stage =>
        '<div class="class-stage">' +
            '<div class="class-stage__label">' + profileEscape(stage.name) + '</div>' +
            '<div class="class-grid">' +
                stage.items.map(cls => {
                    // 主標題 = 中文班名（亮色）；副標題 = 英文代號（灰色小字，無填就唔顯示）
                    const code = (typeof authClassCode === 'function') ? authClassCode(cls) : (cls.code || '');
                    return '<button class="class-chip" type="button" data-class-id="' + profileEscape(cls.id) + '" ' +
                        'onclick="profilePickClass(\'' + profileEscape(cls.id) + '\')">' +
                        '<span class="class-chip__name">' + profileEscape(cls.name) + '</span>' +
                        (code ? '<span class="class-chip__code">' + profileEscape(code) + '</span>' : '') +
                        '</button>';
                }).join('') +
            '</div>' +
        '</div>'
    ).join('');

    const customCard = document.getElementById('class-custom-card');
    if (customCard) customCard.style.display = (authConfig().allowCustomClass === false) ? 'none' : '';

    const customInput = document.getElementById('class-custom-input');
    if (customInput) customInput.value = profileClassPickCustom || '';

    document.querySelectorAll('.class-chip').forEach(chip => {
        chip.classList.toggle('is-on', chip.dataset.classId === profileClassPick);
    });

    profileUpdateClassPicked();
}

function profilePickClass(classId) {
    profileClassPick = classId;
    profileClassPickCustom = '';

    const customInput = document.getElementById('class-custom-input');
    if (customInput) customInput.value = '';

    document.querySelectorAll('.class-chip').forEach(chip => {
        chip.classList.toggle('is-on', chip.dataset.classId === classId);
    });

    profileHideAlert('class');
    profileUpdateClassPicked();
}

function profileApplyCustomClass() {
    const raw = profileVal('class-custom-input');
    if (!raw) {
        profileShowAlert('class', '請先輸入班級名稱', 'error');
        return;
    }

    const input = document.getElementById('class-custom-input');

    // 1) 先試自動轉譯：英文代號（S2A / s2a / S2-A）或中文班名（初二信）。
    //    對應得到就當作揀咗該班（classId 正確），先會載入該班專屬課表。
    const matched = (typeof authResolveClassInput === 'function') ? authResolveClassInput(raw) : null;
    if (matched) {
        profilePickClass(matched.id);      // 內部會清空自訂狀態並標亮對應 chip
        const code = (typeof authClassCode === 'function') ? authClassCode(matched) : '';
        if (input) {
            input.value = matched.name;    // 回填中文班名，俾用家見到已經轉譯
            input.blur();
        }
        profileShowAlert('class', '已自動對應：' + (code ? code + ' → ' : '') + matched.name, 'ok');
        return;
    }

    // 2) 對應唔到任何班級 → 當作自訂班級處理
    profileClassPickCustom = raw.slice(0, 20);
    profileClassPick = 'custom:' + profileClassPickCustom;

    document.querySelectorAll('.class-chip').forEach(chip => chip.classList.remove('is-on'));

    if (input) input.blur();

    profileHideAlert('class');
    profileUpdateClassPicked();
}

function profileUpdateClassPicked() {
    const box = document.getElementById('class-picked');
    const nameNode = document.getElementById('class-picked-name');
    const descNode = document.getElementById('class-picked-desc');
    if (!box) return;

    let name = '';
    let desc = '';

    if (profileClassPickCustom) {
        name = profileClassPickCustom;
        desc = '自訂班級 · 會沿用預設課表';
    } else if (profileClassPick) {
        const cls = authFindClass(profileClassPick);
        if (cls) {
            name = cls.name;
            desc = cls.schedule ? '已找到專屬課表，將會自動載入' : '此班暫無專屬課表，會沿用預設課表';
        }
    }

    if (!name) {
        box.style.display = 'none';
        return;
    }

    box.style.display = 'flex';
    if (nameNode) nameNode.textContent = name;
    if (descNode) descNode.textContent = desc;
}

// 開發者面板改動班級清單後，強制重新繪製班級選擇器與主頁統計
async function profileRefreshClassList() {
    profileClassesLoaded = false;
    try {
        await profilePrepareClassView();
    } catch (e) {
        console.warn('[profile] 重新整理班級清單失敗:', e);
    }
    profileUpdateClassPicked();
    renderProfileHome();
}

async function profileConfirmClass() {
    if (!profileClassPickCustom && !profileClassPick) {
        profileShowAlert('class', '請先選一個班級', 'error');
        return;
    }

    const submit = document.getElementById('class-submit');
    if (submit) { submit.disabled = true; submit.textContent = '載入課表中…'; }

    try {
        // 1) 先寫入裝置層偏好 user_class：未登入都用得，
        //    重開 App 會直接載入同一班課表（見 authResolveSchedule）
        const pickedId = profileClassPickCustom
            ? 'custom:' + profileClassPickCustom
            : profileClassPick;
        if (typeof authSetStoredClassId === 'function') authSetStoredClassId(pickedId);

        const account = authGetCurrentAccount();

        // 2) 未登入：一樣入得課表，只影響這部裝置顯示邊班（唔涉及帳號）
        if (!account) {
            profileOnboarding = false;
            profileHideAlert('class');
            await profileApplyAccountSchedule(null, true);
            closeProfilePanel();
            const cls = (typeof authFindClass === 'function') ? authFindClass(profileClassPick) : null;
            profileToast('已設定班級：' + (profileClassPickCustom || (cls ? cls.name : pickedId)));
            return;
        }

        // 3) 已登入：同步綁定到帳號，維持「班級跟著帳號」的行為
        const result = profileClassPickCustom
            ? authBindClass(account.id, '', profileClassPickCustom)
            : authBindClass(account.id, profileClassPick, '');

        if (!result.ok) {
            profileShowAlert('class', result.error, 'error');
            return;
        }

        profileOnboarding = false;
        profileHideAlert('class');
        // force = true：班級可能同之前一樣（或者同樣冇專屬課表），
        // 但用家明確撳了套用，就一定要重新載入同重繪，唔可以短路成「冇反應」
        await profileApplyAccountSchedule(result.account, true);
        renderProfileHome();
        profileShowView('home');

        // 引導完成 → 關閉彈窗，直接看到課表
        closeProfilePanel();
        profileToast('已設定班級：' + result.account.className);
    } finally {
        if (submit) { submit.disabled = false; submit.textContent = '進入我的課表'; }
    }
}

// 由個人中心「更改班級」進入（未登入者一樣可以改：改嘅係這部裝置嘅偏好）
async function profileOpenClassPicker() {
    const account = authGetCurrentAccount();
    const stored = (typeof authStoredClassChoice === 'function') ? authStoredClassChoice() : null;

    profileOnboarding = false;

    if (!account) {
        // 未登入：以裝置層偏好（user_class）為目前的選擇
        if (stored && stored.reason === 'custom') {
            profileClassPickCustom = stored.className || '';
            profileClassPick = stored.classId || '';
        } else {
            profileClassPick = (stored && stored.classId) || '';
            profileClassPickCustom = '';
        }

        await profilePrepareClassView();
        profileShowView('class');
        return;
    }

    // 帳號綁住嘅班級若然已經唔存在於最新清單（清單被修正／換版本），
    // 就唔應該再標亮舊 chip——否則用家會以為「已經選好」，
    // 但實際上個班級根本對唔上，出現「無法再次更換班級」嘅死鎖。
    const boundClass = (!account.customClass && account.classId && typeof authFindClass === 'function')
        ? authFindClass(account.classId)
        : null;

    if (account.customClass) {
        profileClassPickCustom = account.className || '';
        profileClassPick = 'custom:' + profileClassPickCustom;
    } else if (account.classId && !boundClass) {
        // 舊班級已失效 → 先修復帳號綁定，再強制重讀清單，讓用家可以重新選
        if (typeof authRepairAccountClasses === 'function') authRepairAccountClasses();
        profileClassesLoaded = false;
        profileClassPick = '';
        profileClassPickCustom = '';
    } else {
        profileClassPick = account.classId || '';
        profileClassPickCustom = '';
    }

    // 必須 await：清單未畫好就顯示，會出現「空白清單／撳極都冇反應」嘅假死鎖
    await profilePrepareClassView();
    profileShowView('class');
}

/* ================= 個人主頁：Bento Grid ================= */

// 下個假期：由 holidaysData 取最近一個未過期的假期，繪成全寬 Banner
//   左 → 節日 Emoji 徽章 + 大字標題（下個假期：中秋節翌日）
//   右 → 高亮倒數（還有 N 天／今天開始／假期中）
function renderProfileNextHoliday() {
    const nameNode = document.getElementById('stat-holiday');
    if (!nameNode) return;

    const iconNode = document.getElementById('stat-holiday-icon');
    const dateNode = document.getElementById('stat-holiday-date');
    const leadNode = document.getElementById('stat-holiday-lead');
    const daysNode = document.getElementById('stat-holiday-days');
    const unitNode = document.getElementById('stat-holiday-unit');

    const setIcon = value => {
        if (iconNode) iconNode.innerHTML = contentIcon(value, { size: 26, fallback: 'palmtree' });
    };

    // 與假期模組一致：先歸零本地時間再算天數，避免 UTC 令倒數差一日
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const list = Array.isArray(holidaysData) ? holidaysData : [];
    const upcoming = list
        .filter(item => item && item.date)
        .map(item => {
            const start = new Date(item.date + 'T00:00:00');
            const end = new Date((item.endDate || item.date) + 'T00:00:00');
            return {
                item: item,
                start: start,
                daysLeft: Math.ceil((start - today) / 86400000),
                endsIn: Math.ceil((end - today) / 86400000)
            };
        })
        .filter(entry => entry.endsIn >= 0)          // 未結束（含今天仍在放）
        .sort((a, b) => a.daysLeft - b.daysLeft)[0];

    if (!upcoming) {
        setIcon('palmtree');
        nameNode.textContent = '暫無資料';
        if (dateNode) dateNode.textContent = '假期資料載入後自動更新';
        if (leadNode) leadNode.textContent = '';
        if (daysNode) {
            daysNode.textContent = '—';
            daysNode.classList.remove('is-text');
        }
        if (unitNode) unitNode.textContent = '';
        return;
    }

    const holiday = upcoming.item;
    const daysLeft = upcoming.daysLeft;

    setIcon(holiday.emoji || holiday.icon);
    nameNode.textContent = holiday.name || '假期';

    if (dateNode) {
        const weekday = '日一二三四五六'[upcoming.start.getDay()];
        const range = (holiday.endDate && holiday.endDate !== holiday.date)
            ? holiday.date + ' ~ ' + holiday.endDate
            : holiday.date;
        dateNode.textContent = range + '（' + weekday + '）';
    }

    const started = daysLeft <= 0;      // 已開始放假：數字改用文字，唔顯示「還有」
    if (leadNode) leadNode.textContent = started ? '' : '還有';
    if (daysNode) {
        daysNode.textContent = daysLeft < 0 ? '假期中' : daysLeft === 0 ? '今天' : String(daysLeft);
        daysNode.classList.toggle('is-text', started);
    }
    if (unitNode) unitNode.textContent = started ? (daysLeft < 0 ? '' : '開始') : '天';
}

function renderProfileHome() {
    const account = authGetCurrentAccount();
    if (!account) return;

    const avatar = document.getElementById('profile-hero-avatar');
    if (avatar) avatar.src = profileAvatarSrc(account);

    const nameNode = document.getElementById('profile-hero-name');
    if (nameNode) nameNode.textContent = account.name;

    const metaNode = document.getElementById('profile-hero-meta');
    if (metaNode) {
        const pad = value => String(value).padStart(2, '0');
        const joined = new Date(account.createdAt || Date.now());
        const parts = [authProviderLabel(account.provider)];
        if (account.email) parts.push(account.email);
        parts.push('加入於 ' + joined.getFullYear() + '/' + pad(joined.getMonth() + 1) + '/' + pad(joined.getDate()));
        metaNode.textContent = parts.join(' · ');
    }

    const providerPill = document.getElementById('profile-provider-pill');
    if (providerPill) {
        providerPill.textContent = account.provider === 'google' ? 'Google 帳號' : 'Email 帳號';
        providerPill.classList.toggle('tag-pill--live', account.provider === 'google');
    }

    const classPill = document.getElementById('profile-class-pill');
    if (classPill) {
        classPill.textContent = account.className || '未設定班級';
        classPill.classList.toggle('class-badge--muted', !account.className);
    }

    renderProfileNextHoliday();
}

/* ================= 切換帳號清單 ================= */

function renderAccountsList() {
    const list = document.getElementById('profile-accounts-list');
    if (!list) return;

    const current = authGetCurrentAccount();

    const items = authGetAccounts().map(account => {
        const isCurrent = !!(current && current.id === account.id);
        const meta = [authProviderLabel(account.provider)];
        if (account.email) meta.push(account.email);
        meta.push(account.className || '未選班級');

        return '<button class="acc-item' + (isCurrent ? ' is-current' : '') + '" type="button" ' +
            'onclick="profileSwitchAccount(\'' + account.id + '\')">' +
            '<img class="acc-item__avatar" src="' + profileAvatarSrc(account) + '" alt="">' +
            '<span class="acc-item__info">' +
                '<span class="acc-item__name"><span>' + profileEscape(account.name) + '</span>' +
                (isCurrent ? '<span class="tag-pill tag-pill--live">使用中</span>' : '') + '</span>' +
                '<span class="acc-item__meta">' + profileEscape(meta.join(' · ')) + '</span>' +
            '</span>' +
            '<span class="acc-item__check">' +
            (isCurrent ? icon('check', { size: 15 }) : icon('chevronRight', { size: 15 })) + '</span>' +
            (isCurrent ? '' :
                '<span class="acc-item__remove" title="移除此帳號" ' +
                'onclick="profileRemoveAccount(\'' + account.id + '\', event)">' +
                icon('close', { size: 13 }) + '</span>') +
            '</button>';
    }).join('');

    list.innerHTML = items +
        '<button class="acc-item acc-item--add" type="button" onclick="profileStartNewAccount()">' +
        '<span class="acc-item__icon">' + icon('plus', { size: 15 }) + '</span>新增帳號</button>';
}

async function profileSwitchAccount(accountId) {
    const current = authGetCurrentAccount();
    if (current && current.id === accountId) {
        renderProfileHome();
        profileShowView('home');
        return;
    }

    const result = authSwitchAccount(accountId, true);
    if (!result.ok) {
        profileToast(result.error);
        return;
    }

    renderProfileHeader();

    // 切到的帳號若還沒選班級，一樣要走引導
    if (!result.account.classId) {
        profileOnboarding = true;
        profileClassPick = '';
        profileClassPickCustom = '';
        await profilePrepareClassView();
        profileShowView('class');
        return;
    }

    profileOnboarding = false;
    await profileApplyAccountSchedule(result.account);
    renderProfileHome();
    profileShowView('home');
    profileToast('已切換到 ' + result.account.name);
}

async function profileRemoveAccount(accountId, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }

    if (!authRemoveAccount(accountId)) return;

    renderProfileHeader();
    const current = authGetCurrentAccount();

    if (current) {
        renderAccountsList();
        profileShowView('accounts');
    } else {
        // 全部帳號都清光了 → 課表退回預設
        await profileApplyAccountSchedule(null);
        profileResetAuthForm();
        profileSetAuthMode('signin');
        profileOnboarding = false;
        profileShowView(authGetAccounts().length ? 'accounts' : 'auth');
        if (!authGetAccounts().length) profileMountGoogle();
        else renderAccountsList();
    }

    profileToast('已移除帳號');
}

function profileStartNewAccount() {
    profileOnboarding = false;
    profileResetAuthForm();
    profileSetAuthMode('signup');
    profileShowView('auth');
    profileMountGoogle();

    const nameInput = document.getElementById('auth-name-input');
    if (nameInput) setTimeout(() => nameInput.focus(), 260);
}

async function profileLogout() {
    authSignOut();
    renderProfileHeader();

    await profileApplyAccountSchedule(null);

    profileResetAuthForm();
    profileSetAuthMode('signin');
    profileOnboarding = false;
    profileShowView('auth');
    profileMountGoogle();
    profileToast('已登出帳號');
}

function openProfileAccounts() {
    renderAccountsList();
    profileShowView('accounts');
}

// 專案展示牆：跳去對應分頁
function profileGoTab(pageId) {
    if (typeof switchTab === 'function') switchTab(pageId);
    const overlay = document.getElementById('profile-overlay');
    if (overlay) overlay.classList.remove('active');
}

/* ================= 初始化 ================= */

function initProfile() {
    authInit();
    renderProfileHeader();

    const overlay = document.getElementById('profile-overlay');
    const fileInput = document.getElementById('profile-avatar-file');

    if (fileInput) fileInput.addEventListener('change', profileHandleAvatarPick);

    // 表單提交：Enter 鍵與「登入 / 註冊」按鈕共用同一條路徑
    const authForm = document.getElementById('auth-form');
    if (authForm) {
        authForm.addEventListener('submit', event => {
            event.preventDefault();          // 純前端 PWA：阻止頁面重載，交由 JS 處理
            profileSubmitAuth();
        });
    }

    if (overlay) {
        // 只有點在遮罩本身（面板以外）才關閉
        overlay.addEventListener('click', event => {
            if (event.target === overlay) closeProfilePanel();
        });
    }

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        const panel = document.getElementById('profile-overlay');
        if (!panel || !panel.classList.contains('active')) return;

        const active = document.activeElement;
        if (active && active.tagName === 'INPUT') { active.blur(); return; }

        closeProfilePanel();
    });

    profileSetAuthMode('signin');

    // 開機時：仲未有班級（首次開啟 / 未登入 / 帳號未綁班級）
    // → 立即開引導選班，絕對唔會預設顯示某個班級（例如 S2A）嘅課表
    const account = authGetCurrentAccount();
    if (profileNeedsClassChoice(account)) {
        setTimeout(() => openProfilePanel('class'), 420);
    } else if (account) {
        profileApplyAccountSchedule(account);
    }
}