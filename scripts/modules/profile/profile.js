// ============================================================
// 用戶介面層：登入 / 註冊 / 班級引導 / 個人中心
// 認證邏輯一律委託 auth.js，這裡只負責畫面與互動
// ============================================================

const PROFILE_AVATAR_MAX = 320;   // 頭像壓縮後的最長邊（px）

// 名稱下方第三行：用戶自訂 Handle 與電郵都冇時，退回這句簡短狀態
const PROFILE_HANDLE_FALLBACK = 'Hey there! I am using PCMS Timetable.';

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

/**
 * 帳號 → 可安全放進 <img src="…"> 的頭像字串。
 *
 * ⚠ 為什麼一定要在這裡把關（而不是只在寫入雲端時）：
 *   本函式有四個呼叫點，其中三個係 innerHTML 字串拼接
 *   （header-user__avatar / acc-item__avatar ×2）。頭像值若含雙引號，
 *   就可以跳出 src 屬性注入任意標籤 —— XSS。
 *   值嘅來源唔止雲端：Console、匯入備份、舊版本殘留資料都會寫入本機，
 *   所以只喺雲端邊界淨化係唔夠嘅，渲染前必須再確認一次。
 *
 * ⚠ 單一真相：scheme 白名單只有一份，在 cloud.js 的 sbCleanAvatar()。
 *   這裡只負責「呼叫它」＋「唔通過就退回姓名首字母 SVG」，
 *   避免同一套規則在兩個檔案各寫一次而日後走樣。
 *   （cloud.js 在 index.html 中排在 profile.js 之前，故必定已載入。）
 */
function profileAvatarSrc(account) {
    if (!account) return profileInitialAvatar('?');
    const raw = account.avatar || account.avatarUrl;
    if (!raw) return profileInitialAvatar(account.name);
    const safe = (typeof sbCleanAvatar === 'function') ? sbCleanAvatar(raw) : '';
    return safe || profileInitialAvatar(account.name);
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
    accounts: 'profile-view-accounts',
    // 帳戶次頁面（WhatsApp 設定頁架構）：
    //   account = 帳戶列表頁（固定 DOM，見 index.html 狀態 5）
    //   detail  = 所有子頁面共用嘅容器（內容由 profilePushDetail() 注入）
    account: 'profile-view-account',
    detail: 'profile-view-detail'
};

const PROFILE_VIEW_TITLES = {
    auth: '登入 / 註冊',
    class: '選擇班級',
    home: '個人中心',
    accounts: '切換帳號',
    account: '帳戶'
    // ⚠ detail 冇固定標題：每個子頁面都唔同，由 profilePushDetail() 逐次傳入
};

/* ================= 次頁面導覽堆疊（Push / Pop） =================
   舊寫法：帳戶相關子頁面全部用 #ios-sheet 模態抽屜彈出，一開就係一堆欄位，
           閂咗之後亦冇上下文可返。
   新寫法：依 WhatsApp 設定頁做「次級頁面」——
           列表頁推入內容頁，返回鍵逐層彈返出嚟（detail → account → home）。
   堆疊每個元素都係「一頁嘅快照」，所以 detail 再推入 detail（例如
   安全通知 → 密碼）都可以正確返到上一頁，唔會跳層。 */

/** @type {Array<{view: string, detailKey: string, more: Function|null}>} */
let profileViewStack = [];

/** 目前 detail 子頁面嘅 key（對應 PROFILE_DETAIL_PAGES），'' = 未開啟 */
let profileDetailKey = '';

/** 目前頁面右上角「⋯」嘅動作；null = 唔顯示「⋯」 */
let profileCurrentMore = null;

/** 目前頁面嘅快照（入棧用） */
function profilePageSnapshot() {
    return {
        view: profileView,
        detailKey: profileDetailKey,
        more: profileCurrentMore
    };
}

/**
 * 切換視圖。
 * @param {string} view    PROFILE_VIEW_NODES 嘅 key
 * @param {string} [title] detail 子頁面專用標題（其餘視圖一律用固定標題）
 */
function profileShowView(view, title) {
    profileView = view;

    // 離開個人主頁就還原搜尋：否則下次入返嚟只見到「上次搜尋剩低嘅幾行」，
    // 用戶會以為設定唔見咗。
    if (view !== 'home' && typeof profileResetSettingsSearch === 'function') {
        profileResetSettingsSearch();
    }

    Object.keys(PROFILE_VIEW_NODES).forEach(key => {
        const node = document.getElementById(PROFILE_VIEW_NODES[key]);
        if (!node) return;
        const on = key === view;
        // 同時加 is-on 與 active：CSS 兩邊都認，避免類名不一致令視圖隱形
        node.classList.toggle('is-on', on);
        node.classList.toggle('active', on);
    });

    const titleText = title || PROFILE_VIEW_TITLES[view] || '';

    const titleNode = document.getElementById('profile-topbar-title');
    if (titleNode) titleNode.textContent = titleText;

    // 帳戶列表頁與其子頁面合稱「次頁面」
    const isSubPage = view === 'account' || view === 'detail';

    /* ---------- 全螢幕次頁面層（.sub-page）開關 ----------
       次頁面係「螢幕中嘅螢幕」：自己一條 44px 導覽列（左 ‹ 返回、中間標題
       絕對居中、右 ⋯），自己一個捲動容器（.sub-page__body）。
       動畫完全交畀 CSS（transform: translateX(100%) → 0），
       JS 只切 .is-on —— 唔喺 JS 寫 transform，避免兩處爭住控制同一屬性，
       亦令「減少動態效果」嘅 CSS 媒體查詢可以一併覆蓋轉場。 */
    const subPage = document.getElementById('profile-subpage');
    if (subPage) {
        subPage.classList.toggle('is-on', isSubPage);
        // 收埋時要對輔助技術隱藏，否則螢幕閱讀器仍然會讀到整頁內容
        subPage.setAttribute('aria-hidden', isSubPage ? 'false' : 'true');
    }

    // 次頁面導覽列標題（同 .profile-topbar__title 共用同一份文字，
    // 只係掛喺唔同層：次頁面用自己條 bar，主頁／登入頁用面板頂部條 bar）
    const subTitle = document.getElementById('subpage-title');
    if (subTitle) subTitle.textContent = titleText;

    // ⚠ 離開次頁面一定要清走「⋯」：否則返到主頁之後個掣仲喺度，
    //   而佢記住嘅仍然係上一個子頁面嘅動作，就會變成一個做錯事嘅掣。
    if (!isSubPage) profileCurrentMore = null;

    // 次頁面導覽列右側「⋯」：依 WhatsApp 慣例，右側係「⋯」而唔係「×」。
    // 冇任何動作時一律隱藏，唔會留低一個撳完冇反應嘅掣。
    const subMore = document.getElementById('subpage-more');
    if (subMore) {
        subMore.style.display =
            (isSubPage && typeof profileCurrentMore === 'function') ? 'flex' : 'none';
    }

    // ⚠ 面板頂部條 bar 嘅返回掣只服務「非次頁面」（切換帳號清單、未完成引導嘅選班頁）。
    //   次頁面有自己嘅 #subpage-back，若兩粒「‹」同時存在就係兩套導覽語言。
    const back = document.getElementById('profile-back');
    if (back) {
        const needBack = !isSubPage && (view === 'accounts' ||
            (view === 'class' && !profileOnboarding));
        back.style.display = needBack ? 'flex' : 'none';
        // 原本 HTML 寫死「返回登入」，去到其他頁就完全唔啱
        back.setAttribute('aria-label', '返回');
    }

    // 關閉鍵：主頁／登入頁一律保留（連引導流程都唔可以鎖住用戶）；
    // 次頁面讓位畀自己嘅「‹」返回，要離開可以按返回鍵或點背景。
    const close = document.getElementById('profile-close');
    if (close) close.style.display = isSubPage ? 'none' : 'flex';

    const scroll = document.getElementById('profile-scroll');
    if (scroll) scroll.scrollTop = 0;

    // 次頁面嘅捲動容器係 .sub-page__body，唔係 .profile-scroll。
    // ⚠ 唔重設就會出現「推入另一頁之後，畫面仍停喺上一頁捲到嘅位置」。
    const subBody = document.getElementById('subpage-body');
    if (subBody) subBody.scrollTop = 0;
}

/**
 * 推入一層次頁面（Push）。
 * @param {string} view 'account' 或 'detail'
 * @param {Object} [options] { title, detailKey, more }
 */
function profilePushView(view, options) {
    const opts = options || {};

    // 記住「而家呢一頁」嘅完整狀態，返回時原樣還原
    profileViewStack.push(profilePageSnapshot());

    profileCurrentMore = (typeof opts.more === 'function') ? opts.more : null;

    if (view === 'detail') {
        profileDetailKey = opts.detailKey || '';
        profileRenderDetail(profileDetailKey);
    }

    profileShowView(view, opts.title);
}

/** 推入指定子頁面（key 見 PROFILE_DETAIL_PAGES）。未知 key 一律唔開，唔會出空白頁。 */
function profilePushDetail(key) {
    const page = PROFILE_DETAIL_PAGES[key];
    if (!page) return;

    // 所有子頁面都係「帳號設定」：未登入時唔應該推入（否則每一頁都要各自處理 null）
    if (!authGetCurrentAccount()) {
        profileToast('請先登入帳號');
        return;
    }

    profilePushView('detail', { title: page.title, detailKey: key, more: page.more });
}

/** 目前頁面右上角「⋯」被按下 */
function profileMoreAction() {
    if (typeof profileCurrentMore === 'function') profileCurrentMore();
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

    // 每次重新打開都要由頂層開始：面板有機會唔係經 closeProfilePanel() 關閉
    // （例如 profileGoTab() 直接移除 .active），若果唔喺呢度清，
    // 上次嘅瀏覽歷史會殘留，返回鍵就會跳去上次睇過嘅子頁面。
    profileViewStack = [];

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

    // 帳戶次頁面：由外部直接開啟時要一併準備內容同「⋯」動作，
    // 否則會少咗個選單，而且三行狀態會停在上次嘅舊值。
    if (target === 'account') {
        renderProfileAccount();
        profileCurrentMore = profileAccountMore;
    }

    profileShowView(target);
}

function closeProfilePanel(event) {
    if (event && event.target !== event.currentTarget) return;

    // ⚠ 舊版要在這裡先收起子頁面抽屜（否則會殘留喺面板上面）；
    //   抽屜已刪除，子頁面同面板一樣只係 .active 切換，唔會殘留。
    // 順手還原設定搜尋：搜尋是「臨時動作」，唔應該跨次開啟殘留
    if (typeof profileResetSettingsSearch === 'function') profileResetSettingsSearch();

    // 清空次頁面堆疊：下次打開個人中心應該由頂層開始，
    // 唔應該帶著上次嘅瀏覽歷史（否則返回鍵會去返上次睇過嘅子頁面）。
    profileViewStack = [];
    profileDetailKey = '';
    profileCurrentMore = null;

    const overlay = document.getElementById('profile-overlay');
    if (overlay) overlay.classList.remove('active');

    // ⚠ 次頁面層要一併「即時」重設返泊喺螢幕右邊外面。
    //   面板一收，.sub-page 亦跟住被 overflow: hidden 裁走，所以呢度
    //   唔需要播滑出動畫；但如果唔清 .is-on，下次打開（例如直接去主頁）
    //   就會見到上一次嗰頁子頁面由右邊滑走 —— 用戶會以為自己開錯頁。
    const subPage = document.getElementById('profile-subpage');
    if (subPage) {
        subPage.classList.remove('is-on');
        subPage.setAttribute('aria-hidden', 'true');
    }

    // 引導尚未完成時只提示，仍然允許關閉（否則使用者會被永久困在彈窗內）
    if (profileOnboarding) profileToast('還沒選班級，可隨時點右上角頭像回來完成');
}

