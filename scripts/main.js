// ================= 全域變數 =================
let scheduleData = {};
let holidaysData = [];
let scheduleLoadFailed = false;
let scheduleLoadFailedUrl = '';
let scheduleLoadFailedReason = '';
let currentScheduleUrl = '';   // 目前載入中／已載入的課表網址（顯示用）
let currentScheduleName = '';  // 目前使用嘅 DB 課表集合名（例如 schedule:junior2-zheng）
const dayNames = ["日", "一", "二", "三", "四", "五", "六"];
let currentTab = 'page-realtime';

// ================= 初始化 =================
async function initApp() {
    await showSplashScreen();

    // 先確認目前登入帳號 → 決定要讀「班級專屬課表」還是預設課表
    let account = null;
    try {
        // 班級清單版本檢查：若 data/classes.json 的 schemaVersion 同上次記錄唔一致，
        // 先清掉 localStorage 內殘留嘅舊班級快取（auth_classes_cache），
        // 否則舊清單（初一A / 初二忠 …）會永遠蓋過新版 classes.json。
        if (typeof dbEnsureClassesSchema === 'function') {
            await dbEnsureClassesSchema();
        }

        // 清完快取後強制重讀，確保攞到最新班級清單
        if (typeof authLoadClasses === 'function') await authLoadClasses(true);
        if (typeof authInit === 'function') account = authInit();
    } catch (e) {
        console.warn('載入帳號 / 班級資料失敗:', e);
    }

    await applyClassSchedule(account);

    // 假期資料同樣由 DataManager 讀取（localStorage → holidays.json）
    try {
        await DB.load('holidays');
        holidaysData = DB.get('holidays') || [];
    } catch (e) {
        console.warn('載入假期資料失敗:', e);
        holidaysData = [];
    }

    initTheme();
    initSearch();
    initCardExpand();
    initCalendar();
    initProfile();

    renderWeeklyGrid();
    renderHolidays();

    if (scheduleLoadFailed) {
        renderScheduleLoadError();
    }

    // 開發者模式（連點版本號 5 下 / Ctrl + Shift + D）
    if (typeof initDevTools === 'function') initDevTools();

    // 開發者面板改動任何 DB → 即時重繪對應畫面（Hot Reload）
    initDbBridge();

    // Liquid Glass：把折射／邊緣光／色散套到 TabBar 膠囊與滑塊上
    initLiquidGlass();

    // 未選班級 → 預設停在週覽頁，令「請先選擇班級」引導卡一開 App 就見到
    const needsClassChoice = renderClassPrompt();
    switchTab(needsClassChoice ? 'page-weekly' : 'page-realtime');

    // Tab 點擊切換：立即綁定，唔等 150ms 對位（確保一入 App 就點得到）
    bindNavTabs();

    // 等 DOM 渲染完成後，初始化選中塊位置 + 綁定拖拽手勢
    setTimeout(initNavIndicator, 150);
    window.addEventListener('resize', initNavIndicator);

    // 尺寸改變時玻璃的折射濾鏡要重新套用（cornerRadius／陰影都同尺寸有關）
    window.addEventListener('resize', () => {
        if (lgInstance) lgInstance.markChanged();
    });

    setInterval(() => {
        if (document.getElementById('page-realtime').classList.contains('active')) {
            updateRealtimeStatus();
        }
    }, 1000);
}

// ================= 依帳號班級載入對應課表 =================

// 抓一份課表 JSON；靜態主機／代理有時回傳 200 但內容係 HTML（404 頁），要分開講清楚
async function fetchScheduleJson(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const raw = await response.text();
    try {
        return JSON.parse(raw);
    } catch (parseError) {
        throw new Error('伺服器回傳嘅唔係 JSON（可能係 404 頁面或被攔截），請對照下面嘅網址');
    }
}

// 週覽頁頂部的提示條：只有「班級未有專屬課表、現正顯示預設課表」時才出現
function showScheduleNotice(message) {
    const box = document.getElementById('schedule-notice');
    const text = document.getElementById('schedule-notice-text');
    if (!box) return;
    if (message) {
        if (text) text.textContent = message;
        box.classList.add('is-on');
    } else {
        box.classList.remove('is-on');
    }
}

function renderScheduleNotice(account) {
    const resolved = (typeof authResolveSchedule === 'function')
        ? authResolveSchedule(account || null)
        : null;

    // 未選班級 → 課表區域已經有「請先選擇班級」引導卡，唔需要再加一條提示條
    if (scheduleLoadFailed || !resolved || resolved.reason === 'unselected') {
        showScheduleNotice('');
        return;
    }

    const className = resolved.className || (account && account.className) || '';
    if (resolved.isDefault && className) {
        showScheduleNotice(className + ' 暫時未有專屬課表，以下顯示預設課表');
    } else {
        showScheduleNotice('');
    }
}

// 這部裝置／這個帳號揀過班級未？（未揀 → 只顯示引導卡，唔顯示任何班級課表）
function scheduleNeedsClassChoice() {
    if (typeof authResolveSchedule !== 'function') return false;
    const account = (typeof authGetCurrentAccount === 'function') ? authGetCurrentAccount() : null;
    return authResolveSchedule(account || null).reason === 'unselected';
}

// 切換「引導卡 / 課表」顯示狀態：未選班級時收起週覽表格，避免看到其他班課表
function renderClassPrompt() {
    const show = scheduleNeedsClassChoice();
    const prompt = document.getElementById('class-prompt');
    const grid = document.getElementById('weekly-grid-container');
    if (prompt) prompt.classList.toggle('is-on', show);
    if (grid) grid.classList.toggle('is-empty', show);
    return show;
}

// 課表資料換咗之後，把所有依賴 scheduleData 的畫面重新畫一次
function refreshScheduleViews() {
    // 未選班級 → 課表區域改為引導卡（唔會預設派其他班級課表）
    renderClassPrompt();

    if (scheduleLoadFailed) {
        renderScheduleLoadError();
        return;
    }

    if (typeof renderWeeklyGrid === 'function') renderWeeklyGrid();
    if (typeof renderHolidays === 'function') renderHolidays();
    if (currentTab === 'page-schedule' && typeof renderSchedule === 'function') renderSchedule('tomorrow');
    if (currentTab === 'page-calendar' && typeof renderCalendar === 'function') renderCalendar();
    updateRealtimeStatus();
}

/**
 * 依帳號班級載入對應課表（供 profile.js 登入 / 切換帳號 / 登出時呼叫）。
 * 資料一律經 DataManager（集合名 schedule:<classId>）：
 *   localStorage 覆寫（開發者面板改過）→ 班級課表 JSON → 預設課表 → 錯誤卡
 * 回傳 { url, isDefault, className, failed }
 */
