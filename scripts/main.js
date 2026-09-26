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

// 課表「有冇實質內容」？
// ⚠ 絕對唔可以用 Object.keys(scheduleData).length 判斷「載入成功」：
//    db.js 嘅 normalize() 會固定補齊「1~6」（週一至週六）6 條 key，
//    即係「載入失敗 → 內建備援 {}」同「載入成功但本週未有課」正規化之後係一模一樣，
//    舊寫法會令 scheduleLoadFailed 永遠係 false → 斷網時靜靜地顯示一張空課表，
//    連帶 #splash-status 嘅「重新連線中…」提示亦永遠唔會出現。
//    呢個判斷負責分開兩者：至少一日有課堂，才算真正攞到課表。
function hasScheduleContent(value) {
    if (!value || typeof value !== 'object') return false;
    return Object.keys(value).some(day => Array.isArray(value[day]) && value[day].length > 0);
}

// ================= 啟動時序參數（品牌 Splash / 首屏預算 / 網絡超時） =================
// 品牌 Splash 規範（Loading 體驗）：
//   ① < 100ms 立即登場 —— 由 index.html 內嵌 #splash-critical-css 保證（唔經 JS、唔等網絡）
//   ② 品牌動畫最少播 2.5s（規範 2.0~3.0s）→ 0.45s 品牌轉場 → 200ms 淡出
//   ③ 無數據 / 無網絡 / 載入失敗 → Logo 保持循環動畫 ＋ 底部微弱提示，嚴禁黑屏
//   · SPLASH_MIN_MS       品牌動畫最少播放時間（規範 2.0~3.0s，取中位 2.5s）
//   · SPLASH_MAX_MS       首屏資料未就緒時最多等幾久就照入 App（之後交骨架屏／錯誤卡接手）
//   · SPLASH_FAIL_HOLD_MS 已知載入失敗時，底部提示停留幾久就入 App（App 有錯誤卡 ＋ 重試）
//   · SPLASH_LEAVE_MS     品牌轉場（白圓擴散＋Logo 放大）時長，必須同 CSS .splash-leaving 一致
//   · SPLASH_FADE_MS      淡出 200ms，必須同 CSS #splash-screen.hidden 嘅 transition 一致
//   · SPLASH_POLL_MS      等待期間狀態檢查間隔（純本機計時器）
//   · SPLASH_HINT_HOLD_MS 逾時提示最少停留時間，避免「一閃而過」
// 鐵律：首屏絕對唔等網絡。所有網絡請求一律撥去「背景靜默更新」。
//   · FIRST_PAINT_BUDGET_MS 首屏資料最多等幾久（本機快取命中時實際 ≈ 0ms）
//   · DATA_TIMEOUT_MS 背景更新嘅 Fetch 超時上限：逾時就繼續用本機快取，唔會無限轉圈
const FIRST_PAINT_BUDGET_MS = 100;
const SPLASH_MIN_MS = 2500;
const SPLASH_MAX_MS = 5500;
const SPLASH_FAIL_HOLD_MS = 1200;
const SPLASH_LEAVE_MS = 450;
const SPLASH_FADE_MS = 200;
const SPLASH_POLL_MS = 120;
const SPLASH_HINT_HOLD_MS = 800;
const DATA_TIMEOUT_MS = 1200;

// 底部提示文案（規範例子：正在獲取最新課表…／重新連線中）
const SPLASH_TEXT_LOADING = '正在獲取最新課表…';
const SPLASH_TEXT_RETRY = '重新連線中…';

function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

// 為任何 Promise 加上「時間上限」：逾時即刻 reject，唔會無限等網絡
function withTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error((label || '請求') + '超時（' + ms + 'ms）'));
        }, ms);
    });

    return Promise.race([Promise.resolve(promise), timeout]).then(
        (value) => { clearTimeout(timer); return value; },
        (error) => { clearTimeout(timer); throw error; }
    );
}

// ================= 初始化 =================
// 啟動流程（品牌動畫同資料並行，任何情況都唔會黑屏）：
//   ① 品牌 Splash：index.html 內嵌 CSS 已經喺第一幀畫好 Logo 動畫（< 100ms、零 JS、零網絡）
//   ② 帳號／session：純 localStorage 讀取，零網絡
//   ③ 暖啟動 hydrateFromLocalCache()：純同步讀 localStorage（無 await、無網絡、無 fetch）
//      → 班級清單、課表鏡像、假期即刻入記憶體，實測 < 5ms
//   ④ 課表＋假期：本機命中 → 一個 microtask 完成；冷啟動最多等 FIRST_PAINT_BUDGET_MS 就先畫
//   ⑤ 首屏 initAppShell()：純本機，立即完成第一次繪製（配合內嵌骨架屏，唔會空白）
//   ⑥ 品牌 Splash 收尾 finishBrandSplash()：最少播滿 SPLASH_MIN_MS；資料未就緒 →
//      保持循環動畫 ＋ 底部微弱提示（嚴禁黑屏），最多等到 SPLASH_MAX_MS 就照入 App
//   ⑦ 背景靜默更新 revalidateAppData()：stale-while-revalidate，唔阻塞任何操作
async function initApp() {
    // 計時起點＝index.html 開機腳本記低嘅「第一幀」時刻，令品牌動畫真正播滿 2.5s
    const startedAt = splashClock();

    // ① 帳號／session：純 localStorage 讀取，零網絡。
    //    必須排喺暖啟動之前：authResolveSchedule() 要靠帳號／裝置偏好才知道要讀邊班課表。
    let account = null;
    try {
        if (typeof authInit === 'function') account = authInit();
    } catch (e) {
        console.warn('[Init] 讀取帳號失敗:', e);
    }

    // ② 同步暖啟動（零網絡）：呢一步就係「秒開」嘅關鍵
    hydrateFromLocalCache();

    // ③ 課表：本機命中 → 一個 microtask 就完成；冷啟動最多等 FIRST_PAINT_BUDGET_MS 就先畫。
    //    呢個 promise 亦係後段判斷「首屏資料係咪已就緒」嘅唯一依據 ——
    //    withTimeout 只係 Promise.race，唔會 abort，所以 Splash 可以繼續等佢嘅真實結果。
    const firstLoad = safePromise(() => applyClassSchedule(account));
    try {
        await withTimeout(firstLoad, FIRST_PAINT_BUDGET_MS, '首屏課表');
    } catch (error) {
        // 逾時唔算錯誤：applyClassSchedule 內部完成後會自己 refreshScheduleViews() 補畫
        console.warn('[Init] ' + (error && error.message ? error.message : error) +
            ' → 先用本機快取畫畫面，網絡版本稍後自動補上');
        applyLocalCache();
    }

    // ④ 假期：同樣唔可以阻塞首屏
    try {
        await withTimeout(loadHolidaysCached(), FIRST_PAINT_BUDGET_MS, '首屏假期');
    } catch (error) { /* 背景更新會補上 */ }

    // ⑤ 首次繪製：純本機，任何情況都一定要跑
    initAppShell();

    // ⑥ 品牌 Splash 收尾：最少播滿 2.5s；資料未到就持續循環動畫 ＋ 底部微弱提示
    await finishBrandSplash(startedAt, firstLoad);

    // ⑦ 背景靜默更新（刻意唔 await：用戶此刻已經可以正常操作）
    revalidateAppData();
}