function profileBackView() {
    // 先彈次頁面堆疊：detail → account → home 逐層返，唔會一次過跳返主頁。
    // 還原時連標題、內容同「⋯」動作一齊還原，唔會出現「上一步」變咗另一頁。
    if (profileViewStack.length) {
        const prev = profileViewStack.pop();
        profileCurrentMore = prev.more || null;
        profileDetailKey = prev.detailKey || '';
        let title = '';

        if (prev.view === 'detail') {
            profileRenderDetail(profileDetailKey);
            title = (PROFILE_DETAIL_PAGES[profileDetailKey] || {}).title || '';
        } else if (prev.view === 'account') {
            // 帳戶列表頁永遠有「⋯」，而且子標題要反映最新資料
            renderProfileAccount();
            profileCurrentMore = profileAccountMore;
        }

        profileShowView(prev.view, title);
        return;
    }

    // 堆疊係空：即係由外部直接入到子頁面（例如 openProfilePanel('account')），
    // 一律當作返上一層頂層視圖。
    if (profileView === 'class') {
        if (profileOnboarding) return;
        profileShowView(authGetCurrentAccount() ? 'home' : 'auth');
        return;
    }
    if (profileView === 'accounts' || profileView === 'account' || profileView === 'detail') {
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
        '可以註冊一個新帳號——舊的課表與設定都會保留。',
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
    // 長度下限與 auth.js 的 authPasswordCheck() 共用同一個來源，
    // 避免前端提示「至少 6 個字元」但實際要求 8 個咁前後矛盾。
    const minLength = typeof authPasswordMinLength === 'function' ? authPasswordMinLength() : 6;
    if (payload.password.length < minLength) {
        return { id: 'auth-password-input', message: '密碼至少 ' + minLength + ' 個字元' };
    }
    if (isSignup && !payload.confirm) return { id: 'auth-confirm-input', message: '請再輸入一次密碼' };
    if (isSignup && payload.confirm !== payload.password) return { id: 'auth-confirm-input', message: '兩次輸入的密碼不一致' };
    return null;
}

function profileResetAuthForm() {
    ['auth-name-input', 'auth-email-input', 'auth-password-input', 'auth-confirm-input']
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

            // 雲端明確話冇呢個帳號 → 額外用 Toast 點明下一步要做咩
            if (result.reason === 'NO_ACCOUNT') {
                profileToast('帳號不存在，請先切換至註冊');
            }
            // 帳號建立了但未完成信箱驗證 → 唔算登入成功，要清楚指示下一步
            if (result.reason === 'NO_CONFIRM') {
                profileToast('請到信箱點擊確認連結後再登入');
            }
            // 逾時／連線失敗 → 講明已轉離線，避免用戶誤以為自己打錯密碼
            if (result.reason === 'TIMEOUT' || result.offline) {
                // 真正切換狀態標籤。否則「已切換至離線模式」只係一句空話。
                // cloudSetPhase 會經 cloudSubscribe 的既有訂閱自動觸發 renderCloudPill()，
                // 唔需要（亦唔應該）在這裡重複呼叫。
                if (typeof cloudSetPhase === 'function') cloudSetPhase('offline');
                profileToast('雲端連線逾時，已切換至離線模式');
            }
            return;
        }

        // 註冊成功但 Supabase 要求先驗證信箱 → 未有 session，唔可以當作已登入
        if (result.pendingConfirmation) {
            profileResetAuthForm();
            profileShowAlert('auth', '確認信已寄到 ' + (result.email || payload.email) + '，請點擊信中連結後再登入', 'ok');
            profileToast('請到信箱完成驗證後再登入');
            return;
        }

        profileResetAuthForm();
        renderCloudPill();

        // 離線登入（本機快取放行）→ 明確提示目前係離線狀態
        if (result.offlineFallback) {
            if (typeof cloudSetPhase === 'function') cloudSetPhase('offline');
            renderCloudPill();
            profileToast(result.offlineNoVerify
                ? '離線模式：已用本機登入憑證進入，連線後會自動校驗'
                : '雲端連線逾時，已切換至離線模式');
        }

        await profileAfterAuth(result.account, result.isNew);
    } catch (error) {
        console.error('[profile] 認證失敗:', error);
        profileShowAlert('auth', (error && error.message) || '發生錯誤，請再試一次', 'error');
    } finally {
        // ⚠ 不論成功、失敗還是拋出例外，按鈕都必須恢復可點擊。
        // 用提交當下捕獲的 isSignup 而唔係 profileAuthMode：
        // 登入成功後流程可能已切換表單模式，讀即時值會令按鈕文字出錯。
        if (submit) {
            submit.disabled = false;
            submit.textContent = isSignup ? '建立帳號' : '登入';
        }
    }
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

/**
 * 由 holidaysData 取出「最近一個未結束嘅假期」（含今日仍在放）。
 * 冇資料或已經冇未結束嘅假期 → null。
 *
 * ⚠ 與假期模組一致：先歸零本地時間再算天數，避免 UTC 令倒數差一日。
 * 狀態氣泡（profileStatusNow）同「下個假期」Banner 都經呢個函式取值，
 * 兩處永遠唔會各計一套而講出唔同嘅嘢。
 */
function profileUpcomingHoliday() {
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

    return upcoming || null;
}

/**
 * 頂部狀態氣泡要顯示嘅即時狀態。
 *
 * ⚠ 呢個唔可以寫死：App 未有「自訂狀態」後台，硬寫一句假狀態（例如參考圖嘅
 *   "Cycling"）就等於用 UI 講一個唔存在嘅功能。所以改為依真實資料即時計算：
 *     1. 今日仍在放假期 → 假期中 · 中秋節翌日
 *     2. 正在上課       → 上課中 · 第 3 節 數學
 *     3. 今日有課未上   → 下一節 · 12 分鐘後
 *     4. 今日課堂已完   → 今日已落堂
 *     5. 今日冇課       → 今日無課
 *   回傳 { icon, text }；icon 一律用既有 SVG 圖示（全站嚴禁 Emoji）。
 */
function profileStatusNow() {
    const holiday = profileUpcomingHoliday();
    if (holiday && holiday.daysLeft <= 0) {
        return {
            icon: holiday.item.emoji || holiday.item.icon || 'palmtree',
            text: '假期中' + (holiday.item.name ? ' · ' + holiday.item.name : '')
        };
    }

    const now = new Date();
    const secs = (now.getHours() * 3600) + (now.getMinutes() * 60) + now.getSeconds();
    const toSecs = value => {
        const parts = String(value === undefined || value === null ? '' : value).split(':');
        const h = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        return (isNaN(h) || isNaN(m)) ? NaN : (h * 3600) + (m * 60);
    };

    const list = (typeof scheduleData !== 'undefined' && scheduleData && scheduleData[now.getDay()]) || [];
    if (!list.length) return { icon: 'moon', text: '今日無課' };

    // 1) 正在上課（end 為開區間：落堂嗰一刻即轉為下一種狀態）
    for (let i = 0; i < list.length; i++) {
        const cls = list[i] || {};
        const start = toSecs(cls.start);
        const end = toSecs(cls.end);
        if (!isNaN(start) && !isNaN(end) && secs >= start && secs < end) {
            const period = cls.period ? '第 ' + cls.period + ' 節' : '課堂';
            return { icon: 'book', text: '上課中 · ' + period + (cls.subject ? ' ' + cls.subject : '') };
        }
    }

    // 2) 下一節：未開始嘅最近一節
    let next = null;
    list.forEach(cls => {
        const start = toSecs((cls || {}).start);
        if (isNaN(start) || start <= secs) return;
        if (!next || start < toSecs(next.start)) next = cls;
    });
    if (next) {
        const mins = Math.max(1, Math.round((toSecs(next.start) - secs) / 60));
        return { icon: 'clock', text: '下一節 · ' + mins + ' 分鐘後' };
    }

    return { icon: 'checkCircle', text: '今日已落堂' };
}

/** 把 profileStatusNow() 嘅結果寫入狀態氣泡（唯讀顯示，唔係掣） */
function renderProfileStatus() {
    const textNode = document.getElementById('wa-status-text');
    if (!textNode) return;

    const status = profileStatusNow();
    textNode.textContent = status.text;

    const iconNode = document.getElementById('wa-status-icon');
    if (iconNode) {
        // 直接寫 SVG：狀態會隨時間改變，唔可以只靠 data-icon 嘅一次性水合
        iconNode.innerHTML = (typeof icon === 'function')
            ? icon(status.icon, { size: 15, fallback: 'clock' })
            : '';
    }
}

/**
 * 決定 Header 名稱下方第三行顯示咩。
 *   1. 用戶自訂 Handle（account.handle / account.username）→ 顯示 @handle
 *   2. 冇自訂 Handle，但有電郵 → 直接顯示「完整電郵地址」
 *      （唔會再自行截取 @ 前面當成 handle，避免出現 @lampkengkking 呢種假 handle）
 *   3. 兩者都冇 → 退回一句簡短狀態文字（PROFILE_HANDLE_FALLBACK）
 * ⚠ 純顯示用：唔會寫入帳號、唔會上雲，亦唔係登入憑證。
 */
function profileHandleText(account) {
    if (!account) return PROFILE_HANDLE_FALLBACK;

    // 1. 用戶自訂 Handle 優先：去掉開頭多餘嘅 @ 與不合法字元
    const raw = String(account.handle || account.username || '')
        .trim().replace(/^@+/, '').toLowerCase();
    const handle = raw.replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+|[._-]+$/g, '');
    if (handle) return '@' + handle;

    // 2. 備用（方案 A）：完整電郵，唔加 @、唔截斷
    const email = String(account.email || '').trim().toLowerCase();
    if (email) return email;

    // 3. 最後備用（方案 B）：簡短狀態
    return PROFILE_HANDLE_FALLBACK;
}

/* ---------- 設定搜尋（頂部放大鏡）：純前端過濾現有選單，唔會發任何請求 ---------- */

/** 展開／收起設定搜尋列；展開時聚焦輸入框 */
function profileToggleSettingsSearch() {
    const bar = document.getElementById('wa-search-bar');
    const btn = document.getElementById('wa-search-btn');
    if (!bar) return;

    const opening = bar.hasAttribute('hidden');
    if (opening) {
        bar.removeAttribute('hidden');
        const input = document.getElementById('wa-search-input');
        if (input) input.focus();
    } else {
        profileClearSettingsSearch();
    }

    if (btn) {
        btn.classList.toggle('is-on', opening);
        btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
    }
}

/** 依關鍵字過濾個人主頁嘅選單項目；完全冇命中時顯示提示 */
function profileFilterSettings(query) {
    const home = document.querySelector('#profile-view-home .ios-home');
    if (!home) return;

    const keyword = String(query || '').trim().toLowerCase();

    let hits = 0;
    home.querySelectorAll('.ios-row').forEach(row => {
        const matched = !keyword || (row.textContent || '').toLowerCase().indexOf(keyword) !== -1;
        row.style.display = matched ? '' : 'none';
        if (matched) hits++;
    });

    // 整張卡片都冇命中 → 連卡片一齊收起，免得留低一格格格嘅空白圓角底
    home.querySelectorAll('.ios-card').forEach(card => {
        const visible = Array.prototype.some.call(
            card.querySelectorAll('.ios-row'),
            row => row.style.display !== 'none'
        );
        card.style.display = visible ? '' : 'none';
    });

    // 搜尋期間收起身份資訊（狀態氣泡／大頭像／名稱／handle）：
    // 呢刻用戶係想搵設定，唔需要再佔一屏身份資訊。
    // ⚠ 唔可以連 .wa-head 一齊收：搜尋列本身喺 .wa-head 入面，
    //   收咗 .wa-head 就會連輸入框都收埋，變成一個睇唔到嘅搜尋。
    const head = home.querySelector('.wa-head');
    if (head) {
        head.querySelectorAll('.wa-avatar, .wa-name, .wa-handle').forEach(node => {
            node.style.display = keyword ? 'none' : '';
        });
    }

    const empty = document.getElementById('wa-search-empty');
    if (empty) {
        const word = document.getElementById('wa-search-empty-word');
        if (word) word.textContent = query;
        if (keyword && hits === 0) empty.removeAttribute('hidden');
        else empty.setAttribute('hidden', '');
    }
}

/** 清除搜尋字並還原所有項目（收起搜尋列時同步呼叫） */
function profileClearSettingsSearch() {
    const bar = document.getElementById('wa-search-bar');
    const input = document.getElementById('wa-search-input');
    if (input) input.value = '';
    if (bar) bar.setAttribute('hidden', '');
    profileFilterSettings('');

    const btn = document.getElementById('wa-search-btn');
    if (btn) {
        btn.classList.remove('is-on');
        btn.setAttribute('aria-expanded', 'false');
    }
}

/** 離開個人主頁時還原：唔想下次入返嚟只見到「上次搜尋剩低嘅幾行」 */
function profileResetSettingsSearch() {
    const bar = document.getElementById('wa-search-bar');
    if (!bar || bar.hasAttribute('hidden')) return;
    profileClearSettingsSearch();
}

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

    // 日期計算已抽去 profileUpcomingHoliday()：狀態氣泡同 Banner 共用同一套邏輯
    const upcoming = profileUpcomingHoliday();

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
    if (avatar) {
        avatar.src = profileAvatarSrc(account);
        avatar.alt = (account.name || '用戶') + ' 的頭像';
    }

    const nameNode = document.getElementById('profile-hero-name');
    if (nameNode) nameNode.textContent = account.name;

    // 第三行：@handle（有自訂 Handle 才顯示 @handle，否則顯示完整電郵）
    const handleNode = document.getElementById('profile-hero-handle');
    if (handleNode) handleNode.textContent = profileHandleText(account);

    // 狀態氣泡：依「現在時間 + 今日課表 + 假期」即時計算
    renderProfileStatus();

    // ⚠ 舊版喺呢度會填 #profile-hero-meta（供應商 · 電郵 · 加入日期）同
    //   #profile-provider-pill。新 Header 依 WhatsApp 只保留「名稱 + @handle」，
    //   電郵、供應商同註冊時間仍然可以在「你的帳號」子頁面睇到，冇資料遺失。

    // ⚠ 主選單每一行已經冇灰色副標題（極簡化：只保留一行主標題），
    //   所以唔再需要在每次重繪時填狀態文字；renderProfileMenu() 已刪除。

    renderCloudPill();
    renderProfileNextHoliday();
}