async function applyClassSchedule(account, force) {
    // authResolveSchedule 用同步版清單，第一次要先確保清單載好
    if (typeof authLoadClasses === 'function' && typeof authGetClassList === 'function' && !authGetClassList().length) {
        try { await authLoadClasses(); } catch (e) { /* 失敗時 auth.js 有內建備援清單 */ }
    }

    const forced = !!force;

    // 用家明確切換班級：先修復失效綁定，再以最新班級清單為準重新解析
    if (forced && typeof authRepairAccountClasses === 'function') {
        authRepairAccountClasses();
    }

    let resolved = { url: 'data/schedule.json', isDefault: true, className: '', classId: '' };
    if (typeof authResolveSchedule === 'function') {
        resolved = authResolveSchedule(account || null);
    }

    // 未選班級（首次開啟）：絕對唔可以派一份預設班級課表頂上，
    // 一律清空課表，交由 UI 顯示「請先選擇班級」並自動開啟班級選擇。
    if (resolved.reason === 'unselected') {
        scheduleData = {};
        scheduleLoadFailed = false;
        scheduleLoadFailedReason = '';
        scheduleLoadFailedUrl = '';
        currentScheduleUrl = '';
        currentScheduleName = '';   // 清空 → 揀好班級之後一定會真正重新載入
        refreshScheduleViews();
        renderScheduleNotice(account);
        return { url: '', isDefault: true, className: '', failed: false, unselected: true };
    }

    const classId = resolved.classId || 'default';
    const scheduleName = dbScheduleName(classId);
    const targetUrl = appUrl(resolved.url);
    dbRegisterSchedule(classId, resolved.url, dbScheduleLabel(classId, resolved.className));

    // 同一份課表已經載入成功 → 不用重覆抓，只需更新提示條
    // 但 forced 例外：用家撳了「套用」，就算課表無變都要重新繪製，
    // 否則切換班級會「靜靜地冇反應」，睇落就好似死鎖。
    if (!forced && scheduleName === currentScheduleName && DB.isLoaded(scheduleName) && !scheduleLoadFailed) {
        scheduleData = DB.get(scheduleName) || {};
        renderScheduleNotice(account);
        return { url: targetUrl, isDefault: !!resolved.isDefault, className: resolved.className, failed: false };
    }

    let data = null;
    let usedName = scheduleName;
    let usedUrl = targetUrl;
    let isDefault = !!resolved.isDefault;
    let reason = '';

    try {
        const value = await DB.load(scheduleName, { force: true });
        if (value && Object.keys(value).length) data = value;
        else reason = DB.lastError(scheduleName) || '課表檔案係空嘅（可能係 404 頁面或被攔截）';
    } catch (error) {
        reason = error && error.message ? error.message : String(error);
    }

    if (!data) console.warn('載入課表失敗:', scheduleName, reason);

    // 班級專屬課表讀唔到 → 退回預設課表，至少唔會成頁空白
    if (!data && scheduleName !== dbScheduleName('default')) {
        const fallbackName = dbScheduleName('default');
        const classDoc = (typeof authLoadClassesSync === 'function') ? authLoadClassesSync() : null;
        usedName = fallbackName;
        usedUrl = appUrl((classDoc && classDoc.defaultSchedule) || 'data/schedule.json');
        dbRegisterSchedule('default', (classDoc && classDoc.defaultSchedule) || 'data/schedule.json', '預設課表');
        try {
            const fallback = await DB.load(fallbackName, { force: true });
            if (fallback && Object.keys(fallback).length) {
                data = fallback;
                isDefault = true;
            }
        } catch (fallbackError) {
            reason = fallbackError && fallbackError.message ? fallbackError.message : String(fallbackError);
        }
    }

    if (data) {
        scheduleData = data;
        scheduleLoadFailed = false;
        scheduleLoadFailedReason = '';
        scheduleLoadFailedUrl = usedUrl;
        currentScheduleUrl = usedUrl;
        currentScheduleName = usedName;
    } else {
        scheduleData = {};
        scheduleLoadFailed = true;
        scheduleLoadFailedReason = reason;
        scheduleLoadFailedUrl = usedUrl;
        currentScheduleUrl = '';
        currentScheduleName = usedName;
    }

    refreshScheduleViews();
    renderScheduleNotice(account);

    return { url: usedUrl, isDefault: isDefault, className: resolved.className, failed: !data };
}

// ================= DataManager → 畫面 綁定（Hot Reload） =================
/**
 * 開發者面板「保存並套用」後，DB 會 notify，
 * 這裡把改動即時反映到畫面上，唔需要手動重新整理。
 */
function initDbBridge() {
    // 假期與倒數
    DB.subscribe('holidays', () => {
        holidaysData = DB.get('holidays') || [];
        if (typeof renderHolidays === 'function') renderHolidays();
        if (typeof renderProfileNextHoliday === 'function') renderProfileNextHoliday();
    });

    // 班級清單（會連帶影響課表選擇）
    DB.subscribe('classes', async () => {
        if (typeof authSetClasses === 'function') authSetClasses(DB.get('classes'));
        dbRegisterAllSchedules();
        const account = (typeof authGetCurrentAccount === 'function') ? authGetCurrentAccount() : null;
        // force = true：清單改動後課表路徑可能完全唔同，一定要重新解析同重繪
        try { await applyClassSchedule(account, true); } catch (e) { console.warn(e); }
        if (typeof profileRefreshClassList === 'function') await profileRefreshClassList();
    });

    // 帳號清單
    DB.subscribe('accounts', () => {
        if (typeof authLoadStore === 'function') authLoadStore();
        if (typeof renderProfileHeader === 'function') renderProfileHeader();
        if (typeof renderProfileHome === 'function') renderProfileHome();
    });

    // 課表（集合名係動態嘅 schedule:<classId>，用萬用字元接）
    DB.subscribe('*', (_value, detail) => {
        const name = detail && detail.name ? detail.name : '';
        if (name.indexOf('schedule:') !== 0) return;
        if (name !== currentScheduleName) return;
        const value = DB.get(name) || {};
        scheduleData = value;
        scheduleLoadFailed = Object.keys(value).length === 0;
        if (!scheduleLoadFailed) scheduleLoadFailedReason = '';
        refreshScheduleViews();
    });
}