// 品牌 Splash 計時起點：優先用 index.html 開機腳本記低嘅 __BOOT_T0（＝第一幀時刻），
// 令品牌動畫真正播滿 2.5s 之餘，亦唔會因為 main.js 遲載入而縮短品牌動畫。
function splashClock() {
    const now = nowMs();
    const t0 = (typeof window !== 'undefined') ? Number(window.__BOOT_T0) : NaN;
    return (Number.isFinite(t0) && t0 >= 0 && t0 <= now) ? t0 : now;
}

// 包一層：令「同步拋錯」嘅函式都變成一個 reject 咗嘅 Promise，唔會炸穿啟動流程
function safePromise(factory) {
    try {
        return Promise.resolve(factory());
    } catch (e) {
        return Promise.reject(e);
    }
}

// ---------- 暖啟動：只用 localStorage，全程同步（零網絡、零 await） ----------
/**
 * 「秒開」核心。呢個函式唔會發任何網絡請求，亦唔回傳 Promise：
 *   · 班級清單 → authLoadClassesSync()（DB 記憶體 → auth_classes_cache → 內建備援清單）
 *   · 課表     → DB.load() 命中 localStorage 覆寫／鏡像時係「同步」完成，
 *                所以呼叫之後 DB.get() 已經有齊資料，唔需要 await
 *   · 假期     → 同上（唔同步命中就唔讀，留返俾背景更新）
 * 回傳 true ＝ 本機已經有足夠資料畫首屏（即係今次啟動唔需要等網絡）。
 */
function hydrateFromLocalCache() {
    let warm = false;

    try {
        // ① 班級清單（同步版）＋ 為每個班級註冊 DataManager 集合定義
        if (typeof authLoadClassesSync === 'function') authLoadClassesSync();
        const classes = (typeof authGetClassList === 'function' && authGetClassList()) || [];
        if (classes.length && typeof dbRegisterAllSchedules === 'function') {
            dbRegisterAllSchedules(classes);
        }

        // ② 課表：先解析裝置／帳號揀咗邊班，再同步讀本機副本
        if (typeof authResolveSchedule === 'function') {
            const current = (typeof authGetCurrentAccount === 'function') ? authGetCurrentAccount() : null;
            const resolved = authResolveSchedule(current || null);

            if (resolved && resolved.reason === 'unselected') {
                warm = true;            // 未揀班級 → 首屏只需要引導卡，本身唔需要任何資料
            } else if (resolved && resolved.classId) {
                const name = dbScheduleName(resolved.classId);

                // 班級清單今次未同步命中時，上面嘅 dbRegisterAllSchedules 唔會執行，
                // 集合定義就可能未註冊 —— 而 DB.load 對未註冊集合係回傳 rejected promise，
                // 上面嘅 try/catch 接唔到，會變成 unhandledrejection（主控台紅色錯誤）。
                // 所以呢度先補註冊，註冊唔到就索性唔讀，留返俾正常（網絡）流程處理。
                if (!DB.def(name) && typeof dbRegisterSchedule === 'function' && resolved.url) {
                    dbRegisterSchedule(resolved.classId, resolved.url,
                                       dbScheduleLabel(resolved.classId, resolved.className));
                }

                const hasLocalCopy = DB.def(name) &&
                    (DB.readStored(name) !== null || dbReadMirror(name) !== null);

                if (hasLocalCopy) {
                    // 本機命中 → 同步填好記憶體快取；catch 只係防禦，正常唔會 reject
                    DB.load(name, { force: true }).catch(() => {});
                    const data = DB.get(name);
                    warm = !!(data && Object.keys(data).length);
                }
            }
        }

        // ③ 假期：有本機副本就同步預熱（無都絕對唔等）
        if (DB.readStored('holidays') !== null || dbReadMirror('holidays') !== null) {
            DB.load('holidays');
        }
    } catch (e) {
        console.warn('[Init] 暖啟動讀本機快取失敗，改用正常（網絡）流程:', e);
    }

    return warm;
}

// 首屏用：讀假期（本機命中時同步完成；冷啟動由呼叫者加時間上限）
async function loadHolidaysCached() {
    await DB.load('holidays');
    const value = DB.get('holidays');
    if (Array.isArray(value)) holidaysData = value;
}