/* ================= 選單卡片狀態（iOS 分組卡片） ================= */

/**
 * 目前主題（'dark' | 'light'）。
 *
 * ⚠ 兩個必須留意的實作細節：
 *   1. 一定要用原生 localStorage.getItem，唔可以用 Storage.get()。
 *      theme.js 係用原生 localStorage.setItem('theme', newTheme) 寫入「純字串」，
 *      而 Storage.get() 會 JSON.parse —— 'dark' 唔係合法 JSON 會拋錯被 catch，
 *      結果永遠回傳 null，主題文字就會永遠顯示錯。
 *   2. 一定要讀 localStorage 而唔係 document.documentElement 嘅 data-theme：
 *      toggleTheme() 有 200ms 過場動畫，屬性要動畫完才真正換過去，
 *      但 localStorage 係即時寫入嘅（theme.js）。讀 DOM 屬性會慢一步。
 */
function profileCurrentTheme() {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark' || saved === 'light') return saved;
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark' || attr === 'light') return attr;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
        ? 'dark' : 'light';
}

/* ⚠ 原 profileThemePreference() 已刪除：
   佢同 theme.js 嘅 themePreference() 係同一支邏輯嘅兩份實作（連 'auto' 同
   「未設定過」嘅 fallback 都各寫一次）。外觀子頁面改為直接呼叫
   themePreference()，全 App 只有一個地方解析 localStorage['theme']。 */



/** 安全寫入卡片項目右側狀態文字（項目若被移除亦唔會拋錯） */
function profileSetSub(id, text) {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
}

/* ⚠ renderProfileMenu() 已刪除：
   主選單（#profile-view-home）每一行嘅灰色副標題已全部移除 —— 依設計要求
   每個項目只保留一行主標題，行高收斂成 iOS 標準單行（.ios-row 嘅 min-height 52px），
   所以已經冇任何右側狀態文字需要填。相關嘅 profileThemeLabel() 亦一併刪除。
   ⚠ profileSetSub() 保留：帳戶次頁面（#profile-view-account）嘅行仍然會用到。 */

/* ================= 外觀（標準次頁面，唔再係 Modal 抽屜） =================
   舊版 profileOpenAppearance() 係一個 Modal 抽屜，上下各掛一段解釋文字
   （「此設定只儲存在這部裝置」／「跟隨系統時…」）。依設計要求改成次頁面：
     · 入口改為 profilePushDetail('appearance')，由 #profile-view-detail 推入，
       頂部有標準「‹ 返回」導覽列，同密碼／電郵等子頁面完全一致；
     · 卡片內只有三個選項，零解釋文字 —— 選項名稱本身已經係最清楚嘅說明，
       原生設定頁講求極簡直覺（WhatsApp／iOS 都冇喺單選清單上下加小字）。 */

/** 一列「單選項」：整列可撳，右側圓形剔號只有選中時才亮起 */
function profileChoiceRowHtml(label, on, handler) {
    return '<button class="ios-choice' + (on ? ' is-on' : '') + '" type="button" ' +
        'role="radio" aria-checked="' + (on ? 'true' : 'false') + '" ' +
        'onclick="' + handler + '">' +
        '<span class="ios-choice__label">' + profileEscape(label) + '</span>' +
        '<span class="ios-choice__mark" data-icon="check" data-icon-size="12"></span>' +
        '</button>';
}

/** 外觀子頁面：一張卡片、三個互斥選項（淺色 / 深色 / 跟隨系統） */
function profileDetailAppearanceHtml() {
    // ⚠ 讀 theme.js 嘅 themePreference()，唔自己再 parse 一次 localStorage：
    //   'auto' 同「完全未設定過」嘅分別只有 theme.js 知，兩處各寫一套必然走音。
    const current = (typeof themePreference === 'function') ? themePreference() : 'auto';

    return profileListCardHtml([
        profileChoiceRowHtml('淺色', current === 'light', "profileSetTheme('light')"),
        profileChoiceRowHtml('深色', current === 'dark', "profileSetTheme('dark')"),
        profileChoiceRowHtml('跟隨系統', current === 'auto', "profileSetTheme('auto')")
    ], 'role="radiogroup" aria-label="外觀"');
}

/** 套用主題偏好。委託 theme.js 的 setThemePreference()，避免兩處各寫一次 localStorage */
function profileSetTheme(pref) {
    if (typeof setThemePreference !== 'function') {
        profileToast('主題模組未載入');
        return;
    }

    setThemePreference(pref);

    // 剔號即時跟住走。⚠ 重繪而唔係手動 toggle class：三個選項嘅 is-on 同
    // aria-checked 都由同一個來源（themePreference()）決定，人手改必然會出現
    // 「舊選項未熄、新選項又亮」嘅兩個剔號同時存在。
    profileRerenderDetail();
}

/* ⚠ 通用模態抽屜（iOS Sheet）已徹底刪除：
   原本由 #ios-sheet-overlay + profileOpenSheet() / profileCloseSheet() 服務嘅
   私隱、儲存空間及數據、常見問題、回報問題、聯絡支援、四篇法律條文、
   邀請朋友，而家全部係 #profile-view-detail 嘅標準 Push 次頁面
   （見 PROFILE_DETAIL_PAGES）。
   連帶刪除嘅職責：profileSheetOpen 狀態、profileSheetNodes()、
   ESC／背景點擊關閉、抽屜焦點管理 —— 呢啲全部由
   profilePushDetail() / profileBackView() 一套機制負責，
   ⚠ 唔應該再存在第二套並行嘅導覽語言（用戶會唔知撳返回鍵會去邊）。 */

/* ================= 子頁面小工具 ================= */

/** 位元組轉成人類看得懂的大小 */
function profileBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return Math.round(value) + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
    if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(2) + ' MB';
    return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/** localStorage 用量估算。UTF-16 每字元 2 bytes，key 亦要計。 */
function profileLocalStorageBytes() {
    let total = 0;
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i) || '';
            const value = localStorage.getItem(key) || '';
            total += (key.length + value.length) * 2;
        }
    } catch (e) {
        // 私隱模式下 localStorage 可能直接拋錯：當作 0，唔好令抽屜開唔到
    }
    return total;
}

/** 統計列：左邊項目名、右邊灰色數值（值永遠完整靠右，唔會被切斷，見 .detail-stat） */
function profileStatHtml(label, value, valueId) {
    return '<div class="detail-stat">' +
        '<span class="detail-stat__k">' + profileEscape(label) + '</span>' +
        '<span class="detail-stat__v"' + (valueId ? ' id="' + valueId + '"' : '') + '>' +
        profileEscape(value === undefined || value === null ? '—' : value) + '</span>' +
        '</div>';
}

function profileFieldHtml(id, label, type, autocomplete, placeholder, value) {
    return '<div class="detail-field">' +
        '<label class="detail-field__label" for="' + id + '">' + profileEscape(label) + '</label>' +
        '<input class="detail-input" id="' + id + '" type="' + type + '" ' +
        (autocomplete ? 'autocomplete="' + autocomplete + '" ' : '') +
        'placeholder="' + profileEscape(placeholder || '') + '" ' +
        'value="' + profileEscape(value || '') + '">' +
        '</div>';
}

/** 一列「說明 + iOS 開關」。desc 有獨立 id，方便切換後即時改文案 */
function profileSwitchRowHtml(id, label, desc, on, handler) {
    return '<div class="detail-row">' +
        '<span class="detail-row__body">' +
        '<span class="detail-row__label">' + profileEscape(label) + '</span>' +
        '<span class="detail-row__desc" id="' + id + '-desc">' + profileEscape(desc) + '</span>' +
        '</span>' +
        '<button class="ios-switch' + (on ? ' is-on' : '') + '" type="button" id="' + id + '" ' +
        'role="switch" aria-checked="' + (on ? 'true' : 'false') + '" ' +
        'aria-label="' + profileEscape(label) + '" onclick="' + handler + '"></button>' +
        '</div>';
}

function profileProviderLabel(provider) {
    if (provider === 'email') return '電郵帳號（雲端）';
    if (provider === 'google') return 'Google 帳號（預留）';
    return '本機帳號';
}

function profilePrivacyState() {
    const raw = (typeof Storage !== 'undefined') ? Storage.get(PROFILE_PRIVACY_KEY, null) : null;
    const stored = (raw && typeof raw === 'object') ? raw : {};
    return Object.assign({}, PROFILE_PRIVACY_DEFAULTS, stored);
}

/* ⚠ 已刪除「密碼確認閘門」（profileOpenGuard / profileConfirmGuard / profilePendingGuard）：
   呢組工具本來只服務雙重認證 —— profileToggleTwoFactor() 開關時確認身分，
   以及 profileSwitchAccount() 切換到已開啟 2FA 嘅帳號時把關。
   兩個呼叫點同時消失，留住就會變成「冇人呼叫、但仲收埋一份密碼輸入框 HTML」嘅死碼。 */

/* ================= 雲端同步狀態 ================= */

/**
 * 更新頁尾嘅「雲端帳號系統 / 本機帳號系統」說明。
 * 純讀取狀態，唔會發任何網絡請求 —— 所以可以放心在每次重繪時呼叫。
 *
 * ⚠ 主選單「雲端同步狀態」行嘅副標題已移除，狀態文字改為只在頁尾顯示；
 *   要即刻同步請直接撳該行（profileCloudSyncNow()）。
 */
function renderCloudPill() {
    const note = document.getElementById('profile-storage-note');

    if (typeof cloudStatus !== 'function') return;

    const status = cloudStatus();

    // ⚠ 主選單「雲端同步狀態」行已冇副標題，所以只更新頁尾呢句純文字說明。
    if (note) note.textContent = status.enabled ? '雲端帳號系統' : '本機帳號系統';
}

/** 點擊狀態標籤：立即同步一次 */
async function profileCloudSyncNow() {
    if (typeof cloudSyncNow !== 'function' || typeof cloudEnabled !== 'function' || !cloudEnabled()) {
        profileToast('雲端同步未啟用（請在 auth-config.js 填寫 Supabase URL 與 Publishable key）');
        return;
    }

    profileToast('正在同步到雲端…');

    const account = authGetCurrentAccount();
    const result = await cloudSyncNow(account);

    renderCloudPill();

    if (result && result.ok) {
        const pulled = result.pulled ? '，已更新本機資料' : '';
        renderProfileHome();
        profileToast('雲端同步完成' + pulled);
    } else {
        profileToast('同步失敗：改動已保留本機，連線後會自動補送');
    }
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

    // ⚠ 原本呢度有一道「雙重認證閘門」：目標帳號若已開啟 2FA，要先輸入該帳號密碼
    //   才可以接手（連 skipGuard 參數，用嚟避免驗證成功後再彈同一個視窗）。
    //   2FA 功能已整個刪除（見 auth.js），所以閘門同該參數一併移除 ——
    //   留低嘅話，舊帳號上一個冇入口可以關閉嘅旗標會永遠鎖住切換流程。
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
        if (authGetAccounts().length) renderAccountsList();
    }

    profileToast('已移除帳號');
}

function profileStartNewAccount() {
    profileOnboarding = false;
    profileResetAuthForm();
    profileSetAuthMode('signup');
    profileShowView('auth');

    const nameInput = document.getElementById('auth-name-input');
    if (nameInput) setTimeout(() => nameInput.focus(), 260);
}

/** 點「登出」：先推入「登出帳號」次頁面確認，唔直接執行。
 *  ⚠ 呢個掣放喺卡片最底、又係紅色，好容易誤觸；而登出會清走 Session
 *    並跳返登入頁，復原成本高，所以一律要求二次確認。
 *  ⚠ 舊版係彈模態抽屜做確認；改成次頁面之後，左上返回鍵本身就係「取消」，
 *    所以頁面入面唔需要（亦唔應該）再擺一粒取消掣。 */
function profileLogout() {
    profilePushDetail('logout');
}

/** 登出帳號次頁面：顯示將要登出邊個帳號 + 一列紅色「登出」 */
function profileDetailLogoutHtml() {
    const account = (typeof authGetCurrentAccount === 'function') ? authGetCurrentAccount() : null;
    if (!account) return '';

    const who = account.name || account.email || '本機帳號';

    return profileListCardHtml([
        profileInfoRowHtml('目前登入', who)
    ]) + profileListCardHtml([
        '<button class="detail-action detail-action--danger" type="button" ' +
        'onclick="profileConfirmLogout()">登出</button>'
    ]);
}