// ================= 課表載入失敗提示 =================
function renderScheduleLoadError() {
    const container = document.getElementById('status-container');
    if (!container) return;

    // file:// 直接開檔時，瀏覽器基於安全性會封鎖 fetch 本機檔案
    const isFileProtocol = location.protocol === 'file:';
    const reason = isFileProtocol
        ? '偵測到你係直接打開 index.html，瀏覽器唔准 file:// 用 fetch 讀取本機 JSON。'
        : `讀唔到課表檔案：${scheduleLoadFailedReason}`;
    const action = isFileProtocol
        ? '請用本機伺服器開啟（VS Code Live Server，或喺資料夾執行 python -m http.server）'
        : '請確認伺服器上面有 data/schedule.json，之後用 Ctrl + Shift + R 強制重新整理';
    // 顯示實際請求嘅網址，方便喺 GitHub Pages 對照係邊一段路徑出錯
    const debugLine = isFileProtocol
        ? ''
        : `<div class="teacher" style="word-break: break-all;">網址：${scheduleLoadFailedUrl}</div>`;

    container.innerHTML = `
        <div class="status-card now">
            <div class="status-header">
                <div>ERROR</div>
            </div>
            <div class="status-body">
                <div class="subject long-text">載入課表失敗</div>
                <div class="teacher">${reason}</div>
                ${debugLine}
                <div class="time-range">${action}</div>
            </div>
        </div>
    `;
}

// ================= Splash Screen 控制 =================
function showSplashScreen() {
    return new Promise((resolve) => {
        const splash = document.getElementById('splash-screen');
        if (!splash) {
            resolve();
            return;
        }

        setTimeout(() => {
            splash.classList.add('hidden');
            setTimeout(() => {
                splash.classList.add('removed');
                setTimeout(() => {
                    if (splash.parentNode) {
                        splash.parentNode.removeChild(splash);
                    }
                    resolve();
                }, 100);
            }, 300);
        }, 1200);
    });
}

// ================= Tab 切換（Liquid Glass 版） =================
const NAV_PILL_INSET = 4;    // 滑塊左右內縮量
const NAV_PILL_MIN_W = 56;   // 滑塊最小寬度

// 量測某個 Tab 對應的滑塊幾何
// x 係 translateX 值，原點＝膠囊的 padding box（即絕對定位子元素 left:0 的位置）。
// 所以量測時要扣掉左邊框寬度（clientLeft），唔可以連邊框都算進去，
// 否則整個滑塊會系統性偏移 1px，同 .nav-item 的中心對唔齊。
function measureNavPill(item, capsule) {
    const capsuleRect = capsule.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const originLeft = capsuleRect.left + capsule.clientLeft;
    return {
        x: (itemRect.left - originLeft) + NAV_PILL_INSET,
        width: Math.max(itemRect.width - NAV_PILL_INSET * 2, NAV_PILL_MIN_W)
    };
}

// ================= Liquid Glass 引擎（TabBar 光學層） =================
// 玻璃折射／邊緣光／色散由 modules/liquidglass 負責；
// 這一節只做「物理」：彈簧位移、速度形變、流體拖尾，並把形變量餵給光學層。
let lgInstance = null;

function initLiquidGlass() {
    if (typeof LiquidGlass === 'undefined') {
        console.warn('[TabBar] LiquidGlass 引擎未載入，玻璃改用純 blur 後備方案');
        return;
    }
    const root = document.getElementById('bottom-nav');
    if (!root) return;

    LiquidGlass.init({
        root,
        glassElements: [
            root.querySelector('.nav-capsule'),
            root.querySelector('#nav-indicator')
        ].filter(Boolean)
    }).then((instance) => {
        lgInstance = instance;
    }).catch((err) => {
        console.warn('[TabBar] Liquid Glass 初始化失敗：', err);
    });
}