// ---------- 背景靜默更新（stale-while-revalidate，唔阻塞任何畫面） ----------
/**
 * 畫面畫好之後才執行：
 *   · 班級清單：schema 版本檢查 + 重讀最新 classes.json
 *   · 課表：跳過本機鏡像直接抓靜態檔；抓到就更新記憶體＋鏡像並補畫，
 *           抓唔到就「保留本機快取版本」，絕對唔會喺用戶面前變成錯誤卡
 *   · 假期：同上
 * 全程零 Loading UI、零轉圈，用戶完全感覺唔到。
 */
async function revalidateAppData() {
    const before = bootSignature();

    try {
        // 班級清單版本檢查：若 data/classes.json 的 schemaVersion 同上次記錄唔一致，
        // 先清掉 localStorage 內殘留嘅舊班級快取，否則舊清單會永遠蓋過新版 classes.json。
        if (typeof dbEnsureClassesSchema === 'function') await dbEnsureClassesSchema();
        if (typeof authLoadClasses === 'function') await authLoadClasses(true);
    } catch (e) {
        console.warn('[Init] 背景更新班級清單失敗，繼續用本機快取:', e);
    }

    // 班級清單剛剛更新過 → 重新解析一次：如果班級／課表路徑有變（換屆、schema 更新），
    // 就整份重新載入；路徑無變就交返俾下面嘅靜默更新（慳一次重繪）
    let scheduleFresh = false;
    try {
        let account = null;
        if (typeof authInit === 'function') account = authInit();
        const resolved = (typeof authResolveSchedule === 'function') ? authResolveSchedule(account) : null;
        const resolvedName = (resolved && resolved.classId) ? dbScheduleName(resolved.classId) : '';
        if (resolvedName && resolvedName !== currentScheduleName) {
            await applyClassSchedule(account, true, { refresh: true });
            scheduleFresh = true;
        }
    } catch (e) {
        console.warn('[Init] 背景重解析班級課表失敗，繼續用本機快取:', e);
    }

    if (!scheduleFresh) {
        try {
            await withTimeout(revalidateScheduleSilently(), DATA_TIMEOUT_MS, '背景更新課表');
        } catch (e) {
            console.warn('[Init] ' + (e && e.message ? e.message : e) + ' → 繼續用本機快取');
        }
    }

    try {
        await withTimeout(DB.load('holidays', { force: true, refresh: true }), DATA_TIMEOUT_MS, '背景更新假期');
        const fresh = DB.get('holidays');
        if (Array.isArray(fresh) && fresh.length) holidaysData = fresh;
    } catch (e) {
        console.warn('[Init] 背景更新假期失敗，繼續用本機快取:', e);
    }

    // 內容真係有變才補畫一次：避免用戶正在閱讀時無謂重繪
    if (bootSignature() !== before && typeof refreshScheduleViews === 'function') {
        refreshScheduleViews();
    }

    // 帳號雲端同步：刻意唔 await（帳號慢／離線都唔可以拖住課表更新）
    syncAccountCloudSilently();
}

// ---------- 帳號雲端同步（Google Sheets，背景執行） ----------
/**
 * 啟動時的背景帳號同步：
 *   ① 先補送離線期間累積的寫入（例如斷網時改過班級）
 *   ② 再向雲端校驗目前帳號是否已有更新的版本（例如在另一部裝置改過頭像／班級）
 * 全程唔阻塞、唔顯示 Loading；失敗一律靜默保留本機版本，下次啟動再試。
 * 本機更新過就通知個人中心重繪，令用戶即刻見到最新資料。
 */
function syncAccountCloudSilently() {
    if (typeof cloudEnabled !== 'function' || !cloudEnabled()) return;
    if (typeof cloudBootstrap !== 'function') return;

    const account = (typeof authGetCurrentAccount === 'function') ? authGetCurrentAccount() : null;

    cloudBootstrap(account).then(result => {
        if (result && result.pulled && typeof refreshAccountViews === 'function') {
            refreshAccountViews();
        }
    }).catch(() => { /* 帳號同步失敗唔應該影響任何功能 */ });
}

// 帳號資料由雲端更新之後，把相關畫面重新畫一次（純 UI，唔涉及網絡）
function refreshAccountViews() {
    if (typeof renderProfileHeader === 'function') renderProfileHeader();
    if (typeof renderProfileHome === 'function') renderProfileHome();
    if (typeof renderAccountsList === 'function') renderAccountsList();
}

// 背景更新「目前畫面正在用嘅」那份課表。失敗一律保留本機快取版本。
async function revalidateScheduleSilently() {
    const name = currentScheduleName;
    if (!name) return;                                          // 未揀班級 → 無課表要更新

    // 用戶／開發者改過（localStorage 覆寫）→ 背景更新唔可以蓋掉佢
    if (DB.readStored(name) !== null) return;

    const fresh = await DB.load(name, { force: true, refresh: true });
    if (!hasScheduleContent(fresh)) {
        throw new Error('課表靜態檔讀唔到或係空嘅');
    }

    scheduleData = fresh;
    scheduleLoadFailed = false;
    scheduleLoadFailedReason = '';
}

// 課表＋假期內容嘅輕量簽名（課表約 5KB，stringify 成本 < 1ms，只在啟動時計兩次）
function bootSignature() {
    try {
        return JSON.stringify(scheduleData) + '||' + JSON.stringify(holidaysData);
    } catch (e) {
        return '';
    }
}

// ---------- 離線降級：直接用 localStorage／記憶體內已經有嘅版本 ----------
// 呢個函式唔會發出任何網絡請求，所以喺「無網 / 弱網」情況下係即時完成。
function applyLocalCache() {
    try {
        if (currentScheduleName && typeof DB.isLoaded === 'function' && DB.isLoaded(currentScheduleName)) {
            const cached = DB.get(currentScheduleName);
            if (hasScheduleContent(cached)) {
                scheduleData = cached;
                scheduleLoadFailed = false;
            }
        }

        const cachedHolidays = (typeof DB.readStored === 'function') ? DB.readStored('holidays') : null;
        if (Array.isArray(cachedHolidays)) holidaysData = cachedHolidays;
    } catch (e) {
        console.warn('[Init] 讀取本機離線快取失敗:', e);
    }
}