/** 用戶確認後才真正登出 */
async function profileConfirmLogout() {
    // ⚠ 用 authSignOutSecure()，唔用 authSignOut()：
    //   前者會 await 雲端撤銷，並銷毀本機續期權杖；
    //   後者係 fire-and-forget 且刻意保留續期權杖（供帳號切換免密碼）。
    //   使用者主動登出屬於「唔應該留痕」的路徑，見 auth.js 的說明。
    const cloudOn = (typeof cloudEnabled === 'function') && cloudEnabled();

    // 若雲端撤銷失敗（離線／逾時），authSignOutSecure 仍會完成本機清理，
    // 並回報 revoked = false，下面據此顯示誠實的提示。
    const result = await authSignOutSecure();

    renderProfileHeader();

    await profileApplyAccountSchedule(null);

    profileResetAuthForm();
    profileSetAuthMode('signin');
    profileOnboarding = false;
    profileShowView('auth');

    // ⚠ 提示必須反映真實結果：撤銷失敗時唔可以照講「已登出帳號」，
    //   否則使用者會誤以為雲端 session 已經消失（實際上仲有效至過期為止）。
    if (!cloudOn || (result && result.revoked)) {
        profileToast('已登出帳號');
    } else {
        profileToast('已清除本機登入狀態（離線，雲端憑證將於下次連線時失效）');
    }
}

function openProfileAccounts() {
    renderAccountsList();

    // 由帳戶次頁面（例如裡面的「新增帳戶」）入嚟：入棧，令返回鍵彈返帳戶頁
    // 而唔係直接跳返個人中心。
    if (profileView === 'account' || profileView === 'detail') {
        profilePushView('accounts');
        return;
    }

    profileShowView('accounts');
}

// 專案展示牆：跳去對應分頁
function profileGoTab(pageId) {
    if (typeof switchTab === 'function') switchTab(pageId);

    const overlay = document.getElementById('profile-overlay');
    if (overlay) overlay.classList.remove('active');

    // ⚠ 呢條路徑冇經 closeProfilePanel()，所以次頁面層要自己重設。
    //   唔清 .is-on 嘅話，下次打開個人中心（例如直接去主頁）就會見到
    //   上一頁子頁面由右邊滑走，而 openProfilePanel() 只會清堆疊，唔會清呢個類名。
    const subPage = document.getElementById('profile-subpage');
    if (subPage) {
        subPage.classList.remove('is-on');
        subPage.setAttribute('aria-hidden', 'true');
    }
}

/* ===== 帳戶次頁面：新增帳戶 / 帳戶列表 / 7 個設定子頁面 ===== */

/** 點「新增帳戶」：先看已有帳號清單（可切換），清單底部再新增 */
function profileOpenAddAccount() {
    openProfileAccounts();
}

/** 複製文字到剪貼簿，並自動挑選可用的 API */
async function profileCopyText(text, successMessage) {
    const value = String(text || '');
    if (!value) return false;

    // 1) 標準 Clipboard API（只在 HTTPS / localhost 等安全來源可用）
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(value);
            profileToast(successMessage || '已複製到剪貼簿');
            return true;
        }
    } catch (e) {
        // 落到下面的後備方案，唔中斷流程
    }

    // 2) 後備：隱藏 textarea + execCommand（file:// 開啟時的退路）
    try {
        const helper = document.createElement('textarea');
        helper.value = value;
        helper.setAttribute('readonly', '');
        helper.style.position = 'fixed';
        helper.style.top = '-1000px';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(helper);
        if (copied) {
            profileToast(successMessage || '已複製到剪貼簿');
            return true;
        }
    } catch (e) {
        // 兩條路都失敗，下面提示用戶手動複製
    }

    profileToast('無法自動複製，請長按選取後複製');
    return false;
}

/* ===== 帳戶次頁面（WhatsApp 設定頁架構） =====
   結構：account（列表頁，DOM 固定喺 index.html 狀態 5）
           └ detail（共用容器 #profile-view-detail，內容即時注入）
   每次點列表項目只推入「自己嗰一頁」，唔會再似舊版將所有欄位
   一次過塞晒喺同一個模態抽屜入面。 */

/** 帳戶列表頁右上「⋯」：推入「帳戶選項」次頁面（帳號層級動作） */
function profileAccountMore() {
    profilePushDetail('accountMore');
}

/**
 * 帳戶選項次頁面：帳號層級嘅動作。
 * ⚠ 由抽屜改成次頁面之後，「新增 / 切換帳號」用 openProfileAccounts()
 *   （會再推入帳號清單）而唔係 profileOpenAddAccount()，因為後者只係別名，
 *   保留多一層只會令返回鍵多撳一次。
 * ⚠ 「登出」唔喺呢度直接執行，而係推入登出確認頁（同帳戶頁底部嗰粒一樣）。
 */
function profileDetailAccountMoreHtml() {
    const account = authGetCurrentAccount();

    const rows = [
        profileNavRowHtml('新增 / 切換帳號', '', 'openProfileAccounts()')
    ];

    if (account) {
        rows.push(profileNavRowHtml('登出', account.name || account.email || '', 'profileLogout()', true));
    }

    return profileListCardHtml(rows);
}

/**
 * 填寫帳戶列表頁兩行右側嘅即時狀態（元素被移除亦唔會拋錯）：
 * 電郵地址（「你的帳戶」分組，即帳號識別碼）、用戶名稱。
 * ⚠ 改完電郵之後由 profileRerenderDetail() 再呼叫呢個函式，
 *   所以列表頁右側會即時顯示新電郵，唔會殘留舊值。
 * ⚠ 「雙重認證」（ios-sub-acc-2fa）隨該行一併刪除，唔再需要填狀態。
 */
function renderProfileAccount() {
    const account = authGetCurrentAccount();

    profileSetSub('ios-sub-acc-email', (account && account.email) || '未設定');
    profileSetSub('ios-sub-acc-username', (account && account.name) || '未設定');
}

/** 個人主頁「帳戶」行 → 推入帳戶次頁面 */
function profileOpenAccount() {
    const account = authGetCurrentAccount();
    if (!account) {
        profileToast('請先登入帳號');
        return;
    }

    renderProfileAccount();

    // 已經身處次頁面（例如頭像旁嘅鉛筆掣）：入棧，令返回鍵可以彈返上一頁
    if (profileView === 'account' || profileView === 'detail') {
        profilePushView('account', { title: PROFILE_VIEW_TITLES.account, more: profileAccountMore });
        return;
    }

    // 由主頁進入：主頁唔係次頁面，直接切換即可（唔需要入棧）
    profileCurrentMore = profileAccountMore;
    profileShowView('account');
}

/** 唯讀資訊列（唔可撳、冇箭頭）：左邊項目名、右邊數值，永遠單行。
 *  ⚠ 第二個參數係「值」而唔係「解釋」——
 *    舊版會渲染成標題下面一行灰色小字（.ios-row__sub），令每行都兩行高，
 *    畫面雜亂；依「介面不留任何解釋性小字」嘅指示，
 *    改成 iOS 原生嘅右對齊數值列 .ios-row__value（同 .detail-stat 同一套語言）。
 *    所以傳入嘅一律係「無需驗證 / 不可以」呢類短值，
 *    唔可以再傳「本版本只在本機保存登入狀態」呢種說明句。
 *  ⚠ 呢個函式永遠唔會輸出額外屬性。曾有一段時間有第三個參數 attrs
 *    （用嚟掛開發者模式嘅 data-dev-version 標記），隨該入口搬去「開發者簡介」
 *    之後刪走。
 *    ⚠ 開發者模式入口而家搬返頁尾版本號，但嗰個標記係寫死喺 index.html
 *      嘅靜態 <p id="app-version"> 上，唔會、亦唔應該經呢個函式輸出 ——
 *      唔好見到入口回歸就以為要還原呢個參數。
 *    ⚠ 唔好因為「方便」而加返一個可以傳屬性字串嘅參數：嗰種參數冇得轉義，
 *      一旦有人傳入來自網絡或使用者嘅值，就即刻係一個 XSS 入口。
 *      真係需要掛屬性嘅話，應該由呼叫端自行包一層再渲染。 */
function profileInfoRowHtml(label, value) {
    return '<div class="ios-row" role="note">' +
        '<span class="ios-row__body">' +
        '<span class="ios-row__label">' + profileEscape(label) + '</span>' +
        '</span>' +
        (value ? '<span class="ios-row__value">' + profileEscape(value) + '</span>' : '') +
        '</div>';
}

/** 一列可撳嘅導覽項目（右側箭頭；danger = 紅字、依 iOS 慣例冇箭頭）
 *  ⚠ 呢個函式「冇」左側圖示：次頁面嘅跳轉列一向都冇圖示，而且本專案
 *    圖示一律由 icons.js 註冊表 ＋ data-icon 屬性描述，再由 hydrateIcons()
 *    水合成單色線條 SVG（硬寫 <i class="icon-user"> 攞唔到 stroke: currentColor，
 *    深淺主題會走音）。
 *  ⚠ 舊版曾經有一個選用嘅第 5 參數 icon，係為「關於我們」頁成員卡嘅社交列
 *    （Instagram／GitHub）而加。該等社交連結已改成卡片右側嘅橫向 Icon 掣
 *    （見 profileDevMemberHtml），全專案再冇呼叫點傳第 5 個參數，故刪除 ——
 *    留一個永遠唔會被填嘅參數，只會令人以為仲有地方靠佢 render 圖示。
 *    若日後真係要清單列帶圖示，正確做法係新增一個獨立嘅 renderer，
 *    而唔係喺呢度開一個免轉義嘅屬性拼接入口。 */
function profileNavRowHtml(label, sub, handler, danger) {
    return '<button class="ios-row' + (danger ? ' is-danger' : '') + '" type="button" ' +
        'onclick="' + handler + '">' +
        '<span class="ios-row__body">' +
        '<span class="ios-row__label">' + profileEscape(label) + '</span>' +
        (sub ? '<span class="ios-row__sub">' + profileEscape(sub) + '</span>' : '') +
        '</span>' +
        (danger ? '' : '<span class="ios-row__chevron" aria-hidden="true"></span>') +
        '</button>';
}

/**
 * 一張分組卡片（rows 係已生成嘅列 HTML 陣列：
 * .ios-row / .detail-stat / .detail-row / .detail-action 都放得入）
 * @param {string[]} rows
 * @param {string} [cardAttrs] 額外嘅 <section> 屬性（例如外觀頁嘅
 *        role="radiogroup" aria-label="外觀" —— 三個單選項需要一個共同容器，
 *        讀屏先知道佢哋係同一組互斥選項）。
 */
function profileListCardHtml(rows, cardAttrs) {
    return '<section class="ios-card"' + (cardAttrs ? ' ' + cardAttrs : '') + '>' +
        '<div class="ios-list">' + rows.join('') + '</div></section>';
}

/**
 * 帳戶子頁面註冊表：key → 標題 + 內容產生器。
 * ⚠ 全部子頁面共用同一個 DOM 容器（index.html 狀態 6），
 *   所以新增／刪除頁面只需要改呢度，唔需要再動 HTML。
 */
const PROFILE_DETAIL_PAGES = {
    password: { title: '密碼', html: profileDetailPasswordHtml },
    email: { title: '電郵地址', html: profileDetailEmailHtml },
    security: { title: '安全通知', html: profileDetailSecurityHtml },
    username: { title: '用戶名稱', html: profileDetailUsernameHtml },
    // ⚠ appearance 唔屬於「帳號設定」，而係裝置層級嘅外觀偏好 ——
    //   但入口（主選單「系統偏好」卡片）本身只會在已登入時見到，
    //   所以照樣走 profilePushDetail() 嘅登入檢查，唔需要開特例。
    appearance: { title: '外觀', html: profileDetailAppearanceHtml },
    // ⚠ devices 唔喺「帳戶」次頁面嘅卡片入面，入口係主頁最頂「已連結裝置」列 ——
    //   內容係裝置／Session 狀態（唯讀），所以照樣走 profilePushDetail() 嘅登入檢查。
    devices: { title: '已連結裝置', html: profileDetailDevicesHtml },
    // ⚠ 以下九頁原本全部係模態抽屜（profileOpenSheet），依「全站禁止 Modal」嘅
    //   指示一律改成標準 Push 次頁面：私隱、儲存空間、FAQ、回報問題、聯絡支援、
    //   四篇法律條文（見下方自動註冊）、邀請朋友、帳戶選項、登出確認。
    privacy: { title: '私隱', html: profileDetailPrivacyHtml },
    // after：用量數字要非同步統計，Push 完成後即刻填（見 profileRefreshStorageStats）
    storage: {
        title: '儲存空間及數據',
        html: profileDetailStorageHtml,
        after: profileRefreshStorageStats
    },
    faq: { title: '常見問題', html: profileDetailFaqHtml },
    feedback: { title: '回報問題 / 意見反饋', html: profileDetailFeedbackHtml },
    contact: { title: '聯絡支援', html: profileDetailContactHtml },
    // after：唔支援系統分享嘅瀏覽器要移除「系統分享」列
    invite: { title: '邀請朋友', html: profileDetailInviteHtml, after: profileSyncInviteShare },
    // ⚠ about 嘅入口喺「社群與分享」卡片（同邀請朋友同一張卡），本身唔屬於帳號設定；
    //   但主選單只會在已登入時才顯示（見 openProfilePanel()：未登入會先去 auth／accounts），
    //   所以照樣走 profilePushDetail() 嘅登入檢查，同隔離「聯絡支援」等頁一致，唔需要開特例。
    about: { title: '關於我們', html: profileDetailAboutHtml },
    // ⚠ 舊版嘅 developer（「開發者簡介」次頁面）已按需求整頁刪除，唔好加返：
    //   成員卡已直接嵌入「關於我們」頁，而原本喺該頁尾嘅「開發者模式」入口
    //   亦已搬返「個人中心」頁尾嘅版本號（連點 5 下，見 devtools.js 開頭說明）。
    // 帳號層級動作（帳戶頁右上「⋯」）同登出確認
    accountMore: { title: '帳戶選項', html: profileDetailAccountMoreHtml },
    logout: { title: '登出帳號', html: profileDetailLogoutHtml }
    // ⚠ phone（變更電話號碼）已刪除：本 App 從未收集電話號碼，嗰一頁只係一段
    //   「我哋冇你電話」嘅說明，冇任何可操作內容；帳戶識別碼改由 email 一頁負責。
    // ⚠ passkey（通行密鑰）／twofa（雙重認證）亦已刪除：前者係永遠不可能生效嘅
    //   說明頁（冇伺服器驗證簽章），後者只係「裝置層級」再驗證、唔係真正 2FA。
    //   ⚠ 所以要還原：除咗加返兩行 HTML，仲要還原 auth.js 嘅 twoFactor 欄位，
    //     否則開關會撳完冇反應。
};