// 系統「減少動態效果」→ 全部改成即時對位，唔做液態動畫
const PREFERS_REDUCED_MOTION = !!(window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// 彈簧參數：k / c / m。ζ = c / (2√(km)) ≈ 0.80 → 輕微過衝再回彈，唔會震不停
const NAV_SPRING_STIFFNESS = 190;
const NAV_SPRING_DAMPING = 22;
const NAV_SPRING_MASS = 1;

// 形變量 → 玻璃光學（張力越強，邊緣光與色散越亮）
function applyNavMorph(element, stretch, velocity) {
    if (!lgInstance || !element) return;
    lgInstance.setMorph(element, {
        stretch,
        squash: stretch * 0.4,
        velocity: Math.abs(velocity) / 1000      // px/s → px/ms
    });
}

// ================= 流體拖尾（Drag 時跟唔上滑塊嘅液滴） =================
const NAV_TRAIL_LAG = 0.20;      // 追趕係數：越細越黏、拖尾越長
let navTrailTargetX = null;      // 拖尾目標（滑塊中心，膠囊座標）
let navTrailX = null;            // 拖尾當前位置（指數插值後）
let navTrailWidth = 0;
let navTrailRAF = null;

function navTrailElement() {
    return document.getElementById('nav-trail');
}

function stopNavTrail() {
    if (navTrailRAF) {
        cancelAnimationFrame(navTrailRAF);
        navTrailRAF = null;
    }
}

function resetNavTrail() {
    const trail = navTrailElement();
    stopNavTrail();
    navTrailTargetX = null;
    navTrailX = null;
    if (trail) trail.classList.remove('is-active');
}

/* 拖尾跟隨：每 frame 指數插值追向滑塊中心 → 產生黏稠液體嘅落後感 */
function startNavTrail(pillCenter, width) {
    const trail = navTrailElement();
    if (!trail) return;

    navTrailWidth = width;
    navTrailTargetX = pillCenter;
    if (navTrailX === null) navTrailX = pillCenter;
    trail.style.width = `${width}px`;
    trail.classList.add('is-active');

    if (navTrailRAF) return;

    const tick = () => {
        navTrailRAF = null;
        if (navTrailX !== null && navTrailTargetX !== null) {
            navTrailX += (navTrailTargetX - navTrailX) * NAV_TRAIL_LAG;

            // 拖尾被拉長（表面張力）：離滑塊越遠越扁越長
            const gap = Math.abs(navTrailTargetX - navTrailX);
            const stretch = Math.min(gap / 90, 0.55);
            trail.style.transform =
                `translateX(${(navTrailX - navTrailWidth / 2).toFixed(2)}px) scaleX(${(1 + stretch).toFixed(3)})`;
        }
        if (trail.classList.contains('is-active')) {
            navTrailRAF = requestAnimationFrame(tick);
        }
    };
    navTrailRAF = requestAnimationFrame(tick);
}

// ================= 液態彈簧位移 =================
function stopNavSpring(indicator) {
    if (indicator && indicator._springRAF) {
        cancelAnimationFrame(indicator._springRAF);
        indicator._springRAF = null;
    }
}

/* 由 fromX 彈到 toX；initialVelocity（px/s）令放手後可以「順勢」滑過去 */
function springNavPill(indicator, fromX, toX, initialVelocity) {
    let x = fromX;
    let v = Number(initialVelocity) || 0;
    let last = 0;

    // 起手形變：距離越遠拉得越長（點擊遠處 Tab → 拉長再收縮嘅液態感）
    let stretch = Math.min(Math.abs(toX - fromX) / 900, 0.14);

    stopNavSpring(indicator);

    const step = (now) => {
        indicator._springRAF = null;

        // dt 由真實 frame 時間換算，唔同刷新率都穩定
        const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
        last = now;

        v += ((-NAV_SPRING_STIFFNESS * (x - toX) - NAV_SPRING_DAMPING * v) / NAV_SPRING_MASS) * dt;
        x += v * dt;

        // 飛行途中嘅速度形變：快 → 拉長；到埗 → 收縮回彈
        const flying = Math.min(Math.abs(v) / 2600, 0.15);
        stretch += (flying - stretch) * 0.35;

        indicator._navX = x;
        indicator.style.transform =
            `translateX(${x.toFixed(2)}px) scaleX(${(1 + stretch).toFixed(4)}) scaleY(${(1 - stretch * 0.4).toFixed(4)})`;
        applyNavMorph(indicator, stretch, v);

        if (Math.abs(v) < 6 && Math.abs(x - toX) < 0.3) {
            indicator._navX = toX;
            indicator.style.transform = `translateX(${toX}px) scaleX(1) scaleY(1)`;
            applyNavMorph(indicator, 0, 0);
            indicator.classList.remove('is-sliding');
            return;
        }

        indicator._springRAF = requestAnimationFrame(step);
    };

    indicator._springRAF = requestAnimationFrame(step);
}

// 移動滑塊：animate=false → 立即對位（初始化／resize 用）；true → 液態彈簧平移
function moveNavPill(target, animate) {
    const indicator = document.getElementById('nav-indicator');
    const item = (typeof target === 'number')
        ? document.querySelectorAll('.nav-item')[target]
        : target;
    if (!indicator || !item || !item.parentElement) return;

    const geo = measureNavPill(item, item.parentElement);

    if (animate === false || PREFERS_REDUCED_MOTION) {
        stopNavSpring(indicator);
        resetNavTrail();
        indicator.classList.remove('is-sliding', 'is-dragging');
        indicator.style.transition = 'none';
        indicator.style.width = `${geo.width}px`;
        indicator.style.transform = `translateX(${geo.x}px) scaleX(1) scaleY(1)`;
        indicator._navX = geo.x;
        applyNavMorph(indicator, 0, 0);
        void indicator.offsetWidth;                       // 強制 reflow，套用無動畫狀態
        requestAnimationFrame(() => { indicator.style.transition = ''; });
        return;
    }

    indicator.classList.remove('is-dragging');
    indicator.classList.add('is-sliding');
    // 彈簧自己逐格積分，所以必須關掉 CSS transition，否則兩者會互相拉扯
    indicator.style.transition = 'none';
    indicator.style.width = `${geo.width}px`;

    // 由「邏輯座標」出發：拉伸中的 getBoundingClientRect 會受 scaleX 影響，唔可靠
    const fromX = (typeof indicator._navX === 'number') ? indicator._navX : geo.x;

    // 拖拽放手時記低嘅速度 → 滑塊順勢滑過去，唔會由 0 重新加速
    const velocity = Number(indicator._releaseVelocity) || 0;
    indicator._releaseVelocity = 0;

    springNavPill(indicator, fromX, geo.x, velocity);
}

function switchTab(pageId) {
    const navItems = document.querySelectorAll('.nav-item');
    let activeItem = null;

    navItems.forEach((item) => {
        const isActive = item.dataset.tab === pageId;
        item.classList.toggle('active', isActive);
        if (isActive) activeItem = item;
    });

    if (activeItem) moveNavPill(activeItem, true);

    document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
    const targetPage = document.getElementById(pageId);
    if (targetPage) targetPage.classList.add('active');

    currentTab = pageId;

    if (pageId === 'page-schedule') renderSchedule('tomorrow');
    if (pageId === 'page-realtime') updateRealtimeStatus();
    if (pageId === 'page-weekly') renderWeeklyGrid();
    if (pageId === 'page-calendar') renderCalendar();
    if (pageId === 'page-holidays') renderHolidays();
}

// ================= TabBar 雙模互動常數 =================
// 位移小於此值 → 視為 Tap（點擊切換頁面）；大於此值且偏橫向 → 進入 Drag（拖拽吸附）
const NAV_DRAG_THRESHOLD = 6;        // px
const NAV_TAP_SUPPRESS_MS = 500;     // 拖拽結束後，暫時吞掉殘留 click 的時間

// ================= 模式一：Tap / Click =================
// 為每個 .nav-item 綁定 click（單一入口，保證「點哪個 Icon 就跳哪一頁」）
function bindNavTabs() {
    const capsule = document.querySelector('.nav-capsule');
    if (!capsule) return;

    capsule.querySelectorAll('.nav-item').forEach((item) => {
        if (item._navTapBound) return;    // 只綁一次
        item._navTapBound = true;

        item.addEventListener('click', (e) => {
            // 剛拖拽完產生的殘留 click：吞掉，避免放手指時誤跳頁
            if (capsule._suppressTap) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }

            const tab = item.dataset.tab;
            if (!tab) return;

            // 不阻止預設行為以外的任何傳播，讓其他監聽器正常運作
            switchTab(tab);
        });
    });
}