// ---------- 一次性清理：已廢除功能的 localStorage 殘留 ----------
/**
 * 移除舊版「開發者模式」遺下嘅 localStorage 旗標。
 *
 * ⚠ 呢步唔可以省：開發者模式嘅開關係存喺 localStorage（dev_mode_enabled），
 *    單純刪掉程式碼並唔會令已經寫入嘅值消失。雖然移除之後已經冇任何程式碼
 *    會讀佢，但留喺度嘅 stale flag 一來佔空間、二來會令日後除錯時
 *    誤以為開發者模式仍然存在。順手清掉先算真正「徹底移除」。
 */
function purgeLegacyDevFlags() {
    try {
        localStorage.removeItem('dev_mode_enabled');   // 開發者模式開關
        localStorage.removeItem('dev_auth_guard_v1');  // 密碼錯誤次數／凍結時間
    } catch (e) {
        // 私密瀏覽模式等情況下 localStorage 可能不可用 —— 唔應該因此中斷啟動
        console.warn('[Init] 清理舊版開發者模式旗標失敗:', e);
    }
}

// ---------- 階段 ②：App 外殼（純本機、零網絡依賴） ----------
function initAppShell() {
    initTheme();
    initSearch();
    initCardExpand();
    initCalendar();
    initProfile();
    // 「選擇日期」chip（連同透明 <input type="date">）已徹底移除，
    // 日曆初始化邏輯 scheduleInitDatePicker() 一併刪除；日期切換只靠今天 / 明天。

    purgeLegacyDevFlags();

    renderWeeklyGrid();
    renderHolidays();

    if (scheduleLoadFailed) {
        renderScheduleLoadError();
    }

    // DB 有任何改動（雲端同步拉取、班級清單更新）→ 即時重繪對應畫面
    initDbBridge();

    // Liquid Glass：把折射／邊緣光／色散套到 TabBar 膠囊與滑塊上
    initLiquidGlass();

    // 課表頁預設日期：開 App 呢一刻就用 15:45 規則定好（< 15:45 → 今日；>= 15:45 → 明日），
    // 之後用戶撳「今天 / 明天」或日期選擇器就一律以手動選擇為準，唔會再被規則覆蓋。
    renderSchedule();

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

    // 即時倒數：每秒更新（只在「倒數」頁 active 時才計算）
    startRealtimeClock();
}