// 四篇法律條文自動註冊（doc-disclaimer / doc-terms / doc-privacy / doc-licensing）：
// 標題同內文唯一來源都係 profile-content.js 嘅 PROFILE_LEGAL_DOCS（先於本檔載入），
// 所以新增、改名或排序條文都唔需要再改呢度，亦唔會出現「標題兩份」。
if (typeof PROFILE_LEGAL_DOCS !== 'undefined') {
    Object.keys(PROFILE_LEGAL_DOCS).forEach(function (key) {
        PROFILE_DETAIL_PAGES['doc-' + key] = {
            title: PROFILE_LEGAL_DOCS[key].title,
            html: () => profileDetailDocHtml(key)
        };
    });
}

/** 把指定子頁面注入共用容器（內容全部經 profileEscape() 處理） */
function profileRenderDetail(key) {
    const body = document.getElementById('profile-detail-body');
    if (!body) return;

    const page = PROFILE_DETAIL_PAGES[key];
    if (!page) {
        // 未知 key：出明確訊息，好過出空白頁令用戶以為壞咗
        body.innerHTML = profileListCardHtml([
            profileInfoRowHtml('找不到此設定', '請返回再試')
        ]);
        return;
    }

    body.innerHTML = page.html();
    if (typeof hydrateIcons === 'function') hydrateIcons(body);

    // 需要注入後先做嘢嘅頁面（非同步填數、按瀏覽器能力調整列）
    if (typeof page.after === 'function') page.after();
}

/** 設定變更後重繪：目前子頁面（開關、狀態文字）＋ 帳戶列表頁嘅摘要 */
function profileRerenderDetail() {
    if (profileView === 'detail' && profileDetailKey) profileRenderDetail(profileDetailKey);
    renderProfileAccount();
}

/** 變更密碼：三個欄位一齊驗證，成功後清空欄位 */
async function profileChangePassword() {
    const account = authGetCurrentAccount();
    if (!account) {
        profileToast('請先登入帳號');
        return;
    }

    const current = profileVal('detail-pwd-current');
    const next = profileVal('detail-pwd-new');
    const confirm = profileVal('detail-pwd-confirm');

    if (!current) { profileToast('請輸入目前密碼'); return; }
    const minLength = typeof authPasswordMinLength === 'function' ? authPasswordMinLength() : 6;
    if (next.length < minLength) { profileToast('新密碼至少需要 ' + minLength + ' 個字元'); return; }
    if (next !== confirm) { profileToast('兩次輸入的新密碼不一致'); return; }
    if (next === current) { profileToast('新密碼不可與目前密碼相同'); return; }

    const result = await authChangePassword(account.id, current, next);
    if (!result.ok) {
        profileToast(result.error || '密碼更新失敗');
        return;
    }

    ['detail-pwd-current', 'detail-pwd-new', 'detail-pwd-confirm'].forEach(id => {
        const node = document.getElementById(id);
        if (node) node.value = '';
    });

    profileToast('密碼已更新');
}

/**
 * 變更電郵：同步更新子頁面與帳戶列表頁狀態。
 * ⚠ Email 同時係雲端登入身分，必須等 Supabase 回應（非同步），
 *   而且預設要先經確認信驗證，所以分三種結果處理。
 */
async function profileUpdateEmail() {
    const account = authGetCurrentAccount();
    if (!account) {
        profileToast('請先登入帳號');
        return;
    }

    const result = await authUpdateEmail(account.id, profileVal('detail-email'));
    if (!result.ok) {
        profileToast(result.error || '電郵更新失敗');
        return;
    }

    // 需要在信箱點確認連結：本機 Email 保持原狀（雲端亦未改），
    // 否則本機與雲端唔一致，使用者下次會登入唔到。
    if (result.pendingConfirmation) {
        profileToast('確認信已寄到 ' + result.email + '，請點擊信中連結完成變更');
        return;
    }

    const node = document.getElementById('detail-email');
    if (node) node.value = result.account.email;

    profileRerenderDetail();
    profileToast('電郵已更新');
}

/* ⚠ 原 profileToggleTwoFactor()（開關裝置層級雙重認證）已隨該功能一併刪除：
   佢係唯一會寫入 account.twoFactor 嘅地方，冇咗開關就唔應該留住呢支 API。 */

/* ===== 帳戶子頁面：內容產生器 =====
   ⚠ 每個函式都回傳「注入 #profile-detail-body 嘅 HTML 字串」。
     所有動態文字一律經 profileEscape()，唔會直接拼接未轉義嘅輸入。 */

/** 用戶名稱：改名 + 唯讀帳號資料 */
function profileDetailUsernameHtml() {
    const account = authGetCurrentAccount();
    if (!account) return profileLoginRequiredHtml();

    const created = account.createdAt ? new Date(account.createdAt) : null;
    const createdText = (created && !isNaN(created.getTime()))
        ? created.getFullYear() + '-' +
          String(created.getMonth() + 1).padStart(2, '0') + '-' +
          String(created.getDate()).padStart(2, '0')
        : '未知';

    return '<section class="ios-card detail-form">' +
        '<form onsubmit="event.preventDefault(); profileUpdateUsername();">' +
        profileFieldHtml('detail-username', '用戶名稱（Username）', 'text', 'nickname',
            '2–20 個字元', account.name || '') +
        '<button class="detail-action" type="submit">儲存名稱</button>' +
        '</form>' +
        '</section>' +
        '<p class="ios-group-title">帳號資料</p>' +
        '<section class="ios-card"><div class="ios-list">' +
        // 頭像列重用帳號清單嘅 .acc-item__avatar（44px 圓形），視覺同帳號清單一致
        '<div class="ios-row" role="note">' +
        '<img class="acc-item__avatar" src="' + profileAvatarSrc(account) + '" alt="">' +
        '<span class="ios-row__body">' +
        '<span class="ios-row__label">頭像</span>' +
        '</span>' +
        '</div>' +
        profileStatHtml('帳號 ID', account.id) +
        profileStatHtml('帳號類型', profileProviderLabel(account.provider)) +
        profileStatHtml('註冊時間', createdText) +
        profileStatHtml('目前班級', account.className || '未設定') +
        '</div></section>';
}

/**
 * 電郵地址：本機帳號嘅識別碼，唔會收發任何郵件。
 * ⚠ 呢一頁就係「帳號識別碼」本身嘅子頁面 —— 對應 WhatsApp 個人檔案頁嘅電話號碼位置，
 *   由帳戶列表頁「你的帳戶 → 電郵地址」推入；同一頁兼任修改（表單）同驗證狀態（下方資訊卡）。
 */
function profileDetailEmailHtml() {
    const account = authGetCurrentAccount();
    if (!account) return profileLoginRequiredHtml();

    return '<section class="ios-card detail-form">' +
        '<form onsubmit="event.preventDefault(); profileUpdateEmail();">' +
        profileFieldHtml('detail-email', '電郵地址', 'email', 'email', 'you@example.com',
            account.email || '') +
        '<button class="detail-action" type="submit">儲存電郵</button>' +
        '</form>' +
        '</section>' +
        profileListCardHtml([
            profileInfoRowHtml('驗證狀態', '無需驗證'),
            profileInfoRowHtml('可找回密碼', '不可以')
        ]);
}

/** 密碼：三個欄位一齊驗證，成功後清空欄位 */
function profileDetailPasswordHtml() {
    return '<section class="ios-card detail-form">' +
        '<form onsubmit="event.preventDefault(); profileChangePassword();">' +
        profileFieldHtml('detail-pwd-current', '目前密碼', 'password', 'current-password', '輸入目前使用的密碼') +
        profileFieldHtml('detail-pwd-new', '新密碼', 'password', 'new-password', '至少 6 個字元') +
        profileFieldHtml('detail-pwd-confirm', '確認新密碼', 'password', 'new-password', '再輸入一次新密碼') +
        '<button class="detail-action" type="submit">更新密碼</button>' +
        '</form>' +
        '</section>' +
        profileListCardHtml([
            profileInfoRowHtml('忘記密碼', '需重設帳號'),
            profileInfoRowHtml('密碼提示', '不儲存')
        ]);
}

/** 變更用戶名稱 */
function profileUpdateUsername() {
    const account = authGetCurrentAccount();
    if (!account) {
        profileToast('請先登入帳號');
        return;
    }

    const result = authUpdateName(account.id, profileVal('detail-username'));
    if (!result.ok) {
        profileToast(result.error || '名稱更新失敗');
        return;
    }

    const node = document.getElementById('detail-username');
    if (node) node.value = result.account.name;

    renderProfileHeader();
    renderProfileHome();
    profileRerenderDetail();
    profileToast('用戶名稱已更新');
}

/** 未登入時嘅保底畫面：子頁面只會在已登入時推入，正常情況唔會見到 */
function profileLoginRequiredHtml() {
    return profileListCardHtml([
        profileInfoRowHtml('請先登入帳號')
    ]);
}

/* ⚠ 已刪除嘅子頁面產生器（連同 PROFILE_DETAIL_PAGES 嘅註冊一齊落）：
   · profileDetailTwoFactorHtml()：裝置層級 2FA 開關（唔係伺服器端 2FA）；
   · profileDetailPasskeyHtml()：通行密鑰說明頁（純前端永遠不可能生效）。
   連帶刪除嘅係 profileToggleTwoFactor()，同 auth.js 嘅 twoFactor 欄位／閘門。 */

/** 安全通知：本機 App 冇帳號伺服器，所以唔存在「異常登入」通知 */
function profileDetailSecurityHtml() {
    const account = authGetCurrentAccount();
    if (!account) return profileLoginRequiredHtml();

    // ⚠ 呢一頁曾經有兩段灰色說明段落，之後又改成「標題 + 灰色副標題」嘅兩行列；
    //   依「介面不留任何解釋性小字」嘅指示，而家一律收斂成單行右側數值：
    //   每一列只有一個狀態值，唔會再有「· 沒有帳號伺服器」呢種解釋尾巴。
    return profileListCardHtml([
        profileInfoRowHtml('登入通知', '不適用'),
        profileInfoRowHtml('新裝置通知', '不適用'),
        profileInfoRowHtml('本機提示', '開啟中'),
        profileNavRowHtml('密碼', '', "profilePushDetail('password')")
    ]);
}

/* ===== 已連結裝置（主頁最頂「已連結裝置」列推入） =====
   ⚠ 本 App 嘅帳號只存在這部裝置、冇多裝置後端，所以永遠只有一個 Session；
     呢頁如實顯示「這部裝置」＋ Session 狀態，唔會砌一個假嘅裝置清單出嚟。 */