// ================= 初始化滑塊：對位 + 綁定拖拽手勢 =================
function initNavIndicator() {
    const indicator = document.getElementById('nav-indicator');
    const capsule = document.querySelector('.nav-capsule');
    if (!indicator || !capsule) return;

    // 依目前選中的 Tab 對位（不打動畫）
    const activeItem = capsule.querySelector('.nav-item.active');
    if (activeItem) moveNavPill(activeItem, false);

    bindNavTabs();                        // 點擊切換（idempotent）

    if (capsule._navDragBound) return;    // 手勢只綁一次（resize 會重複呼叫）
    capsule._navDragBound = true;

    const items = Array.from(capsule.querySelectorAll('.nav-item'));
    if (!items.length) return;

    let pressing = false;      // 已按下（未必構成拖拽）
    let dragging = false;      // 已跨越門檻 → Drag 模式
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let startPillLeft = 0;
    let pillWidth = 0;
    let minX = 0;
    let maxX = 0;
    let lastMoveX = 0;         // 上一筆 pointermove 的 X（計速度用）
    let lastMoveTime = 0;
    let velocity = 0;          // 手指速度 px/s（EMA 平滑），放手時交接給彈簧

    const stopTracking = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
    };

    const onPointerMove = (e) => {
        if (!pressing || e.pointerId !== pointerId) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        // 尚未進入 Drag：只有「明確且偏橫向」的位移才啟動，
        // 微量抖動（Tap）與縱向滑動（捲頁）一律不干預。
        if (!dragging) {
            if (Math.abs(dx) < NAV_DRAG_THRESHOLD) return;
            if (Math.abs(dx) <= Math.abs(dy)) return;      // 偏縱向 → 交還瀏覽器捲動

            dragging = true;
            indicator.classList.remove('is-sliding');
            indicator.classList.add('is-dragging');
            indicator.style.transition = 'none';
            stopNavSpring(indicator);

            lastMoveTime = e.timeStamp || performance.now();
            lastMoveX = e.clientX;
            velocity = 0;
            startNavTrail(startPillLeft + pillWidth / 2, pillWidth);
        }

        // startPillLeft／minX／maxX 全部係「膠囊本地座標」，
        // 所以 x 亦一定要用本地座標，唔可以混入 viewport 座標
        let x = startPillLeft + dx;
        // 橡皮筋阻尼：拖出範圍時遞減
        if (x < minX) x = minX - (minX - x) * 0.28;
        if (x > maxX) x = maxX + (x - maxX) * 0.28;

        // ---- 手指速度（px/s，EMA 平滑）：後面嘅形變同彈簧都靠佢 ----
        const now = e.timeStamp || performance.now();
        const dt = Math.max(now - lastMoveTime, 1);
        velocity = velocity * 0.72 + (((e.clientX - lastMoveX) / dt) * 1000) * 0.28;
        lastMoveTime = now;
        lastMoveX = e.clientX;

        const localX = x;      // 已經是膠囊本地座標

        // Liquid Stretch：形變改由「速度」驅動（原本用累積位移），
        // 快速甩動時拉長、慢速停留時回復圓形 —— 更接近液體表面張力行為。
        const stretch = Math.min(Math.abs(velocity) / 2200, 0.15);

        indicator._navX = localX;
        indicator.style.width = `${pillWidth}px`;
        indicator.style.transform =
            `translateX(${localX.toFixed(2)}px) scaleX(${(1 + stretch).toFixed(4)}) scaleY(${(1 - stretch * 0.35).toFixed(4)})`;

        applyNavMorph(indicator, stretch, velocity);

        // 拖尾追向滑塊中心（指數插值會落後 → 形成液滴）
        navTrailTargetX = localX + pillWidth / 2;
    };

    const onPointerUp = () => {
        if (!pressing) return;

        const wasDragging = dragging;
        pressing = false;
        dragging = false;
        pointerId = null;
        stopTracking();
        indicator.classList.remove('is-dragging');
        indicator.style.transition = '';

        if (!wasDragging) {
            resetNavTrail();
            return;     // Tap：完全不干預，交由原生 click 切換頁面
        }

        // 放手速度交接給彈簧：滑塊會「順勢」滑向目標 Tab，唔會突然煞停再加速
        indicator._releaseVelocity = velocity;
        velocity = 0;

        // ---- 模式二：Drag 放手 → 依滑塊中心找最近 Tab，彈性吸附並切換頁面 ----
        const rect = indicator.getBoundingClientRect();
        const center = rect.left + rect.width / 2;

        let best = 0;
        let bestDist = Infinity;
        items.forEach((item, i) => {
            const ir = item.getBoundingClientRect();
            const d = Math.abs((ir.left + ir.width / 2) - center);
            if (d < bestDist) { bestDist = d; best = i; }
        });

        // 抑制緊接而來的殘留 click（避免放手指下方的 Tab 被重複觸發）
        capsule._suppressTap = true;
        clearTimeout(capsule._suppressTapTimer);
        capsule._suppressTapTimer = setTimeout(() => { capsule._suppressTap = false; }, NAV_TAP_SUPPRESS_MS);

        const target = items[best];
        if (target && target.dataset.tab && target.dataset.tab !== currentTab) {
            switchTab(target.dataset.tab);
        } else {
            moveNavPill(best, true);      // 拖回原頁 → 彈簧歸位，不重複重繪
        }

        // 拖尾淡出（CSS opacity transition），彈簧接手後就唔需要拖尾
        resetNavTrail();
    };

    capsule.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (pressing) return;

        // 新的觸碰開始 → 先解除上一次拖拽的 click 抑制
        capsule._suppressTap = false;
        clearTimeout(capsule._suppressTapTimer);

        const first = measureNavPill(items[0], capsule);
        const last = measureNavPill(items[items.length - 1], capsule);
        pillWidth = first.width;
        minX = first.x;
        maxX = last.x;

        // 轉成「膠囊本地座標」（translateX 值，原點＝膠囊 padding box）：
        // 優先讀 _navX —— 佢同 minX／maxX 同一座標系，而且滑塊處於拉伸（scaleX）
        // 狀態時 getBoundingClientRect 的寬度會失真；後備方案同樣要扣掉左邊框。
        startPillLeft = (typeof indicator._navX === 'number')
            ? indicator._navX
            : indicator.getBoundingClientRect().left - capsule.getBoundingClientRect().left - capsule.clientLeft;
        startX = e.clientX;
        startY = e.clientY;
        pointerId = e.pointerId;
        pressing = true;
        dragging = false;

        // 注意：此處刻意「不」呼叫 setPointerCapture！
        // 一旦捕獲指標，Tap 的 click 會被重定向到 capsule，
        // .nav-item 上的 click 就永遠收不到，導致點擊無法切換頁面。
        // 改用 window 層監聽，拖出膠囊外仍能完整跟手。
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
    });
}

// ================= 渲染課表 =================
function renderSchedule(mode) {
    const today = new Date();
    let targetDate = new Date(today);
    if (mode === 'tomorrow') targetDate.setDate(today.getDate() + 1);

    const dayOfWeek = targetDate.getDay();
    const dateString = `${targetDate.getFullYear()}年${targetDate.getMonth() + 1}月${targetDate.getDate()}日(${dayNames[dayOfWeek]})`;

    document.getElementById('schedule-title-text').textContent = mode === 'tomorrow' ? '明日課表' : '今日課表';
    document.getElementById('schedule-date-text').textContent = (mode === 'tomorrow' ? '明天日期是' : '今天是') + dateString;

    const listContainer = document.getElementById('schedule-list-container');
    const classes = scheduleData[dayOfWeek];

    if (!classes || classes.length === 0) {
        listContainer.innerHTML = `<div style="text-align:center; padding:60px 20px; color:var(--text-muted); font-size:22px; font-weight:bold;">${icon('sparkles', { size: 24 })} 今日/明日沒有課堂！</div>`;
        return;
    }

    const now = new Date();
    const currentSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

    let html = '';
    classes.forEach(item => {
        const [startH, startM] = item.start.split(':').map(Number);
        const [endH, endM] = item.end.split(':').map(Number);
        const startTotal = startH * 3600 + startM * 60;
        const endTotal = endH * 3600 + endM * 60;

        let isCurrent = false;
        if (mode === 'today' && currentSeconds >= startTotal && currentSeconds < endTotal) {
            isCurrent = true;
        }

        const isLongSubject = item.subject.length > 4;

        html += `
            <div class="class-card ${isCurrent ? 'current-class' : ''}">
                <div class="period">第<br><span>${item.period}</span><br>節</div>
                <div class="info">
                    <div class="subject ${isLongSubject ? 'long-text' : ''}">${item.subject}</div>
                    ${item.teacher ? `<div class="teacher">${item.teacher}</div>` : ''}
                    <div class="time">${item.start} ~ ${item.end}</div>
                </div>
            </div>
        `;
    });
    listContainer.innerHTML = html;
    if (typeof animateCardsIn === 'function') animateCardsIn(listContainer);
}