// 即時倒數計時器（獨立函式，方便重入保護：只會啟動一次）
let realtimeClockTimer = null;
function startRealtimeClock() {
    if (realtimeClockTimer) return;
    updateRealtimeStatus();   // 即刻出時間，唔等第一次 tick
    realtimeClockTimer = setInterval(() => {
        const page = document.getElementById('page-realtime');
        if (page && page.classList.contains('active')) updateRealtimeStatus();

        // 課表頁的「當前上課節數高亮」同樣要跟時間走：
        // 換節 / 落堂時才重繪，平時零動作（見 syncScheduleNowHighlight）。
        if (typeof syncScheduleNowHighlight === 'function') syncScheduleNowHighlight();
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
    // 無參數 → 沿用目前選取日期（唔會重置用戶手動揀嘅日子）
    if (currentTab === 'page-schedule' && typeof renderSchedule === 'function') renderSchedule();
    if (currentTab === 'page-calendar' && typeof renderCalendar === 'function') renderCalendar();
    updateRealtimeStatus();
}

/**
 * 依帳號班級載入對應課表（供 profile.js 登入 / 切換帳號 / 登出時呼叫）。
 * 資料一律經 DataManager（集合名 schedule:<classId>）：
 *   localStorage 覆寫（開發者面板改過）→ 班級課表 JSON → 預設課表 → 錯誤卡
 * 回傳 { url, isDefault, className, failed }
 */
async function applyClassSchedule(account, force, options) {
    // authResolveSchedule 用同步版清單，第一次要先確保清單載好。
    // 暖啟動已經用 authLoadClassesSync() 填好清單，所以正常情況下呢個 if 唔會成立、
    // 亦唔會發出網絡請求 —— 呢點對「首屏 ≤ 100ms」好關鍵。
    if (typeof authLoadClasses === 'function' && typeof authGetClassList === 'function' && !authGetClassList().length) {
        try { await authLoadClasses(); } catch (e) { /* 失敗時 auth.js 有內建備援清單 */ }
    }

    const forced = !!force;
    // refresh = true：連本機鏡像都跳過，直接抓靜態檔（背景靜默更新專用）
    const refresh = !!(options && options.refresh);

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
        const value = await DB.load(scheduleName, { force: true, refresh: refresh });
        if (hasScheduleContent(value)) data = value;
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
            const fallback = await DB.load(fallbackName, { force: true, refresh: refresh });
            if (hasScheduleContent(fallback)) {
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

    // 用家切換班級：上面已經用本機鏡像「秒刷」（完全唔使等網絡），
    // 呢度再喺背景靜默抓一次靜態檔，確保換班之後資料一定係最新
    // （stale-while-revalidate：先快、後準，兩者兼得）
    if (forced && !refresh) {
        const beforeSwap = bootSignature();
        setTimeout(() => {
            revalidateScheduleSilently()
                .then(() => {
                    if (bootSignature() !== beforeSwap && typeof refreshScheduleViews === 'function') {
                        refreshScheduleViews();
                    }
                })
                .catch(() => { /* 背景更新失敗唔影響已經顯示嘅內容 */ });
        }, 0);
    }

    return { url: usedUrl, isDefault: isDefault, className: resolved.className, failed: !data };
}

// ================= DataManager → 畫面 綁定（Hot Reload） =================
/**
 * DB 內容有變更時（雲端同步拉取、班級清單更新等），DB 會 notify，
 * 這裡把改動即時反映到畫面上，唔需要手動重新整理。
 */
function initDbBridge() {
    // 假期與倒數
    DB.subscribe('holidays', () => {
        holidaysData = DB.get('holidays') || [];
        if (typeof renderHolidays === 'function') renderHolidays();
        if (typeof renderProfileNextHoliday === 'function') renderProfileNextHoliday();
        // 假期清單一改（開發者面板 / 雲端同步），課表覆蓋與倒數要即刻跟住變：
        // 由「非假期」變「假期」要收埋課表同倒數；反之要還原。
        if (typeof renderSchedule === 'function') renderSchedule();
        if (typeof updateRealtimeStatus === 'function') updateRealtimeStatus();
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
        scheduleLoadFailed = !hasScheduleContent(value);
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

// ================= Splash Screen 控制（品牌規範版） =================
// 舊版 hideSplashScreen(elapsedMs, warm) 係「暖啟動 0ms 走人、冷啟動最少 700ms」，
// 品牌動畫經常一閃而過。新版 finishBrandSplash() 完全按品牌規範重寫：
//   ① 品牌動畫最少播 SPLASH_MIN_MS (2.5s)，由 index.html 嘅 __BOOT_T0（第一幀）開始計
//   ② 首屏未就緒（無數據／無網絡／載入失敗）→ Logo 保持循環動畫 ＋ 底部微弱提示，嚴禁黑屏：
//        · pending（網絡仲跑緊）→ 一直等到 SPLASH_MAX_MS 為止
//        · failed（已知載入失敗）→ 短暫交代就入 App（App 本身有錯誤卡 ＋ 重試按鈕）
//        兩種情況入 App 之前都會顯示「重新連線中…」並停留 SPLASH_HINT_HOLD_MS，唔會一閃而過
//   ③ 轉場：.splash-leaving → 白圓擴散 ＋ Logo 放大（SPLASH_LEAVE_MS）
//      → .hidden 淡出（SPLASH_FADE_MS）→ 移除節點（連 backdrop-filter 圖層都釋放埋）
//
// ⚠ 三組時長（2.5s／0.45s／0.2s）必須同 index.html 內嵌 critical CSS 一致。
// 回傳 Promise：呼叫者 await 之後，就可以確保淡出已經播完。
function finishBrandSplash(startedAt, firstLoad) {
    const splash = document.getElementById('splash-screen');
    if (!splash) return Promise.resolve();

    const elapsed = () => nowMs() - (Number(startedAt) || 0);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

    // 首屏狀態：pending（仲等緊）／ ready（有嘢睇）／ failed（載入失敗）
    // ⚠ 成功同失敗都要記低，否則 reject 咗嘅 promise 會變成 unhandled rejection。
    let state = 'pending';
    Promise.resolve(firstLoad).then(
        () => { state = firstScreenReady() ? 'ready' : 'failed'; },
        () => { state = 'failed'; }
    );

    return (async () => {
        // ---- ① 品牌動畫最少播 SPLASH_MIN_MS（規範 2.0~3.0s）----
        await wait(SPLASH_MIN_MS - elapsed());
        await wait(0);   // 讓上面嘅 then 先跑完，確保攞到最新狀態

        // ---- ② 首屏未就緒：Logo 保持循環動畫（CSS 無限呼吸）＋ 底部微弱提示 ----
        if (state !== 'ready') {
            splash.classList.add('splash-waiting');
            setSplashStatus(state === 'failed' ? SPLASH_TEXT_RETRY : SPLASH_TEXT_LOADING);

            const deadline = (state === 'failed')
                ? elapsed() + SPLASH_FAIL_HOLD_MS   // 已知失敗：短暫交代就入 App
                : SPLASH_MAX_MS;                    // 仲等緊：最多等到 SPLASH_MAX_MS

            while (state !== 'ready' && elapsed() < deadline) {
                await wait(SPLASH_POLL_MS);
            }

            if (state !== 'ready') {
                setSplashStatus(SPLASH_TEXT_RETRY);
                await wait(SPLASH_HINT_HOLD_MS);
            }
        }

        // ---- ③ 品牌轉場（白圓擴散 ＋ Logo 放大）→ 淡出 → 移除節點 ----
        splash.classList.add('splash-leaving');
        await wait(SPLASH_LEAVE_MS);
        splash.classList.add('hidden');
        await wait(SPLASH_FADE_MS);
        splash.classList.add('removed');
        if (splash.parentNode) splash.parentNode.removeChild(splash);
    })();
}

// 底部微弱提示（資料未就緒時嘅優雅交代）：文字只喺有變時才寫入，唔會重複觸發 reflow
function setSplashStatus(text) {
    const el = document.getElementById('splash-status');
    if (el && el.textContent !== text) el.textContent = text;
}

// 首屏有嘢睇？＝課表已經有內容（本機快取或網絡版本），
// 或者「未揀班級」引導卡（本身就唔需要課表資料，唔應該當成載入失敗）。
function firstScreenReady() {
    if (scheduleLoadFailed) return false;
    if (currentScheduleName === '') return true;
    return hasScheduleContent(scheduleData);
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

    if (pageId === 'page-schedule') renderSchedule();
    if (pageId === 'page-realtime') {
        updateRealtimeStatus();
    }
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

// ================= 課表日期狀態（15:45 分界 + 手動選取） =================
// 預設日期規則（僅在「未有手動指定日期」時生效）：
//   · 當前時間 <  15:45 → 今日
//   · 當前時間 >= 15:45 → 明日（放學後要睇嘅自然係聽日嘅課）
// 用戶撳「今天 / 明天」或日期選擇器之後，一律以手動選擇為準，唔會再被規則覆蓋。
const SCHEDULE_CUTOFF_HOUR = 15;
const SCHEDULE_CUTOFF_MINUTE = 45;
let scheduleSelectedDate = null;   // null = 未決定，第一次渲染先用 15:45 規則

function scheduleStartOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function scheduleIsSameDay(a, b) {
    if (!a || !b) return false;
    return a.getFullYear() === b.getFullYear()
        && a.getMonth() === b.getMonth()
        && a.getDate() === b.getDate();
}

// 15:45 分界 → 回傳預設應該顯示嘅日期（當日 00:00）
function getDefaultSelectedDate() {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const isAfterSchool = (hours > SCHEDULE_CUTOFF_HOUR)
        || (hours === SCHEDULE_CUTOFF_HOUR && minutes >= SCHEDULE_CUTOFF_MINUTE);

    const target = scheduleStartOfDay(now);
    if (isAfterSchool) target.setDate(target.getDate() + 1);
    return target;
}

function getScheduleSelectedDate() {
    if (!scheduleSelectedDate) scheduleSelectedDate = getDefaultSelectedDate();
    return scheduleSelectedDate;
}

// 例：2026年9月25日(五)
function formatScheduleDate(date) {
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日(${dayNames[date.getDay()]})`;
}

// 兼容舊呼叫 renderSchedule('today' | 'tomorrow')；無參數 → 用目前選取日期（唔會重置手動選擇）
function resolveScheduleDate(arg) {
    if (arg instanceof Date && !isNaN(arg.getTime())) return scheduleStartOfDay(arg);
    if (arg === 'today') return scheduleStartOfDay(new Date());
    if (arg === 'tomorrow') {
        const tomorrow = scheduleStartOfDay(new Date());
        tomorrow.setDate(tomorrow.getDate() + 1);
        return tomorrow;
    }
    return getScheduleSelectedDate();
}

// 動態標題：是日課表 / 明日課表（並同步「今天 / 明天」快捷按鈕的選中狀態）
// 用詞規定：凡是「今天」一律寫成「是日」，
//           畫面嚴禁再出現「今日課表」「今天日期是」。
function updateScheduleHeader(date) {
    const today = scheduleStartOfDay(new Date());
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

    let title;
    let lead;
    if (scheduleIsSameDay(date, today)) {
        title = '是日課表';
        lead = '是日日期是';
    } else if (scheduleIsSameDay(date, tomorrow)) {
        title = '明日課表';
        lead = '明天日期是';
    } else {
        title = `${date.getMonth() + 1}月${date.getDate()}日 課表`;
        lead = '選取日期是';
    }

    const titleEl = document.getElementById('schedule-title-text');
    const dateEl = document.getElementById('schedule-date-text');
    if (titleEl) titleEl.textContent = title;
    if (dateEl) dateEl.textContent = `${lead} ${formatScheduleDate(date)}`;

    syncScheduleDateControls(date, today, tomorrow);
}

function syncScheduleDateControls(date, today, tomorrow) {
    const todayBtn = document.getElementById('schedule-quick-today');
    const tomorrowBtn = document.getElementById('schedule-quick-tomorrow');

    if (todayBtn) {
        const on = scheduleIsSameDay(date, today);
        todayBtn.classList.toggle('is-on', on);
        todayBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (tomorrowBtn) {
        const on = scheduleIsSameDay(date, tomorrow);
        tomorrowBtn.classList.toggle('is-on', on);
        tomorrowBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
}

// ================= 日期切換（今日 / 明日兩個快捷按鈕） =================
function scheduleGoToDate(date) {
    scheduleSelectedDate = scheduleStartOfDay(date);
    renderSchedule(scheduleSelectedDate);
}

function scheduleSelectToday() {
    scheduleGoToDate(new Date());
}

function scheduleSelectTomorrow() {
    const tomorrow = scheduleStartOfDay(new Date());
    tomorrow.setDate(tomorrow.getDate() + 1);
    scheduleGoToDate(tomorrow);
}

// 以「日」為單位前後移動（供程式呼叫用；畫面冇對應按鈕）
function scheduleStepDate(days) {
    const base = getScheduleSelectedDate();
    const next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + Number(days || 0));
    scheduleGoToDate(next);
}

// ================= 當前上課節數高亮（Current Active Class） =================
// 檢查某節課是否「正在進行中」：
//   ① 只有檢視「是日」時才可能成立（明日 / 其他日子一律 false）
//   ② 當前時間 HH:MM:SS 落在 [開始, 結束) 之間 → 落堂一刻即熄高亮
function isCurrentClass(startTimeStr, endTimeStr, isToday, now) {
    if (!isToday) return false;

    const ref = now || new Date();
    const currentSeconds = ref.getHours() * 3600 + ref.getMinutes() * 60 + ref.getSeconds();

    const [startH, startM] = String(startTimeStr).split(':').map(Number);
    const [endH, endM] = String(endTimeStr).split(':').map(Number);
    if ([startH, startM, endH, endM].some(Number.isNaN)) return false;

    const startSeconds = startH * 3600 + startM * 60;
    const endSeconds = endH * 3600 + endM * 60;

    return currentSeconds >= startSeconds && currentSeconds < endSeconds;
}

// ================= 假期判斷（覆蓋課表與倒數嘅唯一真相） =================
// 資料來源：holidaysData（DB 集合 'holidays'，見 modules/holidays/holidays.js）。
//   一條假期可以係單日（只有 date）或連續期間（date ~ endDate）。
//   判斷一律以「日」為單位（YYYY-MM-DD 字串比較），唔理時分秒，
//   避免時區 / 時間部分造成「明明係假期但判斷唔中」。
// ⚠ 全站任何「今日係唔係假期」嘅判斷都必須經呢兩個函式，
//   唔好再喺其他地方自己 filter holidaysData，否則規則會各自演化。
function scheduleDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 回傳該日命中嘅假期清單；非假期 → 空陣列（可多於一條，例如重疊嘅補假） */
function getHolidaysOnDate(date) {
    if (!Array.isArray(holidaysData) || holidaysData.length === 0) return [];
    const key = scheduleDateKey(date);
    return holidaysData.filter(h => {
        if (!h || !h.date) return false;
        if (!h.endDate || h.endDate === h.date) return h.date === key;
        return key >= h.date && key <= h.endDate;
    });
}

/** 該日是否假期（課表與倒數一律以本函式為準） */
function isHolidayDate(date) {
    return getHolidaysOnDate(date).length > 0;
}

// 假期問候語：由假期名稱推導出「XX節快樂」。
// ⚠ 為何唔可以直接 name + '快樂'：DB 'holidays' 嘅 name 係「官方全名」，
//   例如「中秋節翌日」「國慶假期」「教師節假期」，
//   直接拼會變成「中秋節翌日快樂」「國慶假期快樂」呢類怪句。
//   做法：先反覆剝走尾部修飾詞（翌日／補假／假期…），再按結尾補字：
//     國慶假期   → 國慶   → 國慶節快樂
//     教師節假期 → 教師節 → 教師節快樂
//     中秋節翌日 → 中秋節 → 中秋節快樂
//     元旦假期   → 元旦   → 元旦快樂
//   無 name ／剝到變空 → 退回中性「假期快樂」。
const HOLIDAY_NAME_SUFFIXES = ['假期', '假日', '節日', '翌日', '補假', '慶祝'];
const HOLIDAY_GREETING_TAILS = ['節', '日', '旦', '誕', '年', '快樂'];

function holidayGreeting(holiday) {
    if (!holiday || !holiday.name) return '假期快樂';

    let base = String(holiday.name).trim();
    let stripped = true;
    while (stripped) {
        stripped = false;
        for (let i = 0; i < HOLIDAY_NAME_SUFFIXES.length; i++) {
            const suffix = HOLIDAY_NAME_SUFFIXES[i];
            if (base.length >= suffix.length && base.endsWith(suffix)) {
                base = base.slice(0, -suffix.length);
                stripped = true;
            }
        }
    }

    if (!base) return '假期快樂';
    if (base.endsWith('快樂')) return base;
    // 「國慶」「清明」等本身唔帶「節」字 → 補「節快樂」；
    // 「教師節」「元旦」「冬至及聖誕」等已有節／日／旦／誕字 → 只補「快樂」。
    if (HOLIDAY_GREETING_TAILS.some(tail => base.endsWith(tail))) return base + '快樂';
    return base + '節快樂';
}

// 倒數頁「狀態膠囊」：是日為假期時取代所有倒數卡。
// ⚠ 系統 UI 禁用 Emoji（見 icons.js 內容層規範），所以時鐘一律用 SVG 圖示；
//   節日 Emoji 只會出現喺假期卡（內容層）。
function holidayCapsuleHtml(holiday) {
    return `
        <div class="status-capsule">
            ${icon('clock', { size: 16 })}
            <span class="capsule-text">假期中 · ${escapeHtml(holidayGreeting(holiday))}</span>
        </div>
    `;
}

// 高亮簽名：記錄「目前高亮緊邊一日、邊一節」。
// 有咗簽名，每秒 tick 就只需要比對字串，唔會無謂重繪（重繪會令卡片動畫重播）。
let scheduleNowSignature = '';

function getScheduleNowSignature(date, isViewingToday, now) {
    const dayKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    // 假期優先：假期一律冇「進行中節次」，簽名固定，
    // 咁每秒 tick 就唔會誤判成「高亮改變」而反覆重繪假期卡。
    if (isHolidayDate(date)) return `${dayKey}#holiday`;
    if (!isViewingToday) return `${dayKey}#off`;

    const classes = scheduleData[date.getDay()] || [];
    const ref = now || new Date();
    for (let i = 0; i < classes.length; i++) {
        if (isCurrentClass(classes[i].start, classes[i].end, true, ref)) {
            return `${dayKey}#${i}`;
        }
    }
    return `${dayKey}#none`;
}

// 每秒檢查（由 startRealtimeClock 呼叫）：
// 當「進行中節次」改變（例如第 1 節落堂、第 2 節開始）就重繪課表，
// 令紅色外框同 NOW 標籤唔會停留喺已經落堂嘅卡片上。
// 只在課表頁 active 時才做嘢，其他頁面零成本。
function syncScheduleNowHighlight() {
    if (currentTab !== 'page-schedule') return;
    const page = document.getElementById('page-schedule');
    if (!page || !page.classList.contains('active')) return;

    const date = getScheduleSelectedDate();
    const isViewingToday = scheduleIsSameDay(date, new Date());
    const signature = getScheduleNowSignature(date, isViewingToday);
    if (signature === scheduleNowSignature) return;

    scheduleNowSignature = signature;
    renderSchedule(date);
}

// ================= 渲染課表（依選取日期） =================
/**
 * 假期祝賀卡（取代課表清單）。
 * 標題 = 動態節日問候語（例：中秋節快樂），由 holidayGreeting() 推導。
 * ⚠ 用詞規定：課表頁一律講「是日」，嚴禁出現「今日 / 今天」。
 *   問候語本身唔含「今日」，但副標題要分今日／其他日子，
 *   否則檢視「明日」時會出現「是日」同實際日期對唔上。
 */
function scheduleHolidayCardHtml(holiday, date) {
    const isToday = scheduleIsSameDay(date, new Date());
    const name = escapeHtml(holiday.name || '學校假期');
    const range = holiday.date + (holiday.endDate && holiday.endDate !== holiday.date ? ' ~ ' + holiday.endDate : '');
    const emoji = holiday.emoji || holiday.icon || '\u{1F389}';

    const title = escapeHtml(holidayGreeting(holiday));
    const subtitle = isToday
        ? '是日為學校假期，祝您假期愉快！'
        : '這天為學校假期，祝您假期愉快！';
    const note = holiday.note ? `<div class="holiday-note">${escapeHtml(holiday.note)}</div>` : '';

    return `
        <div class="schedule-holiday">
            <div class="holiday-icon">${contentIcon(emoji, { size: 44, fallback: 'sparkles' })}</div>
            <div class="holiday-title">${title}</div>
            <div class="holiday-subtitle">${subtitle}</div>
            <div class="holiday-meta">${name} · ${range}</div>
            ${note}
        </div>
    `;
}

function renderSchedule(dateOrMode) {
    const date = resolveScheduleDate(dateOrMode);
    scheduleSelectedDate = date;
    updateScheduleHeader(date);

    const dayOfWeek = date.getDay();
    const listContainer = document.getElementById('schedule-list-container');
    if (!listContainer) return;

    // 🎉 優先權最高：只要所選日期命中假期清單，一律唔顯示課表
    //    —— 即使 scheduleData 當日照樣有排課，都唔會 render 任何課堂卡。
    const holiday = getHolidaysOnDate(date)[0];
    if (holiday) {
        listContainer.innerHTML = scheduleHolidayCardHtml(holiday, date);
        // 簽名同樣要更新，否則下一秒 tick 會誤判成「高亮改變」而反覆重繪假期卡
        scheduleNowSignature = getScheduleNowSignature(date, scheduleIsSameDay(date, new Date()));
        return;
    }

    const classes = scheduleData[dayOfWeek];

    if (!classes || classes.length === 0) {
        listContainer.innerHTML = `<div style="text-align:center; padding:60px 20px; color:var(--text-muted); font-size:22px; font-weight:bold;">${icon('sparkles', { size: 24 })} 這天沒有課堂！</div>`;
        // 空課表同樣要更新簽名，否則下一秒 tick 會誤判為「高亮狀態改變」而多餘地重繪一次
        scheduleNowSignature = getScheduleNowSignature(date, scheduleIsSameDay(date, new Date()));
        return;
    }

    // 只有檢視「是日課表」時才需要標示當前進行中的課堂
    const now = new Date();
    const isViewingToday = scheduleIsSameDay(date, now);

    let html = '';
    classes.forEach(item => {
        // 當前進行中的課堂 → 紅色外框 + 右上角方形 NOW 標籤
        const isNow = isCurrentClass(item.start, item.end, isViewingToday, now);
        const isLongSubject = item.subject.length > 4;

        html += `
            <div class="class-card ${isNow ? 'is-now' : ''}">
                ${isNow ? '<div class="now-badge">NOW</div>' : ''}
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

    // 記低此刻嘅高亮狀態，供每秒 tick 比對（見 syncScheduleNowHighlight）
    scheduleNowSignature = getScheduleNowSignature(date, isViewingToday, now);
}

// ================= 即時倒數 =================
// 記住「而家顯示緊嘅假期身份」（日期 + 假期名）。updateRealtimeStatus 每秒都跑，
// 靠呢個 key 判斷要唔要重寫倒數區，避免每秒重播膠囊入場動畫。
let realtimeHolidayKey = null;

function updateRealtimeStatus() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    document.getElementById('live-clock').textContent = `${hh}:${mm}:${ss}`;

    // 🎉 假期優先權最高：是日為假期 → 唔顯示任何倒數（NOW / 下一節 / 放學全部唔計），
    //    倒數區改為顯示「假期中 · XX節快樂」狀態膠囊，之後直接 return。
    //    —— 即使課表資料當日照樣有排課都一樣。
    const statusEl = document.getElementById('status-container');
    const todayHolidays = getHolidaysOnDate(now);

    if (todayHolidays.length > 0) {
        // ⚠ 本函式每秒都會跑：innerHTML 只可以喺「假期身份改變」時寫一次，
        //   否則每秒重寫會令入場動畫不停重播（膠囊會一直閃）。
        const holidayKey = scheduleDateKey(now) + '|' + todayHolidays.map(h => h.name).join('+');
        if (statusEl && realtimeHolidayKey !== holidayKey) {
            statusEl.innerHTML = holidayCapsuleHtml(todayHolidays[0]);
            statusEl.style.display = '';
            realtimeHolidayKey = holidayKey;
        }
        return;
    }

    // 非假期：清假期快取並還原顯示（user 可能啱啱由假期跨去正常上課日）
    const wasHoliday = realtimeHolidayKey !== null;
    realtimeHolidayKey = null;
    if (statusEl) statusEl.style.display = '';

    // 課表載入失敗時，保留錯誤提示卡，唔好用空資料覆蓋
    if (scheduleLoadFailed) {
        // 錯誤卡可能已經被假期膠囊蓋走 → 由假期返正常日子時要補返，
        // 否則倒數區會一直空白。只喺過渡嘅一刻補，唔可以每秒重繪（會閃）。
        if (wasHoliday) renderScheduleLoadError();
        return;
    }

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

    // 假期判斷同課表／倒數共用同一個真相來源（見 getHolidaysOnDate），
    // 唔喺呢度自己 filter，免得「搜尋話係假期、課表又話唔係」。
    const matchedHolidays = getHolidaysOnDate(date);

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
// 舊版用 window.onload：要等「所有 CSS / JS / 圖片」都下載完才開始初始化，
// 冷啟動或弱網時可以遲幾秒，Splash 動畫早就播完定住，睇落就好似卡死。
// 改用 DOMContentLoaded（main.js 位於 </body> 之前，此刻所有 <link> 樣式已套用，
// 版面幾何量測依然準確），令初始化最早可以開始：
//   · 資料請求最早發出 → 1.2 秒超時上限由呢一刻開始計，最準確
//   · Splash 動畫同資料載入真正並行，唔會互相拖慢
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp, { once: true });
} else {
    initApp();
}