/** 由 userAgent 粗略判斷系統／瀏覽器：純顯示用途，唔參與任何邏輯判斷 */
function profileDeviceLabel() {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';

    let os = '未知系統';
    if (/Windows/i.test(ua)) os = 'Windows';
    else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
    else if (/Linux/i.test(ua)) os = 'Linux';

    let browser = '瀏覽器';
    if (/Edg\//i.test(ua)) browser = 'Edge';
    else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
    else if (/Firefox\//i.test(ua)) browser = 'Firefox';
    else if (/Chrome\//i.test(ua)) browser = 'Chrome';
    else if (/Safari\//i.test(ua)) browser = 'Safari';

    return os + ' · ' + browser;
}

/** 時間戳 → YYYY-MM-DD HH:MM（本機時區）；無效值一律回 '—' */
function profileDateTimeText(ts) {
    const value = Number(ts);
    const date = value ? new Date(value) : null;
    if (!date || isNaN(date.getTime())) return '—';

    const pad = n => String(n).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
        ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

/**
 * 已連結裝置：這部裝置（目前 Session）＋ Session 狀態。
 * ⚠ 「其他裝置」永遠係空：帳號只在本機、冇任何遠端登入，所以照實講，唔造假清單。
 * ⚠ 雲端同步未啟用時唔顯示該行，避免出現一行永遠都係「本機模式」嘅死資料。
 */
function profileDetailDevicesHtml() {
    const account = authGetCurrentAccount();
    if (!account) return profileLoginRequiredHtml();

    const session = (typeof authSessionInfo === 'function') ? authSessionInfo() : null;

    const rows = [
        '<div class="ios-row" role="note">' +
        '<span class="ios-row__icon" data-icon="devices" data-icon-size="22"></span>' +
        '<span class="ios-row__body">' +
        '<span class="ios-row__label">這部裝置</span>' +
        '<span class="ios-row__sub">' + profileEscape(profileDeviceLabel()) + '</span>' +
        '</span>' +
        '</div>',
        profileStatHtml('最後登入', profileDateTimeText(account.lastLoginAt || account.createdAt)),
        profileStatHtml('Session', (session && session.expiresAt)
            ? '有效至 ' + profileDateTimeText(session.expiresAt)
            : '只在本次瀏覽階段有效')
    ];

    if (typeof cloudStatus === 'function') {
        const cloud = cloudStatus();
        if (cloud.enabled) {
            rows.push(profileStatHtml('雲端同步',
                cloud.label + (cloud.lastSyncAt ? ' · ' + profileDateTimeText(cloud.lastSyncAt) : '')));
        }
    }

    return profileListCardHtml(rows) +
        '<p class="ios-group-title">其他裝置</p>' +
        profileListCardHtml([
            profileInfoRowHtml('沒有其他已連結的裝置')
        ]);
}

/* ================= 系統偏好與私隱 ================= */

/** 私隱次頁面：三個本機開關。改動即時生效並寫入 localStorage。
    ⚠ 原本彈窗頂部／底部嗰兩段灰色說明已刪除：開關本身就講得明，
      唔需要再用兩段字覆述「只儲存在這部裝置」「不使用 Cookie」。 */
function profileDetailPrivacyHtml() {
    const state = profilePrivacyState();

    // ⚠ 唔好 .join('')：profileListCardHtml 收嘅係「列 HTML 陣列」
    const rows = PROFILE_PRIVACY_ITEMS.map(item => profileSwitchRowHtml(
        'detail-privacy-' + item.key,
        item.label,
        item.desc,
        !!state[item.key],
        "profileTogglePrivacy('" + item.key + "', this)"
    ));

    return profileListCardHtml(rows);
}

/** 切換單一私隱開關 */
function profileTogglePrivacy(key, button) {
    if (!button || !key) return;

    const state = profilePrivacyState();
    const next = !button.classList.contains('is-on');
    state[key] = next;

    if (typeof Storage !== 'undefined') Storage.set(PROFILE_PRIVACY_KEY, state);

    button.classList.toggle('is-on', next);
    button.setAttribute('aria-checked', next ? 'true' : 'false');

    const item = PROFILE_PRIVACY_ITEMS.find(row => row.key === key);
    profileToast((item ? item.label : '設定') + (next ? '：已開啟' : '：已關閉'));
}

/* ================= 儲存空間及數據 ================= */

/**
 * 儲存空間及數據次頁面：iOS 設定頁式版面 ——
 *   分組標題「用量」＋ 統計卡（每列：左邊項目名、右邊灰色數值）
 *   分組標題「管理」＋ 操作卡（破壞性動作做成一列紅字）
 * ⚠ 數字仍然係非同步填入，所以呢一頁喺 PROFILE_DETAIL_PAGES 帶
 *   after: profileRefreshStorageStats，Push 完成後即刻更新。
 * ⚠ 原本「重新整理統計」按鈕已刪除：每次進入呢一頁都會自動重新統計，
 *   多一粒手動刷新只係重複功能；「清除快取」已自帶重新載入。
 * ⚠ 原本頂部「以下數字反映…」同底部「清除快取只會移除…」兩段灰色說明已刪除。
 */
function profileDetailStorageHtml() {
    const usage = profileListCardHtml([
        profileStatHtml('離線快取', '計算中…', 'detail-stat-cache'),
        profileStatHtml('本機帳號與設定', '計算中…', 'detail-stat-local'),
        profileStatHtml('瀏覽器配額', '—', 'detail-stat-quota'),
        profileStatHtml('網絡連線', '—', 'detail-stat-network'),
        profileStatHtml('雲端同步', '—', 'detail-stat-cloud')
    ]);

    const manage = profileListCardHtml([
        '<button class="detail-action detail-action--danger" type="button" ' +
        'onclick="profileClearCache(this)">清除快取並重新載入</button>'
    ]);

    return '<p class="ios-group-title">用量</p>' + usage +
        '<p class="ios-group-title">管理</p>' + manage;
}

/** 非同步填寫各項統計數字（快取大小要逐個 cache 加總，所以係 async） */
async function profileRefreshStorageStats() {
    const setText = (id, text) => {
        const node = document.getElementById(id);
        if (node) node.textContent = text;
    };

    // 本機儲存用量
    const accounts = (typeof authGetAccounts === 'function') ? authGetAccounts() : [];
    setText('detail-stat-local',
        profileBytes(profileLocalStorageBytes()) + ' · ' + accounts.length + ' 個帳號');

    // 網絡連線（Network Information API，唔支援就退回 online 狀態）
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn && (conn.effectiveType || conn.downlink)) {
        const parts = [];
        if (conn.effectiveType) parts.push(conn.effectiveType.toUpperCase());
        if (conn.downlink) parts.push('約 ' + conn.downlink + ' Mbps');
        if (conn.saveData) parts.push('省流量模式');
        setText('detail-stat-network', parts.filter(Boolean).join(' · '));
    } else {
        setText('detail-stat-network', navigator.onLine === false ? '離線' : '已連線');
    }

    // 雲端同步狀態
    if (typeof cloudStatus === 'function') {
        const status = cloudStatus() || {};
        if (status.enabled) {
            const pending = status.pending ? '（' + status.pending + ' 項待同步）' : '';
            setText('detail-stat-cloud', (status.label || '已啟用') + pending);
        } else {
            setText('detail-stat-cloud', '未啟用 · 本機模式');
        }
    } else {
        setText('detail-stat-cloud', '未啟用 · 本機模式');
    }

    // 離線快取大小：逐個 cache 逐個 response 加總
    if (typeof caches === 'undefined' || !caches.keys) {
        setText('detail-stat-cache', '此環境不支援離線快取');
    } else {
        let cacheBytes = 0;
        let cacheCount = 0;
        try {
            const keys = await caches.keys();
            cacheCount = keys.length;
            for (const key of keys) {
                const cache = await caches.open(key);
                const requests = await cache.keys();
                for (const request of requests) {
                    const response = await cache.match(request);
                    if (!response) continue;
                    const blob = await response.clone().blob();
                    cacheBytes += blob.size;
                }
            }
        } catch (e) {
            console.warn('[profile] 讀取快取大小失敗:', e);
        }
        setText('detail-stat-cache', cacheCount
            ? profileBytes(cacheBytes) + ' · ' + cacheCount + ' 個快取庫'
            : '沒有離線快取');
    }

    // 瀏覽器配額
    if (navigator.storage && navigator.storage.estimate) {
        try {
            const estimate = await navigator.storage.estimate();
            setText('detail-stat-quota',
                profileBytes(estimate.usage) + ' / ' + profileBytes(estimate.quota));
        } catch (e) {
            setText('detail-stat-quota', '無法取得');
        }
    } else {
        setText('detail-stat-quota', '此環境不支援');
    }
}

/**
 * 一鍵清除快取。
 * ⚠ 只清「快取」而唔清「資料」：
 *   1) Service Worker 的 Cache Storage（下載過的頁面與 data/*.json）
 *   2) 資料檔的本機鏡像 appdb_mirror_v1_*（檔案副本，下次要重新抓最新版本）
 * 刻意保留 appdb_v1_*（用戶自己改過的課表內容）、帳號與所有偏好設定。
 */
async function profileClearCache(button) {
    if (button) {
        button.disabled = true;
        button.textContent = '正在清除…';
    }

    let removedCaches = 0;
    if (typeof caches !== 'undefined' && caches.keys) {
        try {
            const keys = await caches.keys();
            const results = await Promise.all(keys.map(key => caches.delete(key)));
            removedCaches = results.filter(Boolean).length;
        } catch (e) {
            console.error('[profile] 清除快取失敗:', e);
        }
    }

    let removedMirrors = 0;
    try {
        const doomed = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i) || '';
            if (key.indexOf('appdb_mirror_v1_') === 0) doomed.push(key);
        }
        doomed.forEach(key => { localStorage.removeItem(key); removedMirrors++; });
    } catch (e) {
        // 私隱模式：略過，唔影響上面已清掉的快取
    }

    if (button) {
        button.disabled = false;
        button.textContent = '清除快取並重新載入';
    }

    profileToast('已清除 ' + removedCaches + ' 個快取庫、' + removedMirrors + ' 份資料副本，正在重新載入…');
    setTimeout(() => location.reload(), 900);
}

/* ================= 意見和幫助：FAQ / 回報問題 / 聯絡支援 ================= */

function profileDetailFaqHtml() {
    const items = PROFILE_FAQ.map(item =>
        '<details class="detail-faq__item">' +
        '<summary class="detail-faq__q">' + profileEscape(item.q) + '</summary>' +
        '<div class="detail-faq__a">' + profileEscape(item.a) + '</div>' +
        '</details>'
    ).join('');

    return '<div class="detail-faq">' + items + '</div>' +
        profileListCardHtml([
            profileNavRowHtml('聯絡支援', '', "profilePushDetail('contact')")
        ]);
}

function profileDetailFeedbackHtml() {
    const options = PROFILE_FEEDBACK_TYPES.map(type =>
        '<option value="' + type.value + '">' + profileEscape(type.label) + '</option>').join('');

    return '<form onsubmit="event.preventDefault(); profileSubmitFeedback();">' +
        '<section class="ios-card detail-form">' +
        '<div class="detail-field">' +
        '<label class="detail-field__label" for="detail-feedback-type">問題類型</label>' +
        '<select class="detail-select" id="detail-feedback-type">' + options + '</select>' +
        '</div>' +
        profileFieldHtml('detail-feedback-subject', '主旨', 'text', null, '例如：S2A 課表星期三顯示錯誤') +
        '<div class="detail-field">' +
        '<label class="detail-field__label" for="detail-feedback-body">詳細描述</label>' +
        '<textarea class="detail-textarea" id="detail-feedback-body" ' +
        'placeholder="請描述你遇到的狀況、操作步驟，以及你預期看到的結果"></textarea>' +
        '</div>' +
        // 送出做成一列藍字：同上面輸入框同住一張卡，左右邊界自然對齊
        '<button class="detail-action" type="submit">送出反饋</button>' +
        '</section>' +
        '</form>';
}

async function profileSubmitFeedback() {
    const type = profileVal('detail-feedback-type');
    const subject = profileVal('detail-feedback-subject');
    const body = profileVal('detail-feedback-body');

    if (subject.length < 2) { profileToast('請填寫主旨'); return; }
    if (body.length < 5) { profileToast('請簡單描述你遇到的狀況'); return; }

    const account = authGetCurrentAccount();
    const matched = PROFILE_FEEDBACK_TYPES.find(item => item.value === type);
    const typeLabel = matched ? matched.label : type;

    const text = [
        '類型：' + typeLabel,
        '主旨：' + subject,
        '',
        '描述：',
        body,
        '',
        '--- 系統資訊 ---',
        'App：' + PROFILE_APP_NAME + ' v' + profileAppVersion(),
        '班級：' + ((account && account.className) || '未設定'),
        '帳號：' + ((account && account.name) || '未登入'),
        '回報時間：' + new Date().toLocaleString()
    ].join('\n');

    // 1) 本機留一份記錄：郵件程式開唔到都唔會白做
    try {
        const history = Storage.get('profile_feedback_v1', []) || [];
        history.unshift({
            type: type, label: typeLabel, subject: subject, body: body, at: Date.now()
        });
        Storage.set('profile_feedback_v1', history.slice(0, 20));
    } catch (e) {
        // 儲存失敗唔應該阻止寄信
    }

    // 2) 開啟郵件程式（部分環境會封鎖 mailto，所以唔當失敗）
    const mailto = 'mailto:' + PROFILE_SUPPORT_EMAIL +
        '?subject=' + encodeURIComponent('[' + PROFILE_APP_NAME + '] ' + subject) +
        '&body=' + encodeURIComponent(text);
    try {
        window.location.href = mailto;
    } catch (e) {
        // 忽略：本機副本已經留存
    }

    profileToast('已記錄反饋並開啟郵件程式');
}

function profileDetailContactHtml() {
    return '<div class="detail-callout">' +
        '<span class="detail-callout__title">' + profileEscape(PROFILE_APP_NAME) + ' 支援</span>' +
        '<span class="detail-callout__desc">我們一般會在 ' + PROFILE_RESPONSE_HOURS + ' 內回覆。<br>' +
        profileEscape(PROFILE_SUPPORT_EMAIL) + '</span>' +
        '</div>' +
        profileListCardHtml([
            profileNavRowHtml('以電郵聯絡我們', PROFILE_SUPPORT_EMAIL, 'profileMailSupport()'),
            profileNavRowHtml('回報問題 / 意見反饋', '', "profilePushDetail('feedback')"),
            profileNavRowHtml('複製支援信箱', '', 'profileCopyContact()'),
            profileNavRowHtml('複製版本資訊', '', 'profileCopyVersionInfo()')
        ]);
}

/** 開啟郵件程式撰寫支援請求（同原本 <a href="mailto:…"> 嘅行為一致） */
function profileMailSupport() {
    window.location.href = 'mailto:' + PROFILE_SUPPORT_EMAIL +
        '?subject=' + encodeURIComponent('[' + PROFILE_APP_NAME + '] 支援請求');
}

function profileCopyContact() {
    profileCopyText(PROFILE_SUPPORT_EMAIL, '已複製支援信箱');
}

function profileCopyVersionInfo() {
    const account = authGetCurrentAccount();
    const info = [
        'App：' + PROFILE_APP_NAME + ' v' + profileAppVersion(),
        '班級：' + ((account && account.className) || '未設定'),
        '帳號：' + ((account && account.name) || '未登入'),
        '介面主題：' + (profileCurrentTheme() === 'dark' ? '深色' : '淺色'),
        '瀏覽器：' + navigator.userAgent
    ].join('\n');
    profileCopyText(info, '已複製版本資訊，可直接貼進郵件');
}

/* ================= 法律與合規 ================= */

/** 條文內文只允許兩種標記：段落與清單；**粗體** 在轉義之後才還原（避免 XSS） */
function profileDocInline(text) {
    return profileEscape(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function profileDocParagraphHtml(text) {
    return '<p>' + profileDocInline(text) + '</p>';
}

function profileDocChapterHtml(chapter) {
    let html = '<h3>' + profileEscape(chapter.h) + '</h3>';

    if (typeof chapter.p === 'string') html += profileDocParagraphHtml(chapter.p);
    if (Array.isArray(chapter.p)) {
        chapter.p.forEach(paragraph => { html += profileDocParagraphHtml(paragraph); });
    }
    if (Array.isArray(chapter.list)) {
        html += '<ul>' + chapter.list.map(item => '<li>' + profileDocInline(item) + '</li>').join('') + '</ul>';
    }

    return html;
}

/**
 * 法律條文次頁面產生器。key 對應 PROFILE_LEGAL_DOCS 嘅鍵
 * （disclaimer / terms / privacy / licensing）。
 * ⚠ 標題同內文嘅唯一來源都係 profile-content.js，
 *   唔喺呢度再寫一次，避免改咗條文標題而側邊仲係舊名。
 */
function profileDetailDocHtml(key) {
    const docs = (typeof PROFILE_LEGAL_DOCS !== 'undefined') ? PROFILE_LEGAL_DOCS : null;
    const doc = docs ? docs[key] : null;
    if (!doc) return '';

    const chapters = (doc.chapters || []).map(profileDocChapterHtml).join('');

    return '<div class="detail-doc">' +
        '<p class="detail-doc__meta">' + profileEscape(doc.meta) + '</p>' +
        profileDocParagraphHtml(doc.lead) +
        chapters +
        '<p class="detail-doc__caps">繼續使用本服務，即表示你已閱讀並同意上述條款。' +
        '如你不同意任何部分，請停止使用本服務。</p>' +
        '</div>';
}

/* ================= 社群與分享 ================= */

/** 邀請連結一律以「正式網域」為根，唔理當前係本機定線上。
 *  ⚠ 唔可以用 location.href 做主來源：本機開發（127.0.0.1 / localhost）會產生
 *  對方開唔到嘅邀請連結，分享出去等於派一條死連結。
 *  解析順序：
 *    1. window.APP_CONFIG.siteUrl —— 正式來源，見 scripts/config/app-config.js
 *    2. 全局 APP_SHARE_URL       —— 兼容寫死常量嘅寫法
 *    3. location.href            —— 最後防線，令個掣最壞情況仍然複製到嘢
 *  產出格式：https://pcmstimetable.com/?invite=1 */
function profileInviteLink() {
    const config = (typeof window !== 'undefined' && window.APP_CONFIG) ? window.APP_CONFIG : {};

    // 1) 正式來源：設定檔嘅 siteUrl
    let base = String(config.siteUrl || '').trim();

    // 2) 兼容寫死常量嘅寫法：全局 APP_SHARE_URL（window.APP_SHARE_URL 或頂層 const）
    if (!base) {
        try {
            if (typeof APP_SHARE_URL !== 'undefined' && APP_SHARE_URL) {
                base = String(APP_SHARE_URL).trim();
            }
        } catch (e) {
            // TDZ：常量存在但未初始化，當作未設定處理
        }
    }

    // 3) 最後防線：當前網址。正常永遠行唔到，但寧願連結唔靚都好過個掣變死掣
    if (!base) base = String(location.href || '');

    // 丢掉 query / hash，避免把登入狀態或追蹤參數分享出去
    base = base.split('#')[0].split('?')[0];

    // 容錯：漏寫 protocol 時自動補 https://（'pcmstimetable.com' → 'https://pcmstimetable.com'）
    if (base && !/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) {
        base = 'https://' + base.replace(/^\/+/, '');
    }

    // 正規化：結尾補上單一條斜線（siteUrl 寫有無「/」都得到同一個結果）
    if (base && base.charAt(base.length - 1) !== '/') base += '/';

    // 參數保留可設定；順手吃掉可能誤加嘅「?」，避免出現「??」
    const param = String(config.inviteParam == null ? 'invite=1' : config.inviteParam)
        .replace(/^\?/, '');

    return param ? base + '?' + param : base;
}

function profileDetailInviteHtml() {
    const link = profileInviteLink();

    // ⚠ 原本「一藍一灰」兩顆並排大按鈕已改成同一張卡嘅兩列動作：
    //   卡片內嘅列同卡片邊框、左邊線自然對齊，唔會再出現浮喺卡外嘅按鈕。
    return '<div class="detail-callout">' +
        '<span class="detail-callout__title">一起用 ' + profileEscape(PROFILE_APP_NAME) + '</span>' +
        '<span class="detail-callout__desc">' + profileEscape(PROFILE_INVITE_TEXT) + '</span>' +
        '</div>' +
        '<div class="detail-link">' +
        '<span class="detail-link__label">邀請連結</span>' +
        '<span class="detail-link__url" id="detail-invite-url">' + profileEscape(link) + '</span>' +
        '</div>' +
        profileListCardHtml([
            '<button class="detail-action" type="button" id="detail-invite-share" ' +
            'onclick="profileShareInvite()">系統分享</button>',
            '<button class="detail-action" type="button" id="detail-invite-copy" ' +
            'onclick="profileCopyInvite()">複製連結</button>'
        ]);
}

/** 系統分享唔係所有瀏覽器都有（部分桌面瀏覽器無 navigator.share）。
 *  ⚠ 舊版會將「複製連結」由灰色升做藍色主按鈕；改成卡片列之後兩者本身
 *    就係同一款藍字，升樣式已經冇意義 —— 只需要移除唔支援嘅「系統分享」列，
 *    唔好留低一個撳完只會複製、同標籤不符嘅死掣。 */
function profileSyncInviteShare() {
    if (navigator.share) return;

    const share = document.getElementById('detail-invite-share');
    if (share && share.parentNode) share.parentNode.removeChild(share);
}

async function profileCopyInvite() {
    await profileCopyText(profileInviteLink(), '已複製邀請連結');
}

/** 優先用系統原生分享面板（Web Share API）。
 *  ⚠ 本版起刻意移除 QR Code：分享場景用分享面板或直接貼連結已經足夠，
 *  唔值得為此長期揹住一部 QR 編碼器。
 *  分享面板唔存在、或拋出非取消類錯誤時，一律回退到複製連結。 */
async function profileShareInvite() {
    const link = profileInviteLink();

    if (navigator.share) {
        try {
            await navigator.share({ title: PROFILE_INVITE_TITLE, text: PROFILE_INVITE_TEXT, url: link });
            return;
        } catch (e) {
            // 用戶主動取消分享唔應該再彈提示
            if (e && e.name === 'AbortError') return;
        }
    }

    profileCopyText(link, '此裝置不支援系統分享，已複製連結');
}

/**
 * 「關於我們」次頁面。
 * ⚠ 版面依需求只有兩部分，唔好加返其他嘢：
 *   1) 頂部「App 資訊」：App 名稱 ＋ 簡介 ＋ 版本號（全部喺同一個
 *      .detail-callout 入面）；
 *   2) 開發者卡片：全頁唯一一張白色大卡，由 PROFILE_DEVELOPER_MEMBERS 驅動，
 *      卡內順序為 區塊標題 → 成員（垂直排列）→ 頁尾致敬標語。
 *      ⚠ 舊版係「每位成員各自一張 .ios-card」：幾張同款卡片疊埋一齊，
 *        睇落仍然係一列清單項，只係換咗皮膚 —— 呢個正是今次改版要擺脫嘅觀感。
 *        新版改成「一張卡裝晒所有成員」，成員之間用 1px 橫線分隔，
 *        卡內所有內容水平置中，視覺上係一塊板而唔係一疊卡。
 *      ⚠ 卡內唔可以再出現 .ios-row／chevron／.ios-card：卡片只有一張，
 *        成員區塊係自訂排版（見 profileDevMemberHtml），強行用清單列就會
 *        退回「列表感」，亦會變成「卡片裡面包卡片」。
 * ⚠ 刻意唔用 Modal：本專案明令「全站禁止 Modal」，所有子頁面一律經
 *   profilePushDetail() 以 iOS 標準 Push 動畫推入共用容器 #profile-detail-body
 *   （見 PROFILE_DETAIL_PAGES 上方註解）。所以呢度冇 openAboutUsModal() ——
 *   若日後真要一個彈窗版本，正確做法係改 profilePushDetail 嘅呈現，
 *   而唔係喺呢度另開一套「彈窗」導覽語言（同一層有兩套語言，用戶會唔知
 *   撳返回鍵會去邊）。
 * ⚠ 版本號一律經 profileAppVersion() 取 APP_VERSION（db.js，全站唯一來源），
 *   唔可以喺呢度再硬編一次，否則升版本時兩份會走音。
 * ⚠ 版本號用 <span> 而唔另開一張 .ios-card：佢唔係清單項目（唔可撳、冇箭頭、
 *   冇分隔線），依架構規則唔可以用卡片包裹；而且佢同上面兩行同屬「App 資訊」
 *   一個區塊，抽出嚟就會變成一張只得一列嘅孤零零卡片，節奏斷開。
 * ⚠ 舊版呢頁仲有「聯絡／法律」卡（以電郵聯絡我們、回報問題 / 意見反饋、
 *   複製版本資訊、私隱政策、服務條款）同「開發者簡介」入口卡，均已按需求刪除。
 *   刪嘅時候已確認兩件事，唔好當係漏咗：
 *   · 私隱政策／服務條款 唔會失去入口 —— 主選單「法律與合規」卡已有齊四篇
 *     （免責聲明／服務條款／私隱政策／條款與許可）；
 *   · 回報問題 / 意見反饋 同 聯絡支援 同樣喺主選單各自有入口。
 *   ⚠ 亦唔可以改用 profileInfoRowHtml() 偷偷塞返：該函式係「唯讀資訊列」，
 *     用嚟重現「可以撳」嘅動作會令畫面同實際行為唔一致。
 * ⚠ 頁尾致敬標語（PROFILE_ABOUT_TRIBUTE）曾隨上述內容一併刪除，呢次按需求
 *   恢復，並改為擺喺開發者卡片嘅最底一行（卡內最後一項）。
 *   ⚠ 個心係 icons.js 嘅 heart SVG，唔係 ❤ Emoji —— 本專案系統 UI 嚴禁 Emoji。
 *   ⚠ 標語恆為整段嘅最後一項：下面嘅 return 一定要把佢拼喺 members 之後，
 *     否則個分隔線就會落錯位（CSS 用 .dev-member + .detail-tribute 判定）。
 */
function profileDetailAboutHtml() {
    // ⚠ 成員由 PROFILE_DEVELOPER_MEMBERS 驅動（單一來源）。陣列一空就
    //   整張卡唔渲染 —— 唔會留低一張「得個標題」嘅空卡。
    const members = (typeof PROFILE_DEVELOPER_MEMBERS !== 'undefined' && PROFILE_DEVELOPER_MEMBERS.length)
        ? PROFILE_DEVELOPER_MEMBERS.map(profileDevMemberHtml).join('')
        : '';

    // ⚠ typeof 守衛同上面一樣：profile-content.js 未載入時應該係「冇咗一句標語」，
    //   而唔係整個「關於我們」頁拋 ReferenceError 變空白頁。
    const tribute = (typeof PROFILE_ABOUT_TRIBUTE !== 'undefined' && PROFILE_ABOUT_TRIBUTE)
        ? '<p class="detail-tribute">' +
              '<span class="detail-tribute__text">用</span>' +
              '<span class="detail-tribute__icon" data-icon="heart" data-icon-size="14" aria-hidden="true"></span>' +
              '<span class="detail-tribute__text">' + profileEscape(PROFILE_ABOUT_TRIBUTE) + '</span>' +
          '</p>'
        : '';

    // ⚠ 區塊標題同樣用 typeof 守衛：「冇咗個標題」係可以接受嘅退化，
    //   整個頁拋 ReferenceError 就唔係。
    const panelTitle = (typeof PROFILE_DEVELOPER_PANEL_TITLE !== 'undefined' && PROFILE_DEVELOPER_PANEL_TITLE)
        ? '<p class="dev-panel__title">' + profileEscape(PROFILE_DEVELOPER_PANEL_TITLE) + '</p>'
        : '';

    // ⚠ 整張卡經 profileListCardHtml() 產生，唔自己砌 <section class="ios-card">：
    //   卡片外框（圓角／玻璃底／陰影／左右 14px 內距）全站只有嗰一個定義源頭，
    //   喺呢度再寫一次就等於開第二份規格，日後改卡一定漏咗呢張。
    //   ⚠ 一次過傳一個內容項（整塊 .dev-panel）而唔係「每個成員一項」：
    //     .ios-list 係 flex column，傳多項就會變成幾段各自獨立嘅內容，
    //     成員之間嘅分隔線亦無從判定。
    const panel = members
        ? profileListCardHtml([
              '<div class="dev-panel">' +
              panelTitle +
              members +
              tribute +
              '</div>'
          ])
        : '';

    return '<div class="detail-callout">' +
        '<span class="detail-callout__title">' + profileEscape(PROFILE_APP_NAME) + '</span>' +
        '<span class="detail-callout__desc">' + profileEscape(PROFILE_ABOUT_DESC) + '</span>' +
        // ⚠ 「版本」兩個字 + profileAppVersion() 拼成「版本 v3.5.1」，同需求一致。
        //   profileEscape() 照樣包住：APP_VERSION 目前雖然係本專案自己嘅常數，
        //   但萬一日後改為由遠端設定讀入，呢一層就係必要嘅守衛。
        '<span class="detail-callout__version">版本 v' + profileEscape(profileAppVersion()) + '</span>' +
        '</div>' +
        panel;
}

/* ================= 開發者成員區塊（「關於我們」頁） =================
   ⚠ 資料一律由 profile-content.js 嘅 PROFILE_DEVELOPER_MEMBERS 提供
     （單一來源），呢度只負責渲染，唔可以硬編姓名、班別或者網址。
   ⚠ 版面係「個人卡片區塊」而唔係「選單列」：由上至下垂直置中 ——
     圓形頭像 → 姓名 → 班別 → 社交 Icon 掣列，全部水平置中對齊。
     ⚠ 所以呢度「刻意唔用」profileNavRowHtml()：佢係清單列（label 靠左、
       有 chevron、有 hairline），用嚟砌一個置中區塊就會出現
       「有 chevron 但唔係跳轉」嘅語意錯誤，而且一用就即刻返返去列表感。
     ⚠ 成員區塊之間嘅 1px 橫線由 CSS 負責（.dev-member + .dev-member），
       唔可以喺呢度插 <hr> 或者自己補一條線嘅 div：分隔線係「排版規則」，
       一旦變成 DOM 就會出現「最後一位後面多一條線」呢類要靠 :last-child
       補救嘅問題。
     ⚠ 姓名之後直接就是班別，中間「冇」任何簡介文字：卡片一多一行描述，
       就會重新變成一個列表項。舊版嘅「M56運動會暗組織學員」等描述已按
       需求完全移除，唔好因為「睇落有資料」而加返。
   ⚠ 社交連結一律 <a href target="_blank" rel="noopener noreferrer">：
     · 用 <a> 而唔用 <button onclick>：目的地本來就係一條網址，用連結語意
       先啱（讀屏會讀「連結」，長按／中鍵亦可以另開分頁）；
     · 開新分頁而唔喺同一分頁導航：本頁係 App 內嘅子頁面，用 location.href
       會令用戶一去不回（返回鍵返到嘅係一個已經被導離嘅文件）；
     · noopener 必寫：唔寫嘅話新分頁可以透過 window.opener 改寫本頁，
       對一個會存登入狀態嘅 App 嚟講係實際風險（noreferrer 一併加上）。
     ⚠ 舊版嘅 profileOpenExternal() 已隨今次改版刪除（佢係配合 button＋onclick
       嘅產物）。原本由佢把守嘅「只接受 https://」守衛，改為喺下面渲染前過濾
       （見 profileDevMemberHtml），效果一樣但更早生效：唔符合嘅寧願唔渲染嗰粒掣，
       而唔係渲染一粒撳落冇反應嘅死掣。
   ⚠ 舊版呢個位置係 profileDetailDeveloperHtml()（一個獨立嘅「開發者簡介」
     次頁面，兼開發者模式入口）。該頁已按需求整頁刪除，成員區塊改為直接嵌入
     「關於我們」頁嘅卡片；而原喺該頁尾嘅「開發者模式」列亦已搬到「個人中心」
     頁尾版本號（連點 5 下），詳見 devtools.js 開頭嘅入口搬遷史。
     ⚠ 亦因此，呢度「唔可以」再加一粒「解鎖管理員驗證」掣：開發者模式全站
       只可以有一個入口（見 devtools.js 同一段註解）。需求文件提到嘅
       openDevAuthModal() 本專案從來冇存在過 —— 唔好為咗「跟足文件」而新開
       一個函式名，再喺呢度加第二道門。
   ⚠ 該頁附帶嘅聯絡卡（回覆時間／以電郵聯絡我們／回報問題 / 意見反饋／
     複製支援信箱）已一併刪除，唔好因為「睇落有用」而加返 ——
     呢幾個動作喺主選單各自已有入口，重複落嚟只會兩處走音。
   ================================================================= */

/** 由姓名取頭像縮寫：每個字取首字母（'Ray Cheung' → 'RC'、'Chan Hong Tang' → 'CHT'）。
 *  ⚠ 取「全部」字而唔止前兩個：Chan Hong Tang 用前兩字會得出 'CH'，
 *    同需求指明嘅 'CHT' 唔一致。上限 3 個字係防止有人填一段長名，
 *    縮寫撐爆圓形頭像（目前 64px，見 .dev-member__avatar）。
 *  ⚠ 用文字縮寫而唔用相片：本專案冇、亦唔應該為此新增二進位資產
 *    （assets/ 目前只有 App 圖示同 logo）；而遠端頭像 URL 一離線就變爛圖，
 *    同本頁「必須離線可讀」嘅前提直接矛盾。純文字縮寫永遠 render 得出，
 *    而且跟 currentColor 走，深淺主題各自有正確對比。 */
function profileDevInitials(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
    const letters = words.map(w => w.charAt(0)).join('');
    return letters ? letters.toUpperCase() : '?';
}

/** 一位成員嘅區塊：由上至下垂直置中 —— 圓形頭像 → 姓名 → 班別 → 社交 Icon 掣列。
 *  ⚠ 中間刻意冇任何簡介文字 —— 姓名之後直接就是班別。
 *  ⚠ 唔包卡片外框：呢個區塊係開發者大卡「入面」嘅一段內容，
 *    喺度再包 .ios-card 就會變成「卡片裡面包卡片」。分隔線亦唔喺呢度出，
 *    交由 CSS 以相鄰選擇器（.dev-member + .dev-member）判定。
 *  ⚠ 社交掣用 <a href> 而唔用 <button onclick>：目的地本來就係一條網址，
 *    連結語意先啱。連帶把「只接受 https://」嘅守衛由「撳嗰陣先檢查」
 *    改為「渲染前先過濾」（見下面 filter）—— 效果一樣但更早生效。
 *  ⚠ 網址、aria-label 一律經 profileEscape()：兩者都係屬性值，
 *    冇轉義就等於自己開一個屬性注入入口。
 *  ⚠ data-icon 用嘅 s.icon 係硬編字串（profile-content.js 嘅常數），
 *    唔可以改成由使用者輸入提供（見 profileNavRowHtml 同一段註解）。
 *  ⚠ 頭像用 aria-hidden：佢只係姓名嘅縮寫，讀屏讀完個名再讀多次「RC」
 *    係純噪音；姓名本身係真文字，唔會因為收埋頭像而失去資訊。 */
function profileDevMemberHtml(member) {
    const socials = (member && member.socials ? member.socials : [])
        // ⚠ 過濾而唔係照 render：一個 javascript: 或空網址嘅項目，
        //   寧願唔出嗰粒掣，都好過出一粒撳落冇反應（或更差）嘅死掣。
        .filter(function (s) { return s && /^https:\/\//i.test(String(s.url || '')); })
        .map(function (s) {
            return '<a class="dev-social__link" href="' + profileEscape(s.url) + '"' +
                ' target="_blank" rel="noopener noreferrer"' +
                ' aria-label="' + profileEscape(s.label) + '"' +
                ' title="' + profileEscape(s.label) + '">' +
                '<span data-icon="' + s.icon + '" data-icon-size="20"></span>' +
                '</a>';
        });

    const cls = (member && member.tag)
        ? '<span class="dev-member__class">' + profileEscape(member.tag) + '</span>'
        : '';

    return '<div class="dev-member">' +
        '<span class="dev-member__avatar" aria-hidden="true">' +
        profileEscape(profileDevInitials(member && member.name)) +
        '</span>' +
        '<span class="dev-member__name">' + profileEscape(member && member.name) + '</span>' +
        cls +
        (socials.length ? '<span class="dev-social">' + socials.join('') + '</span>' : '') +
        '</div>';
}

/* ================= 版本號（頁尾） ================= */

function profileAppVersion() {
    if (typeof APP_VERSION !== 'undefined' && APP_VERSION) return String(APP_VERSION);
    // 後備值：只有 db.js 未載入或 APP_VERSION 缺失時才行到。
    // ⚠ 同 index.html 頁尾嘅後備值、db.js 嘅 APP_VERSION 三處必須一致；
    //   依 db.js 版本政策，唔可以因為改 UI／修 bug 而自行升呢個號。
    return '3.5.1';
}

/** 把版本號寫進頁尾。APP_VERSION 係全站唯一來源，唔可以硬編兩份。 */
function profileRenderVersion() {
    const node = document.getElementById('app-version');
    if (node) node.textContent = 'v' + profileAppVersion();
}

/* ================= 初始化 ================= */

function initProfile() {
    authInit();
    renderProfileHeader();

    // 訂閱雲端同步狀態：標籤會隨「同步中 / 待同步 / 離線 / 失敗」即時變化
    if (typeof cloudSubscribe === 'function') {
        cloudSubscribe(() => renderCloudPill());
    }
    renderCloudPill();

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

    // ⚠ 原本呢度要為模態抽屜綁「點背景關閉」同「右上 ❌ 關閉」兩個監聽。
    //   抽屜已刪除，子頁面一律用左上返回鍵彈出，所以唔會再有抽屜節點可以綁。

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;

        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
            active.blur();
            return;
        }

        // ESC 等同返回鍵：先彈最上層子頁面，冇得彈才收埋整個個人中心。
        // ⚠ 唔可以直接跳到「收埋面板」：用戶喺子頁面按 ESC 會誤關成個個人中心。
        if (profileViewStack.length) { profileBackView(); return; }

        const panel = document.getElementById('profile-overlay');
        if (!panel || !panel.classList.contains('active')) return;

        closeProfilePanel();
    });

    profileSetAuthMode('signin');
    profileRenderVersion();

    // 開機時：仲未有班級（首次開啟 / 未登入 / 帳號未綁班級）
    // → 立即開引導選班，絕對唔會預設顯示某個班級（例如 S2A）嘅課表
    const account = authGetCurrentAccount();
    if (profileNeedsClassChoice(account)) {
        setTimeout(() => openProfilePanel('class'), 420);
    } else if (account) {
        profileApplyAccountSchedule(account);
    }
}