// ================= 即時倒數 =================
function updateRealtimeStatus() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    document.getElementById('live-clock').textContent = `${hh}:${mm}:${ss}`;

    // 課表載入失敗時，保留錯誤提示卡，唔好用空資料覆蓋
    if (scheduleLoadFailed) return;

    const currentDay = now.getDay();
    const currentClasses = scheduleData[currentDay] || [];
    const currentSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

    let currentSubject = null;
    let currentIndex = -1;
    let timeToNextEndInSeconds = 0;

    for (let i = 0; i < currentClasses.length; i++) {
        const cls = currentClasses[i];
        const [startH, startM] = cls.start.split(':').map(Number);
        const [endH, endM] = cls.end.split(':').map(Number);
        const startTotalSeconds = startH * 3600 + startM * 60;
        const endTotalSeconds = endH * 3600 + endM * 60;

        if (currentSeconds >= startTotalSeconds && currentSeconds < endTotalSeconds) {
            currentSubject = cls;
            currentIndex = i;
            timeToNextEndInSeconds = endTotalSeconds - currentSeconds;
        }
    }

    const lunchStartSeconds = 12 * 3600 + 15 * 60;
    const lunchEndSeconds = 14 * 3600 + 15 * 60;
    const isLunch = currentSeconds >= lunchStartSeconds && currentSeconds < lunchEndSeconds;

    const schoolEndSeconds = 15 * 3600 + 45 * 60;
    const isAfterSchool = currentSeconds >= schoolEndSeconds;

    const container = document.getElementById('status-container');
    let html = '';

    if (isLunch) {
        const isSaturday = currentDay === 6;

        if (isSaturday) {
            const remainingSeconds = lunchEndSeconds - currentSeconds;
            html += `
                <div class="status-card now">
                    <div class="status-header">
                        <div>NOW</div>
                        <div class="countdown">
                            <div class="countdown-label">距離<br>上課時間</div>
                            <div class="countdown-number">${formatTime(remainingSeconds)}</div>
                        </div>
                    </div>
                    <div class="status-body">
                        <div class="subject">午休</div>
                        <div class="time-range">12:15 ~ 14:15</div>
                    </div>
                </div>
            `;
        } else {
            const faceStartSeconds = 13 * 3600 + 30 * 60;
            const faceEndSeconds = 14 * 3600 + 10 * 60;

            if (currentSeconds < faceStartSeconds) {
                const remaining = faceStartSeconds - currentSeconds;
                html += `
                    <div class="status-card now">
                        <div class="status-header">
                            <div>NOW</div>
                            <div class="countdown">
                                <div class="countdown-label">距離<br>刷臉開始</div>
                                <div class="countdown-number">${formatTime(remaining)}</div>
                            </div>
                        </div>
                        <div class="status-body">
                            <div class="subject">午休</div>
                            <div class="time-range">12:15 ~ 13:30</div>
                        </div>
                    </div>
                `;
            } else if (currentSeconds >= faceStartSeconds && currentSeconds < faceEndSeconds) {
                const remaining = faceEndSeconds - currentSeconds;
                const lunchRemaining = lunchEndSeconds - currentSeconds;
                let timeRangeText = lunchRemaining > 0
                    ? `距離午休完結 ${formatTime(lunchRemaining)}`
                    : `午休已完結`;

                html += `
                    <div class="status-card now">
                        <div class="status-header">
                            <div>NOW</div>
                            <div class="countdown">
                                <div class="countdown-label">刷臉<br>剩餘時間</div>
                                <div class="countdown-number">${formatTime(remaining)}</div>
                            </div>
                        </div>
                        <div class="status-body">
                            <div class="subject">刷臉中</div>
                            <div class="time-range">${timeRangeText}</div>
                        </div>
                    </div>
                `;
            } else {
                const remainingSeconds = lunchEndSeconds - currentSeconds;
                html += `
                    <div class="status-card now">
                        <div class="status-header">
                            <div>NOW</div>
                            <div class="countdown">
                                <div class="countdown-label">距離<br>上課時間</div>
                                <div class="countdown-number">${formatTime(remainingSeconds)}</div>
                            </div>
                        </div>
                        <div class="status-body">
                            <div class="subject">午休</div>
                            <div class="time-range">14:10 ~ 14:15</div>
                        </div>
                    </div>
                `;
            }
        }
    } else if (currentSubject) {
        const isLongSubject = currentSubject.subject.length > 4;
        html += `
            <div class="status-card now">
                <div class="status-header">
                    <div>NOW</div>
                    <div class="countdown">
                        <div class="countdown-label">剩餘<br>時間</div>
                        <div class="countdown-number">${formatTime(timeToNextEndInSeconds)}</div>
                    </div>
                </div>
                <div class="status-body">
                    <div class="subject ${isLongSubject ? 'long-text' : ''}">${currentSubject.subject}</div>
                    <div class="teacher">${currentSubject.teacher || ''}</div>
                    <div class="time-range">${currentSubject.start} ~ ${currentSubject.end}</div>
                </div>
            </div>
        `;
    } else if (isAfterSchool) {
        html += `
            <div class="status-card now dismissed">
                <div class="status-header">
                    <div>NOW</div>
                    <div class="countdown">
                        <div class="countdown-label">狀態</div>
                        <div class="countdown-number">放學</div>
                    </div>
                </div>
                <div class="status-body">
                    <div class="subject dismissed-subject">${icon('sparkles', { size: 17 })} 已放學</div>
                    <div class="time-range dismissed-time">15:45 下課</div>
                </div>
            </div>
        `;
    } else if (!currentSubject) {
        // 小休時段：取最近一堂已完結課堂嘅結束時間做開始時間
        let lastClassEnd = "";
        for (let i = 0; i < currentClasses.length; i++) {
            const cls = currentClasses[i];
            const [endH, endM] = cls.end.split(':').map(Number);
            if (endH * 3600 + endM * 60 <= currentSeconds) {
                lastClassEnd = cls.end;
            }
        }
        let nextSubject = null;
        for (let i = 0; i < currentClasses.length; i++) {
            const cls = currentClasses[i];
            const [startH, startM] = cls.start.split(':').map(Number);
            const startTotalSeconds = startH * 3600 + startM * 60;
            if (currentSeconds < startTotalSeconds) {
                nextSubject = cls;
                break;
            }
        }
        if (nextSubject) {
            const [startH, startM] = nextSubject.start.split(':').map(Number);
            const startTotalSeconds = startH * 3600 + startM * 60;
            const timeToNextStart = startTotalSeconds - currentSeconds;
            html += `
                <div class="status-card now">
                    <div class="status-header">
                        <div>NOW</div>
                        <div class="countdown">
                            <div class="countdown-label">距離<br>上課時間</div>
                            <div class="countdown-number">${formatTime(timeToNextStart)}</div>
                        </div>
                    </div>
                    <div class="status-body">
                        <div class="subject">小休</div>
                        <div class="time-range">${lastClassEnd} ~ ${nextSubject.start}</div>
                    </div>
                </div>
            `;
        } else {
            html += `
                <div class="status-card now" style="background-color: #444;">
                    <div class="status-header" style="background-color: #666;">
                        <div>NOW</div>
                        <div class="countdown">
                            <div class="countdown-label">狀態</div>
                            <div class="countdown-number">無課</div>
                        </div>
                    </div>
                    <div class="status-body" style="background-color: #2c2c2e;">
                        <div class="subject" style="font-size: 28px;">今日無課堂</div>
                    </div>
                </div>
            `;
        }
    }

    if (!isAfterSchool) {
        if (isLunch) {
            let afternoonSubject = null;
            for (let i = 0; i < currentClasses.length; i++) {
                const cls = currentClasses[i];
                const [startH, startM] = cls.start.split(':').map(Number);
                const startTotalSeconds = startH * 3600 + startM * 60;
                if (startTotalSeconds >= lunchEndSeconds) {
                    afternoonSubject = cls;
                    break;
                }
            }
            if (afternoonSubject) {
                const [startH, startM] = afternoonSubject.start.split(':').map(Number);
                const startTotalSeconds = startH * 3600 + startM * 60;
                const timeToAfternoon = startTotalSeconds - currentSeconds;
                const isLongSubject = afternoonSubject.subject.length > 4;
                html += `
                    <div class="status-card coming">
                        <div class="status-header">
                            <div>Coming<br>Up</div>
                            <div class="countdown">
                                <div class="countdown-label">距離<br>下堂課</div>
                                <div class="countdown-number">${formatTime(timeToAfternoon)}</div>
                            </div>
                        </div>
                        <div class="status-body">
                            <div class="subject ${isLongSubject ? 'long-text' : ''}">${afternoonSubject.subject}</div>
                            <div class="teacher">${afternoonSubject.teacher || ''}</div>
                            <div class="time-range">${afternoonSubject.start} ~ ${afternoonSubject.end}</div>
                        </div>
                    </div>
                `;
            }
        } else if (currentSubject) {
            let nextEventName = "小休";
            let nextEventTime = "";
            let countdownSeconds = 0;
            if (currentSubject.end === "12:15") {
                nextEventName = "午休";
                nextEventTime = "12:15 ~ 14:15";
                countdownSeconds = timeToNextEndInSeconds;
            } else {
                const nextClass = currentClasses[currentIndex + 1];
                nextEventName = "小休";
                nextEventTime = `${currentSubject.end} ~ ${nextClass ? nextClass.start : "15:45"}`;
                countdownSeconds = timeToNextEndInSeconds;
            }
            html += `
                <div class="status-card coming">
                    <div class="status-header">
                        <div>Coming<br>Up</div>
                        <div class="countdown">
                            <div class="countdown-label">距離<br>${nextEventName}</div>
                            <div class="countdown-number">${formatTime(countdownSeconds)}</div>
                        </div>
                    </div>
                    <div class="status-body">
                        <div class="subject">${nextEventName}</div>
                        <div class="time-range">${nextEventTime}</div>
                    </div>
                </div>
            `;
        } else {
            let nextSubject = null;
            for (let i = 0; i < currentClasses.length; i++) {
                const cls = currentClasses[i];
                const [startH, startM] = cls.start.split(':').map(Number);
                const startTotalSeconds = startH * 3600 + startM * 60;
                if (currentSeconds < startTotalSeconds) {
                    nextSubject = cls;
                    break;
                }
            }
            if (nextSubject) {
                const [startH, startM] = nextSubject.start.split(':').map(Number);
                const startTotalSeconds = startH * 3600 + startM * 60;
                const timeToNextStart = startTotalSeconds - currentSeconds;
                const isLongSubject = nextSubject.subject.length > 4;
                html += `
                    <div class="status-card coming">
                        <div class="status-header">
                            <div>Coming<br>Up</div>
                            <div class="countdown">
                                <div class="countdown-label">距離<br>下堂課</div>
                                <div class="countdown-number">${formatTime(timeToNextStart)}</div>
                            </div>
                        </div>
                        <div class="status-body">
                            <div class="subject ${isLongSubject ? 'long-text' : ''}">${nextSubject.subject}</div>
                            <div class="teacher">${nextSubject.teacher || ''}</div>
                            <div class="time-range">${nextSubject.start} ~ ${nextSubject.end}</div>
                        </div>
                    </div>
                `;
            }
        }
    }

    const existingNowCard = container.querySelector('.status-card.now');
    const existingComingCard = container.querySelector('.status-card.coming');

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    const newNowCard = tempDiv.querySelector('.status-card.now');
    const newComingCard = tempDiv.querySelector('.status-card.coming');

    const nowCardType = existingNowCard ? existingNowCard.querySelector('.subject')?.textContent || '' : '';
    const newNowCardType = newNowCard ? newNowCard.querySelector('.subject')?.textContent || '' : '';
    const nowCardHeader = existingNowCard ? existingNowCard.querySelector('.countdown-label')?.textContent || '' : '';
    const newNowCardHeader = newNowCard ? newNowCard.querySelector('.countdown-label')?.textContent || '' : '';

    const needRebuild =
        !existingNowCard || !newNowCard ||
        nowCardType !== newNowCardType ||
        nowCardHeader !== newNowCardHeader ||
        (existingComingCard === null) !== (newComingCard === null) ||
        (existingComingCard && newComingCard &&
            (existingComingCard.querySelector('.subject')?.textContent || '') !== (newComingCard.querySelector('.subject')?.textContent || ''));

    if (needRebuild) {
        container.innerHTML = html;
        if (typeof animateCardsIn === 'function') animateCardsIn(container);
    } else {
        const updateCard = (existingCard, newCard) => {
            if (!existingCard || !newCard) return;
            const existingNumber = existingCard.querySelector('.countdown-number');
            const newNumber = newCard.querySelector('.countdown-number');
            if (existingNumber && newNumber) existingNumber.textContent = newNumber.textContent;

            const existingTimeRange = existingCard.querySelector('.time-range');
            const newTimeRange = newCard.querySelector('.time-range');
            if (existingTimeRange && newTimeRange) existingTimeRange.textContent = newTimeRange.textContent;

            const existingTeacher = existingCard.querySelector('.teacher');
            const newTeacher = newCard.querySelector('.teacher');
            if (existingTeacher && newTeacher) existingTeacher.textContent = newTeacher.textContent;
        };
        updateCard(existingNowCard, newNowCard);
        updateCard(existingComingCard, newComingCard);
    }
}

// ================= 輔助函式 =================
function formatTime(totalSeconds) {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// ================= 搜尋功能 =================
function initSearch() {
    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');
    if (!searchInput) return;

    searchInput.addEventListener('input', (e) => {
        const keyword = e.target.value.trim();
        if (keyword === '') {
            searchResults.innerHTML = '';
            searchResults.classList.remove('active');
            return;
        }

        const parsedDate = parseDateInput(keyword);
        let results = [];

        if (parsedDate) {
            results = searchByDate(parsedDate);
        } else {
            results = searchByKeyword(keyword);
        }

        if (results.length === 0) {
            searchResults.innerHTML = `<div class="search-empty">${icon('inbox', { size: 18 })} 找不到相關結果</div>`;
        } else {
            searchResults.innerHTML = results.map(r => r.html).join('');
        }
        searchResults.classList.add('active');
    });

    document.addEventListener('click', (e) => {
        if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
            searchResults.classList.remove('active');
        }
    });
}

function parseDateInput(input) {
    const currentYear = new Date().getFullYear();
    const text = input.trim().toLowerCase();

    let match = text.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
    if (match) return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));

    match = text.match(/^(\d{1,2})月(\d{1,2})日?$/);
    if (match) return new Date(currentYear, parseInt(match[1]) - 1, parseInt(match[2]));

    match = text.match(/^(\d{1,2})[\.\-\,\/](\d{1,2})$/);
    if (match) return new Date(currentYear, parseInt(match[1]) - 1, parseInt(match[2]));

    const monthNames = {
        january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
        april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
        august: 8, aug: 8, september: 9, sep: 9, sept: 9,
        october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12
    };

    match = text.match(/^(\d{1,2})\s*(?:st|nd|rd|th)?\s+([a-z]+)$/);
    if (match && monthNames[match[2]]) return new Date(currentYear, monthNames[match[2]] - 1, parseInt(match[1]));

    match = text.match(/^([a-z]+)\s+(\d{1,2})\s*(?:st|nd|rd|th)?$/);
    if (match && monthNames[match[1]]) return new Date(currentYear, monthNames[match[1]] - 1, parseInt(match[2]));

    match = text.match(/^(\d{3,4})$/);
    if (match) {
        const num = match[1];
        if (num.length === 3) {
            const m = parseInt(num[0]);
            const d = parseInt(num.slice(1));
            if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return new Date(currentYear, m - 1, d);
        } else {
            const m = parseInt(num.slice(0, 2));
            const d = parseInt(num.slice(2));
            if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return new Date(currentYear, m - 1, d);
        }
    }

    return null;
}

function searchByDate(date) {
    const results = [];
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dayOfWeek = date.getDay();

    const matchedHolidays = holidaysData.filter(h => {
        if (!h.endDate) return h.date === dateStr;
        return dateStr >= h.date && dateStr <= h.endDate;
    });

    const isSunday = dayOfWeek === 0;
    const isHoliday = matchedHolidays.length > 0;

    if (isHoliday) {
        matchedHolidays.forEach(h => {
            results.push({
                html: `
                    <div class="search-item holiday-item">
                        <div class="search-day">${icon('sparkles', { size: 14 })} 假期</div>
                        <div class="search-subject">${contentIcon(h.emoji || h.icon, { size: 14, fallback: 'sparkles' })} ${escapeHtml(h.name)}</div>
                        <div class="search-info">${h.date}${h.endDate && h.endDate !== h.date ? ' ~ ' + h.endDate : ''}</div>
                        ${h.note ? `<div class="search-info">${h.note}</div>` : ''}
                    </div>
                `
            });
        });
        return results;
    }

    if (isSunday) {
        results.push({
            html: `
                <div class="search-item">
                    <div class="search-day">${icon('calendar', { size: 14 })} ${dateStr}（週日）</div>
                    <div class="search-subject">週日</div>
                    <div class="search-info">放假一天</div>
                </div>
            `
        });
        return results;
    }

    const classes = scheduleData[dayOfWeek] || [];
    if (classes.length > 0) {
        classes.forEach(cls => {
            results.push({
                html: `
                    <div class="search-item">
                        <div class="search-day">${icon('calendar', { size: 14 })} ${dateStr}（星期${dayNames[dayOfWeek]}）第${cls.period}節</div>
                        <div class="search-subject">${escapeHtml(cls.subject)}</div>
                        <div class="search-info">${cls.teacher || ''} · ${cls.start} ~ ${cls.end}</div>
                    </div>
                `
            });
        });
    } else {
        results.push({
            html: `
                <div class="search-item">
                    <div class="search-day">${icon('calendar', { size: 14 })} ${dateStr}（星期${dayNames[dayOfWeek]}）</div>
                    <div class="search-subject">沒有特別事項</div>
                    <div class="search-info">沒有假期或課堂</div>
                </div>
            `
        });
    }

    return results;
}

function searchByKeyword(keyword) {
    const results = [];
    const lowerKeyword = keyword.toLowerCase();

    Object.keys(scheduleData).forEach(day => {
        scheduleData[day].forEach(cls => {
            const subjectMatch = cls.subject.toLowerCase().includes(lowerKeyword);
            const teacherMatch = cls.teacher && cls.teacher.toLowerCase().includes(lowerKeyword);
            if (subjectMatch || teacherMatch) {
                results.push({
                    html: `
                        <div class="search-item">
                            <div class="search-day">星期${dayNames[day]} 第${cls.period}節</div>
                            <div class="search-subject">${cls.subject}</div>
                            <div class="search-info">${cls.teacher || ''} · ${cls.start} ~ ${cls.end}</div>
                        </div>
                    `
                });
            }
        });
    });

    return results;
}

// ================= 啟動 =================
window.onload = initApp;