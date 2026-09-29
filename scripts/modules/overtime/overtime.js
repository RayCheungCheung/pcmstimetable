// =====================================================================
// overtime.js — 「拖堂計時器」＋「老師拖堂排行榜」（Beta）
// =====================================================================
// 【做乜】
//   1) 倒數頁「當前課堂」(NOW) 卡內部（時間標籤正下方）加一個拖堂計時器：
//      原定下課時間一到但老師未落堂 → 學生按「開始拖堂計時」；真正落堂時
//      按「停止計時並記錄」，秒數自動歸入該堂授課老師名下。
//      ⚠ 按鈕容器（#overtime-btn-container）由本檔即場建立並 append 入
//        NOW 卡嘅 .status-body —— NOW 卡本身係 main.js 每秒用 innerHTML
//        砌出嚟嘅，index.html 冇任何節點可以「放喺 NOW 卡入面」。
//      ⚠ 條件顯示（本次修訂）：計時器只喺「已過原定下課時間、而下一節仲
//        未開始」嘅拖堂窗口內（＝ overtimeWindowLesson() 唔係 null）才會
//        渲染，判斷式就係「now >= 本堂 end 且窗口未關」。其餘時間一律
//        「完全唔渲染」（overtimeTick 會 clearHost，連容器都清空）——
//        上課期間版面必須絕對乾淨。
//        舊版係「掣常駐 ＋ 窗口外顯示一句灰字
//        『未到落堂時間，落堂鐘響後先開始得』」，該提示同常駐掣已一併移除：
//        一句永遠喺度嘅「唔用得」提示，比冇提示更似壞咗。
//   2) 個人中心「老師拖堂排行榜（Beta）」子頁面：前三名頒獎台（依指示
//      唔顯示頭像）＋ 4~10 名列表。
//
// 【Beta 權限】僅限「正班」帳號。判斷一律用 auth.js 嘅 authResolveSchedule()
//   —— 佢係「用戶而家實際讀緊邊個課表」嘅唯一權威，唔喺呢度另砌一套
//   「自訂班名／官方班別」判斷（兩套判斷一定會有一日唔同步）。
//   本檔定義：已登入 ＋ classId 對得上官方班級清單（authFindClass 搵得到）。
//   自訂班名、班別已停用、未揀班一律唔算正班。
//
// 【資料】本機兩個 DB 集合（都冇靜態檔案，所以全程同步讀寫，唔使 DB.load）：
//   · overtime       （陣列）每次拖堂一筆原始紀錄，只新增、永不改寫。
//   · overtimeActive （物件）正在計時嘅狀態 —— 一定要落地，否則學生一熄
//                     App／一換頁，計到一半嘅秒數就蒸發。
//
// 【雲端】拖堂紀錄自本次修訂起同步至 Supabase 共享表 overtime_records
//   （建表腳本：supabase/overtime-records.sql）。分工係：
//     · 寫入 ＝「本機先寫、雲端後寫」（overtimeStop → overtimeSubmitRecord）：
//       本機寫入係同步而且一定成功，雲端係非同步。斷網時紀錄照樣入到本機
//       （用戶唔會見到「撳咗停止但冇反應」），但雲端嗰筆會失敗 ——
//       呢個係已知取捨，見 overtimeSubmitRecord() 嘅註解。
//     · 讀取 ＝ 雲端優先（fetchOvertimeLeaderboard），取唔到才退回本機
//       聚合（overtimeTeacherStats）。兩者結果形狀完全一樣，
//       所以下方所有渲染函數唔需要知道資料來自邊度。
// ⚠ 雲端 rows 同本機紀錄永遠唔會合併計算：合併會令同一筆拖堂被計兩次。
//
// 【Beta】本檔所有 UI 都掛住 Beta 標籤，代表規則可能再變。
// =====================================================================

/** 一次過最多記錄幾長：超過就當「忘記停止」，唔入帳（見 overtimeStop） */
const OVERTIME_MAX_SECONDS = 4 * 60 * 60;

/** 最後一節之後仲可以開始計時嘅窗口（分鐘）。
 *  中間節數嘅窗口一律係「直到下一節開始」，唔需要呢個值；
 *  但最後一節冇「下一節」，唔設上限嘅話夜晚 11 點仲可以開始拖堂計時。 */
const OVERTIME_WINDOW_GRACE_MINUTES = 60;

/** 排行榜最多顯示幾名（設計要求 4~10 名） */
const OVERTIME_LEADERBOARD_LIMIT = 10;

/** 協同教學寫法："徐梓駿/蕭沛強"、"梁詠詩/林曦瞳"（見 data/schedule.json） */
const OVERTIME_TEACHER_SPLIT = /[/、,，&]/;

/** 雲端共享表（見 supabase/overtime-records.sql） */
const OVERTIME_TABLE = 'overtime_records';

/** 排行榜聚合 RPC：SUM(duration_seconds) + COUNT(*) GROUP BY teacher_name */
const OVERTIME_LEADERBOARD_RPC = 'overtime_leaderboard';

/** 雲端請求逾時（毫秒）。排行榜係「開頁即載」，唔可以拖住整個子頁面 */
const OVERTIME_CLOUD_TIMEOUT_MS = 8000;

/**
 * 雲端排行榜快取狀態。
 * 為什麼要有快取：profileRenderDetail() 係「同步」呼叫 page.html()，
 *   但排行榜一定要上網才拿到。冇快取嘅話第一次入頁面只可以出「載入中」，
 *   之後靠 after() 補畫 —— 快取令第二次入同一頁（最常見嘅情況）
 *   即時有數字，唔會閃一下空白。
 * ⚠ 刻意唔用 localStorage 持久化：排行榜係「即時」數據，留住上一次嘅
 *   名次反而會誤導（用戶見到舊名次，以為同步壞咗）。
 */
let overtimeCloudStats = null;      // null ＝ 未成功取過；否則係已排序嘅 stat 陣列
let overtimeCloudState = 'idle';    // idle | loading | ready | error
let overtimeCloudError = '';        // 失敗原因（已轉成人話），顯示喺頁頂

/* ---------- DB 集合定義 ---------- */
if (typeof DB !== 'undefined') {
    DB.define('overtime', {
        label: '拖堂紀錄',
        icon: 'timer',
        group: 'db',
        array: true,
        fallback: [],
        // ⚠ normalize 唔止係「清洗」，佢係唯一嘅資料守門員：
        //   DB.set() 寫入前一樣會跑，所以任何來源（手改 localStorage、
        //   將來雲端拉落嚟）嘅爛資料都入唔到紀錄清單。
        normalize: overtimeNormalizeRecords
    });

    DB.define('overtimeActive', {
        label: '拖堂計時中',
        icon: 'timer',
        group: 'db',
        array: false,
        storageKey: 'overtime_active',
        fallback: null,
        normalize: overtimeNormalizeActive
    });
}

/* =====================================================================
   一、資料存取（全同步）
   ===================================================================== */

/** 由 DB 快取或 localStorage 讀原始值（兩個集合都冇靜態檔，唔使非同步） */
function overtimeStored(name, fallback) {
    if (typeof DB === 'undefined') return fallback;
    const cached = DB.get(name);
    if (cached !== undefined && cached !== null) return cached;
    const stored = DB.readStored(name);
    return (stored === null || stored === undefined) ? fallback : stored;
}

/** 清洗一筆拖堂紀錄；回傳 null ＝唔要呢筆 */
function overtimeNormalizeRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const teacher = String(raw.teacher || '').trim();
    const seconds = Math.round(Number(raw.seconds) || 0);
    // 冇老師＝冇得歸帳；0 秒＝冇拖堂過。兩者都唔應該佔一行。
    if (!teacher || seconds <= 0) return null;
    return {
        id: String(raw.id || ''),
        ts: Number(raw.ts) || 0,
        date: String(raw.date || ''),
        period: Number(raw.period) || 0,
        subject: String(raw.subject || '').trim(),
        teacher: teacher,
        classId: String(raw.classId || ''),
        className: String(raw.className || '').trim(),
        seconds: Math.min(seconds, OVERTIME_MAX_SECONDS),
        startedAt: Number(raw.startedAt) || 0,
        endedAt: Number(raw.endedAt) || 0,
        accountId: String(raw.accountId || '')
    };
}

/** 清洗整個拖堂紀錄清單（同時做 DB descriptor 嘅 normalize） */
function overtimeNormalizeRecords(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const rec = overtimeNormalizeRecord(list[i]);
        if (rec) out.push(rec);
    }
    return out;
}

/** 清洗計時中狀態；回傳 null ＝冇喺計時 */
function overtimeNormalizeActive(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const teacher = String(raw.teacher || '').trim();
    const startedAt = Number(raw.startedAt) || 0;
    if (!teacher || startedAt <= 0) return null;
    return {
        teacher: teacher,
        subject: String(raw.subject || '').trim(),
        period: Number(raw.period) || 0,
        start: String(raw.start || ''),
        end: String(raw.end || ''),
        classId: String(raw.classId || ''),
        className: String(raw.className || '').trim(),
        date: String(raw.date || ''),
        startedAt: startedAt,
        accountId: String(raw.accountId || '')
    };
}

/** 本機全部拖堂紀錄（最舊在前） */
function overtimeRecords() {
    return overtimeNormalizeRecords(overtimeStored('overtime', []));
}

/** 而家係咪計時中（回傳狀態物件或 null） */
function overtimeActive() {
    return overtimeNormalizeActive(overtimeStored('overtimeActive', null));
}

/** 寫入計時中狀態；傳 null ＝停止／清除 */
function overtimeSaveActive(state) {
    if (typeof DB === 'undefined') return;
    DB.set('overtimeActive', state ? overtimeNormalizeActive(state) : null);
}

/* =====================================================================
   二、Beta 權限：係咪「正班」
   ===================================================================== */

/**
 * 目前帳號嘅正班狀態。
 * @returns {{ ok: boolean, classId: string, className: string, reason: string }}
 *   ok=true 才可以開始拖堂計時（Beta 限制）。
 */
function overtimeRegularClass() {
    const account = (typeof authGetCurrentAccount === 'function') ? authGetCurrentAccount() : null;
    const res = (typeof authResolveSchedule === 'function') ? authResolveSchedule(account) : null;
    const classId = res && res.classId ? String(res.classId) : '';
    // authFindClass() 只認官方班級清單（data/classes.json）；
    // 自訂班名（reason 'custom'）同已停用班別（'stale'）一律搵唔到 → 唔算正班。
    const cls = (classId && typeof authFindClass === 'function') ? authFindClass(classId) : null;
    return {
        ok: !!(account && cls),
        classId: cls ? String(cls.id) : '',
        className: (cls && cls.name) ? String(cls.name) : ((res && res.className) || ''),
        reason: (res && res.reason) || 'unselected'
    };
}

/* =====================================================================
   三、拖堂窗口：而家應該歸邊一堂課
   ===================================================================== */

/** 'HH:MM' → 由午夜起嘅秒數；格式唔啱回傳 -1 */
function overtimeClockSeconds(text) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
    if (!m) return -1;
    return (Number(m[1]) * 3600) + (Number(m[2]) * 60);
}

/**
 * 依「而家」推算拖堂窗口內嘅一堂課：啱啱過咗原定下課時間，
 * 但下一節仲未開始（＝小休／午休／放學後嘅窗口）。
 * @returns {object|null} 課堂物件（{period,start,end,subject,teacher}）
 */
function overtimeWindowLesson(now) {
    const d = now || new Date();
    if (typeof scheduleData === 'undefined' || !scheduleData) return null;
    const lessons = scheduleData[d.getDay()];
    if (!Array.isArray(lessons) || !lessons.length) return null;

    const secs = (d.getHours() * 3600) + (d.getMinutes() * 60) + d.getSeconds();
    let ended = null;
    let nextStart = -1;

    for (let i = 0; i < lessons.length; i++) {
        const lesson = lessons[i];
        const end = overtimeClockSeconds(lesson.end);
        const start = overtimeClockSeconds(lesson.start);
        if (end < 0 || start < 0) continue;
        if (end <= secs) {
            // 揀已經落堂嘅課堂之中最遲嗰一堂（唔假設陣列已排序）
            if (!ended || end > overtimeClockSeconds(ended.end)) ended = lesson;
        } else if (nextStart < 0 || start < nextStart) {
            nextStart = start;
        }
    }

    if (!ended) return null;
    const endSecs = overtimeClockSeconds(ended.end);
    const limit = nextStart >= 0
        ? nextStart                                   // 下一節一響鐘，窗口即刻關
        : endSecs + OVERTIME_WINDOW_GRACE_MINUTES * 60; // 最後一節：放學後再留 60 分鐘
    if (secs >= limit) return null;
    return ended;
}

/* =====================================================================
   四、格式化
   ===================================================================== */

/** 秒數 → 人話（例：7 秒 / 45 分鐘 / 45 分 12 秒 / 2 小時 5 分） */
function overtimeDurationText(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return s + ' 秒';
    const m = Math.floor(s / 60);
    const rest = s % 60;
    if (m < 60) return rest ? (m + ' 分 ' + rest + ' 秒') : (m + ' 分鐘');
    const h = Math.floor(m / 60);
    const restM = m % 60;
    return restM ? (h + ' 小時 ' + restM + ' 分') : (h + ' 小時');
}

/**
 * 秒數 → 頒獎台大字用嘅「數字 + 單位」（例：45 / 分鐘）。
 * ⚠ 小時唔用 toFixed(1)：整點會出「1.0小時」（正確但難睇），
 *   先四捨五入到一位再轉字串，1 小時就出「1」，1.5 小時照出「1.5」。
 *   秒數原文照舊查得到（4~10 名列表用 overtimeDurationText()）。
 */
function overtimeDurationParts(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return { value: String(s), unit: '秒' };
    const m = Math.floor(s / 60);
    if (m < 60) return { value: String(m), unit: '分鐘' };
    return { value: String(Math.round((s / 3600) * 10) / 10), unit: '小時' };
}

/** 秒數 → 計時器跳字（MM:SS；超過一小時才出 H:MM:SS） */
function overtimeClockText(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(sec).padStart(2, '0');
    return h > 0 ? (h + ':' + mm + ':' + ss) : (mm + ':' + ss);
}

/** 所有動態文字一律轉義（獨立可測：profile.js 未載入時自己頂上） */
function overtimeEscape(text) {
    if (typeof profileEscape === 'function') return profileEscape(text);
    return String(text === null || text === undefined ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Toast（沿用個人中心嘅提示，保持一致） */
function overtimeToast(text) {
    if (typeof profileToast === 'function') profileToast(text);
}

/* =====================================================================
   五、計時器動作（開始 / 停止）
   ===================================================================== */

/**
 * 開始拖堂計時。唯一入口係倒數頁嗰粒掣（onclick="overtimeStart()"）。
 * ⚠ 三道關卡嘅次序有意義，唔可以掉亂：
 *   1) 正班 → Beta 限制。非正班連一筆紀錄都唔應該寫得入（唔係「寫咗但唔顯示」）。
 *   2) 未計時中 → 防止連點兩下開兩個碼錶（第二次會覆蓋第一次嘅 startedAt，
 *      已經計咗嘅分鐘數就靜靜地蒸發）。
 *   3) 窗口內有已落堂嘅課 → 冇課就冇「拖堂」可言，亦冇老師可以歸帳。
 */
function overtimeStart() {
    const guard = overtimeRegularClass();
    if (!guard.ok) {
        overtimeToast('Beta 功能僅限正班使用者體驗');
        return;
    }
    if (overtimeActive()) {
        overtimeToast('已經喺計時中');
        return;
    }

    const now = new Date();
    const lesson = overtimeWindowLesson(now);
    if (!lesson) {
        overtimeToast('而家唔喺拖堂時段');
        return;
    }

    // ⚠ 呢度存「原字串」老師名，唔預先拆協同教學（"徐梓駿/蕭沛強"）：
    //   紀錄係「課表嘅忠實副本」，拆名係統計階段嘅事（見 overtimeTeacherStats）。
    const teacher = String(lesson.teacher || '').trim();
    if (!teacher) {
        overtimeToast('呢一堂冇登記老師，記錄唔到');
        return;
    }

    const account = (typeof authGetCurrentAccount === 'function') ? authGetCurrentAccount() : null;
    overtimeSaveActive({
        teacher: teacher,
        subject: String(lesson.subject || '').trim(),
        period: Number(lesson.period) || 0,
        start: String(lesson.start || ''),
        end: String(lesson.end || ''),
        classId: guard.classId,
        className: guard.className,
        date: (typeof scheduleDateKey === 'function') ? String(scheduleDateKey(now)) : '',
        startedAt: now.getTime(),
        accountId: account ? String(account.id || '') : ''
    });

    // 即刻換卡，唔等下一個 tick：撳完要成秒先有反應，用戶會以為撳唔中而再撳
    overtimeMountNow();
    overtimeToast('開始為 ' + teacher + ' 計時拖堂');
}

/**
 * 停止計時並把秒數入帳到該堂老師名下。
 * ⚠ 次序係「先清狀態、後寫紀錄」：萬一寫入失敗（DB 未定義、配額爆），
 *   計時器都一定停得低。反過來先寫紀錄再清狀態，寫入一 throw 就會出現
 *   「撳極都停唔到」嘅死局 —— 停唔到嘅碼錶遠比少一筆紀錄嚴重。
 */
function overtimeStop() {
    const active = overtimeActive();
    if (!active) return;

    const endedAt = Date.now();
    const seconds = Math.round((endedAt - active.startedAt) / 1000);

    overtimeSaveActive(null);

    // 兩種極端值都唔入帳，但一定要照樣重繪（否則張卡會停留喺「計時中」）
    if (seconds < 1) {
        overtimeMountNow();
        overtimeToast('不足 1 秒，唔作紀錄');
        return;
    }
    if (seconds > OVERTIME_MAX_SECONDS) {
        overtimeMountNow();
        overtimeToast('超過 4 小時，當作忘記停止，唔作紀錄');
        return;
    }

    const account = (typeof authGetCurrentAccount === 'function') ? authGetCurrentAccount() : null;
    const list = overtimeRecords();
    list.push({
        id: 'ot_' + endedAt.toString(36) + Math.random().toString(36).slice(2, 7),
        ts: endedAt,
        // 用「開始嗰一刻」嘅日期，唔用而家嘅日期：跨午夜先至停嘅話，
        // 呢筆拖堂仍然屬於尋日嗰堂課。
        date: active.date || ((typeof scheduleDateKey === 'function') ? String(scheduleDateKey(new Date(active.startedAt))) : ''),
        period: active.period,
        subject: active.subject,
        teacher: active.teacher,
        classId: active.classId,
        className: active.className,
        seconds: seconds,
        startedAt: active.startedAt,
        endedAt: endedAt,
        accountId: account ? String(account.id || '') : ''
    });
    // DB.set() 會再跑一次 normalize（第二道守門員），唔使喺度自己清
    if (typeof DB !== 'undefined') DB.set('overtime', list);

    overtimeMountNow();
    overtimeToast('已記錄 ' + active.teacher + ' 拖堂 ' + overtimeDurationText(seconds));

    // 雲端入帳（非同步、唔 await）：停止流程一定要即時完成，
    // 網絡慢唔可以令學生覺得「撳咗停止但冇反應」（見本函數開頭嘅註解）。
    // ⚠ 一定要接住 rejection：函數內部已經處理好失敗提示，
    //   但唔接住就會喺 console 留一句「Uncaught (in promise)」，
    //   排查時會被誤當成真正嘅錯誤。
    overtimeSubmitRecord(list[list.length - 1]).catch(function () { /* 已喺函數內提示 */ });
}

/**
 * 把一筆拖堂紀錄提交到 Supabase 共享表 overtime_records。
 * @param {object} record overtimeNormalizeRecord() 形狀嘅紀錄
 * @returns {Promise<{ok:boolean, code?:string, message?:string}>}
 *
 * 【為什麼唔自動重試（retry: 0）】
 *   PostgREST 嘅 POST 唔帶 idempotency key，如果送達失敗係「伺服器其實寫
 *   成功、但回應喺路上丟失」（逾時最常見），自動重試就會插入兩筆，
 *   排行榜上同一次拖堂被計兩次 —— 呢種錯誤用戶完全睇唔出，而且永遠
 *   修唔返（紀錄不可改）。相比之下「偶爾少一筆」至少係講得出嘅。
 *   ⇒ 日後若要補自動重試，正確做法係加一欄 client_id + unique 約束，
 *     用 upsert(onConflict) 令重試變成冪等，而唔係喺呢度加 retry。
 *
 * 【為什麼 user_id 唔一定送】
 *   user_id 係 uuid，空字串會令 PostgREST 直接 400。冇帳號 id 時索性
 *   唔送呢個 key，交由資料庫嘅 default auth.uid() 補上（見建表腳本）。
 */
async function overtimeSubmitRecord(record) {
    const fail = msg => ({ ok: false, code: 'LOCAL_ONLY', message: msg });
    if (!record) return fail('冇紀錄可提交');

    // 雲端未啟用（未填 url/anonKey）或未登入：靜靜當成本機模式，
    // 唔彈錯誤 —— 純本機用戶根本冇開過雲端，彈錯只會嚇到人。
    if (typeof sbRequest !== 'function' || typeof cloudEnabled !== 'function' || !cloudEnabled()) {
        return fail('雲端排行榜未啟用');
    }
    const account = (typeof authGetCurrentAccount === 'function') ? authGetCurrentAccount() : null;
    const userId = account ? String(account.id || '') : '';

    const body = {
        teacher_name: String(record.teacher || ''),
        subject: String(record.subject || ''),
        class_name: String(record.className || ''),
        duration_seconds: Math.round(Number(record.seconds) || 0)
    };
    if (userId) body.user_id = userId;

    let result;
    try {
        result = await sbRequest('/rest/v1/' + OVERTIME_TABLE, {
            method: 'POST',
            // return=minimal：唔需要回傳整列，省一次序列化
            headers: { Prefer: 'return=minimal' },
            body: body
        }, { auth: 'user', retry: 0, timeoutMs: OVERTIME_CLOUD_TIMEOUT_MS });
    } catch (error) {
        result = { ok: false, code: 'NETWORK', message: String((error && error.message) || error) };
    }

    if (!result || !result.ok) {
        const reason = (result && result.code) === 'NO_SESSION' ? '尚未登入雲端帳號' : '雲端連線失敗';
        overtimeToast(reason + '，紀錄已存於本機');
        return fail(reason);
    }

    overtimeToast('拖堂紀錄已同步至雲端排行榜！');
    // 榜單係即時數據：清走快取，下次入頁面一定重新拉，
    // 唔會出現「啱啱提交完但榜上仲係舊數」。
    overtimeCloudStats = null;
    if (overtimeCloudState === 'ready') overtimeCloudState = 'idle';
    return { ok: true };
}

/* =====================================================================
   六、倒數頁：拖堂計時器（按鈕直接嵌喺 NOW 卡內部）
   =====================================================================
   【主掛載點】NOW 卡 .status-body 最尾嘅 <div id="overtime-btn-container">，
     即係時間標籤「09:50 ~ 10:30」嘅正下方。
     ⚠ 呢個容器必定由 JS 即場建立（見 overtimeButtonBox()），冇得喺
       index.html 靜態寫死：NOW 卡連「09:50 ~ 10:30」都係 main.js 每秒
       用 innerHTML 砌出嚟嘅字串，HTML 檔裡面冇任何節點係「喺 NOW 卡
       入面」，寫幾多個 div 都掛唔入去。
   【後備掛載點】index.html 嘅 <div id="overtime-slot">（#status-container
     之後）。只有「計時中，但 NOW 卡唔存在」先用得着（課表載入失敗卡
     取代咗成個倒數區）。呢個後備唔可以刪：冇咗佢，計時中一遇載入失敗
     就會連停止掣一齊消失，用戶冇任何出口停個碼錶，秒數一路計落去。
   ⚠ 心跳照舊搭 main.js 嘅 updateRealtimeStatus()（本模組唔另開
     setInterval：兩條時間軸只會互相追數，跳秒、對唔上課堂邊界）。
   ⚠ NOW 卡會整塊重建（container.innerHTML = html），所以 main.js 喺重建
     之後即刻叫一次 overtimeMountNow() 補掛 —— 唔補嘅話按鈕會消失成秒
     （要等下一個 tick 先畫返），症狀同「掣唔見咗」呢個 bug 一模一樣。
   ⚠ updateRealtimeStatus() 每秒只喺「倒數頁 active」時先跑（見
     startRealtimeClock），即離開倒數頁嗰段時間係零更新 —— 呢個係可接受
     嘅，因為：宿主本身住喺 #page-realtime 裡面，唔 active 就冇人睇得到；
     跳字由 startedAt 即時推算（唔係逐秒累加），返嚟即刻追返正確值；
     真正要入帳嘅動作（停止）只可以喺倒數頁撳，唔會漏。
     唯一要小心嘅係：唔可以依靠「每秒都有 tick」去清理狀態（例如自動停止），
     所以呢個模組完全冇「靠 tick 計時到某個數就做嘢」嘅邏輯。 */

/** NOW 卡內部按鈕容器嘅 id（DOM Injection 掛載點） */
const OVERTIME_BOX_ID = 'overtime-btn-container';

/* ---------- 掛載點（DOM Injection） ---------- */

/**
 * 拎（冇就即場建立）NOW 卡內部嘅按鈕容器。
 * @returns {HTMLElement|null} 冇 NOW 卡（假期／載入失敗／課表未載入）→ null
 * ⚠ 一律 appendChild 做 .status-body 嘅最後一個子節點：需求指明容器要喺
 *   時間標籤（.time-range）正下方；插喺中間會令「科目／老師／時間／掣」
 *   嘅閱讀次序亂晒。
 * ⚠ 用 createElement 而唔係喺 #status-container 嘅 innerHTML 字串入面寫：
 *   本容器嘅生命週期必須緊貼 NOW 卡（一齊生、一齊被 innerHTML 沖走），
 *   否則會出現兩個同 id 嘅容器，getElementById 拎到邊個變成隨機。
 */
function overtimeButtonBox() {
    // ⚠ 一定要先排除「課表載入失敗」：main.js 嗰張錯誤卡都係用
    //   .status-card.now 砌出嚟（入面係 ERROR 標題 + 重試指示），
    //   唔擋嘅話拖堂掣會被塞入「載入課表失敗」卡裡面 —— 課表都讀唔到，
    //   撳「開始拖堂計時」完全冇意義，反而遮住重試指示。
    if (typeof scheduleLoadFailed !== 'undefined' && scheduleLoadFailed) return null;

    const body = document.querySelector('#status-container .status-card.now .status-body');
    if (!body) return null;

    const existing = document.getElementById(OVERTIME_BOX_ID);
    if (existing) {
        if (existing.parentNode === body) return existing;
        // 理論上唔會行到（NOW 卡只會有一張）；真係遇到孤兒就清走，
        // 寧可重建都唔可以喺文件裡面留低兩個同 id 嘅節點。
        if (existing.parentNode) existing.parentNode.removeChild(existing);
    }

    const box = document.createElement('div');
    box.id = OVERTIME_BOX_ID;
    box.className = 'overtime-box';
    body.appendChild(box);
    return box;
}

/** 清空宿主（#overtime-slot 空咗會靠 :empty 自己收埋，見 overtime.css） */
function overtimeClearHost(host) {
    if (!host) return;
    if (!host.firstChild && !host.hasAttribute('data-ot-key')) return;
    host.removeAttribute('data-ot-key');
    host.innerHTML = '';
}

/**
 * 依簽名重繪宿主，簽名一樣就一個字都唔改。
 * @returns {boolean} 有冇真正重寫 innerHTML
 * ⚠ 簽名寫喺「宿主節點自己身上」（data-ot-key）而唔係模組級變數：
 *   本模組有兩個宿主，而 NOW 卡一重建就會換一個全新嘅容器節點。
 *   用模組變數就要自己記住「邊個 key 屬於邊個節點」，一旦節點換咗而
 *   簽名啱好一樣，就會出現「新容器永遠空白」—— 正好就係今次要修嘅徵狀。
 *   寫喺節點身上，新節點冇屬性 → 必定重繪，生命週期天然同步。
 * ⚠ 計時中唔可以每秒重寫 innerHTML：紅點嘅呼吸動畫會每秒由頭播一次，
 *   結果變成「唔閃」；所以計時中只更新跳字（見 overtimeTick）。
 * ⚠ 刻意唔呼叫 animateCardsIn()：佢只揀 .class-card／.status-card／
 *   .holiday-card，本容器三個都唔係，叫咗都係空轉（留一句「以為有動畫」
 *   嘅假象最貴）。
 */
function overtimePaintHost(host, key, html) {
    if (!host) return false;
    if (host.getAttribute('data-ot-key') === key && host.firstChild) return false;
    host.setAttribute('data-ot-key', key);
    host.innerHTML = html;
    if (typeof hydrateIcons === 'function') hydrateIcons(host);
    return true;
}

/* ---------- 內容 ---------- */

/** 課堂資訊原文：科目 · 老師 · 時間（active 狀態物件用同樣四個欄位） */
function overtimeLessonText(lesson) {
    const parts = [];
    if (lesson && lesson.subject) parts.push(String(lesson.subject));
    if (lesson && lesson.teacher) parts.push(String(lesson.teacher));
    if (lesson && lesson.start && lesson.end) parts.push(String(lesson.start) + ' ~ ' + String(lesson.end));
    return parts.join(' · ');
}

/** 頂行：Beta 標籤 ＋ 一行說明／課堂資訊（＋ 計時中嘅紅點） */
function overtimeBoxHeadHtml(note, running) {
    return '<div class="overtime-box__head">' +
        '<span class="overtime-card__badge">Beta</span>' +
        '<span class="overtime-box__note">' + overtimeEscape(note) + '</span>' +
        (running ? '<span class="overtime-card__dot" aria-hidden="true"></span>' : '') +
        '</div>';
}

/**
 * 拖堂窗口內、未進入拖堂狀態：課堂資訊 ＋ 開始掣。
 * ⚠ 只有 overtimeTick 確認 overtimeWindowLesson() 唔係 null（＝ now >= 本堂
 *   原定下課時間、而下一節仲未開始）才會被呼叫，所以呢度唔需要再判時間：
 *   窗口外根本唔會渲染（連容器都清空，見 overtimeTick）。lesson 因此必定
 *   有值，唔可以再當佢可能係 null（舊版嗰句 OVERTIME_IDLE_HINT 已刪）。
 * ⚠ 掣用 --alert（iOS 警示風：淡紅底紅字）而唔係藍色：呢一刻老師已經拖堂，
 *   畫面應該帶住「紅＝落堂」嘅語意（同計時中嘅紅點、停止掣同一套語言），
 *   亦同普通「確認／下一步」型藍色掣區分開。
 * ⚠ 非正班唔出「撳得但永遠冇反應」嘅掣，改為一條唯讀提示條
 *   （.overtime-btn--locked）：一撳即有 toast 唔算好設計，用戶會以為係 bug；
 *   寫明原因先算交代得清楚。唯讀條同樣只喺窗口內出現 —— 冇正班身份嘅人
 *   喺上課期間一樣要見到乾淨版面，唔應該時時刻刻望住一句 Beta 限制。
 */
function overtimeIdleBoxHtml(lesson, guard) {
    if (!guard.ok) {
        return overtimeBoxHeadHtml('拖堂計時器', false) +
            '<div class="overtime-btn overtime-btn--locked" role="note">' +
            '<span class="overtime-btn__icon" data-icon="lock" data-icon-size="18"></span>' +
            '<span>Beta 功能僅限正班使用者體驗</span>' +
            '</div>';
    }
    return overtimeBoxHeadHtml(overtimeLessonText(lesson), false) +
        '<button class="overtime-btn overtime-btn--alert" type="button" onclick="overtimeStart()">' +
        '<span class="overtime-btn__icon" data-icon="timer" data-icon-size="19"></span>' +
        '<span>開始拖堂計時</span>' +
        '</button>';
}

/**
 * 計時中：大字跳字 ＋ 停止掣（NOW 卡內部版本，冇卡片外框）。
 * ⚠ 需求原文係「掣面顯示 (00:00)」，呢度改為喺掣上方以 34px 大字顯示秒數：
 *   同一個數字喺同一張卡出現兩次，就會有兩個「真相來源」，
 *   而且 15px 嘅掣面字細到企喺課室都睇唔清。掣面只留動作名稱。
 * ⚠ 秒數留空（唔寫 00:00）由 tick 填：卡一落地就係即時值，
 *   唔會有一格「00:00」閃過。
 */
function overtimeRunningBoxHtml(active) {
    return overtimeBoxHeadHtml(overtimeLessonText(active), true) +
        '<div class="overtime-card__clock">' +
        '<span class="overtime-card__unit">已拖堂</span>' +
        '<span class="overtime-card__num" id="overtime-clock"></span>' +
        '</div>' +
        '<button class="overtime-btn overtime-btn--stop" type="button" onclick="overtimeStop()">' +
        '<span class="overtime-btn__icon" data-icon="stopSquare" data-icon-size="19"></span>' +
        '<span>停止計時並記錄</span>' +
        '</button>';
}

/**
 * 後備宿主（#overtime-slot）用嘅完整一張卡。
 * 只有「計時中 ＋ NOW 卡唔存在」先用得着，所以要自帶卡片外框
 * （.overtime-card 嘅 --card-purple 底 ＋ 20px 圓角 ＋ 陰影）：
 * 插槽係頁面嘅直接子節點，冇 NOW 卡嗰層底，照搬無外框版本會變成一堆
 * 浮喺背景上面嘅字同掣。
 */
function overtimeFallbackCardHtml(active) {
    return '<div class="overtime-card">' +
        '<div class="overtime-card__head">' +
        '<span class="overtime-card__badge">Beta</span>' +
        '<span class="overtime-card__title">拖堂計時中</span>' +
        '<span class="overtime-card__dot" aria-hidden="true"></span>' +
        '</div>' +
        '<div class="overtime-card__meta">' + overtimeEscape(overtimeLessonText(active)) + '</div>' +
        '<div class="overtime-card__clock">' +
        '<span class="overtime-card__unit">已拖堂</span>' +
        '<span class="overtime-card__num" id="overtime-clock"></span>' +
        '</div>' +
        '<button class="overtime-btn overtime-btn--stop" type="button" onclick="overtimeStop()">' +
        '<span class="overtime-btn__icon" data-icon="stopSquare" data-icon-size="19"></span>' +
        '<span>停止計時並記錄</span>' +
        '</button>' +
        '</div>';
}

/**
 * 即刻補掛 ＋ 重繪（唔使等下一個 tick）。
 * 三個呼叫者：overtimeStart()／overtimeStop()（撳完要有即時反應）、
 * main.js 嘅 updateRealtimeStatus()（重建倒數區之後補掛，見檔頭第六節）。
 * ⚠ 一定要先叫 overtimeButtonBox()：佢會「順手」建立容器，令本函式
 *   亦係初始化時嘅掛載入口（頁面一載入就掛好，唔使等第一次使用者操作）。
 * ⚠ 兩個宿主嘅簽名都要清走：宿主可能啱啱由插槽轉去 NOW 卡容器，
 *   唔清就會出現「新宿主身上有舊簽名」而唔重繪。
 */
function overtimeMountNow() {
    const hosts = [overtimeButtonBox(), document.getElementById('overtime-slot')];
    for (let i = 0; i < hosts.length; i++) {
        if (hosts[i]) hosts[i].removeAttribute('data-ot-key');
    }
    overtimeTick(new Date());
}

/**
 * 每秒心跳（由 main.js 嘅 updateRealtimeStatus() 呼叫）。
 * 職責：決定而家應該畫喺邊個宿主、畫邊一張卡，同埋更新跳字。
 * ⚠ 計時中唔可以每秒重寫 innerHTML：紅點嘅呼吸動畫會每秒由頭播一次，
 *   結果變成「唔閃」；所以計時中只更新跳字，其餘一律等簽名改變才重繪。
 */
function overtimeTick(now) {
    const d = (now instanceof Date) ? now : new Date();
    const box = overtimeButtonBox();                        // 主：NOW 卡內部
    const slot = document.getElementById('overtime-slot');  // 備：頁面最底

    // 計時中優先於一切：假期／課表載入失敗／轉頁都唔應該令碼錶消失，
    // 否則學生會失去「停止」呢個唯一出口，秒數亦會一直計落去。
    const active = overtimeActive();
    if (active) {
        const seconds = Math.max(0, Math.round((d.getTime() - active.startedAt) / 1000));
        const key = 'run|' + active.startedAt + '|' + active.teacher + '|' + active.subject;
        if (box) {
            overtimePaintHost(box, key, overtimeRunningBoxHtml(active));
            overtimeClearHost(slot);
        } else {
            // NOW 卡唔存在（例如課表載入失敗卡取代咗成個倒數區）：
            // 改用後備卡，停止掣一定要留喺畫面上。
            overtimePaintHost(slot, key, overtimeFallbackCardHtml(active));
        }
        const clock = document.getElementById('overtime-clock');
        if (clock) clock.textContent = overtimeClockText(seconds);
        return;
    }

    // 假期優先權同倒數區一致：假期唔出計時器（即使課表當日照樣有排課）
    if (typeof getHolidaysOnDate === 'function' && getHolidaysOnDate(d).length > 0) {
        overtimeClearHost(box);
        overtimeClearHost(slot);
        return;
    }

    // 未計時：只有喺拖堂窗口內（＝已過本堂原定下課時間、下一節仲未開始）
    // 才渲染「開始掣」。窗口外（上課期間、小息前、放學後、時段外）一律
    // 「完全唔渲染」—— 連容器都清空，版面保持絕對乾淨。
    // ⚠ 時間條件就係 overtimeWindowLesson() 自己嘅判斷（end <= now 且
    //   now < 下一節 start／最尾一節放學後 60 分鐘），唔可以喺度另寫一套
    //   「now >= lesson.end」：兩套條件一定有一日唔同步，而呢個窗口同時
    //   係 overtimeStart() 嘅入帳守門員，唔同步就會出現「掣出得但入唔到帳」。
    // ⚠ 舊版係常駐顯示（窗口外改印一句灰字提示）；已按修訂要求移除：
    //   「未到落堂時間，落堂鐘響後先開始得」同停用感嘅藍掣都唔再存在。
    const lesson = overtimeWindowLesson(d);
    if (!lesson) {
        overtimeClearHost(box);
        overtimeClearHost(slot);
        return;
    }

    const guard = overtimeRegularClass();
    // 簽名要包埋權限：用戶中途登入／登出／轉班，卡片要即刻由唯讀提示條
    // 變成真正可用嘅開始掣，唔可以留住上一秒嘅版本（否則撳落去先發現係舊卡）。
    // 課堂四欄亦要入簽名 —— 落堂鐘一響嗰刻，lesson 由 null 變成「啱啱落堂
    // 嗰一堂」，簽名唔同才會即刻重繪出新掣。
    const key = 'idle|' + String(lesson.start) + '|' + String(lesson.end) + '|' +
        String(lesson.subject) + '|' + String(lesson.teacher) + '|' +
        (guard.ok ? 'ok' : 'locked');
    overtimePaintHost(box, key, overtimeIdleBoxHtml(lesson, guard));
    overtimeClearHost(slot);
}

/* =====================================================================
   七、老師拖堂排行榜（Beta）
   ===================================================================== */

/**
 * 排行榜取數入口（同步）：有雲端結果就用雲端，否則退回本機聚合。
 * ⚠ 兩者永遠唔會合併：同一筆拖堂喺雲端同本機都有一份，
 *   合併計算就會被計兩次（見檔頭「雲端」註解）。
 * @returns {{stats:Array, source:'cloud'|'local'}}
 */
function overtimeLeaderboardStats() {
    if (overtimeCloudStats) return { stats: overtimeCloudStats, source: 'cloud' };
    return { stats: overtimeTeacherStats(), source: 'local' };
}

/**
 * 拉雲端排行榜（唯一嘅非同步取數點，由子頁面嘅 after() 呼叫）。
 * @returns {Promise<Array|null>} 成功回傳已排序 stat 陣列；失敗回 null
 *
 * ⚠ 用 RPC（/rest/v1/rpc/overtime_leaderboard）而唔係前端自己 group by：
 *   聚合同「協同教學拆名」嘅規則只可以有一份，否則雲端榜同本機榜
 *   會出現兩個唔同嘅名次（見建表腳本第 4 節）。
 * ⚠ retry: 0 —— 呢個係唯讀查詢，重試安全，但排行榜係「開頁即載」，
 *   連環重試只會令用戶望住「載入中」更久；失敗就照實顯示，唔好扮成功。
 */
async function fetchOvertimeLeaderboard() {
    overtimeCloudState = 'loading';
    overtimeCloudError = '';

    if (typeof sbRequest !== 'function' || typeof cloudEnabled !== 'function' || !cloudEnabled()) {
        overtimeCloudState = 'error';
        overtimeCloudError = '雲端排行榜未啟用（本機模式）';
        return null;
    }

    let result;
    try {
        result = await sbRequest('/rest/v1/rpc/' + OVERTIME_LEADERBOARD_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: { max_rows: OVERTIME_LEADERBOARD_LIMIT }
        }, { auth: 'user', retry: 0, timeoutMs: OVERTIME_CLOUD_TIMEOUT_MS });
    } catch (error) {
        result = { ok: false, code: 'NETWORK', message: String((error && error.message) || error) };
    }

    if (!result || !result.ok) {
        overtimeCloudState = 'error';
        overtimeCloudError = (result && result.code) === 'NO_SESSION'
            ? '尚未登入雲端帳號，以下為本機紀錄'
            : '雲端排行榜暫時連唔上，以下為本機紀錄';
        return null;
    }

    const rows = Array.isArray(result.data) ? result.data : [];
    overtimeCloudStats = rows
        .map(overtimeStatFromCloudRow)
        .filter(Boolean)
        // 伺服器已經排好序，呢度照排一次：榜單排序係 UI 嘅責任，
        // 唔應該建立喺「RPC 一定會排」之上（日後改 SQL 就靜靜壞掉）。
        .sort((a, b) => (b.seconds - a.seconds) || a.name.localeCompare(b.name))
        .slice(0, OVERTIME_LEADERBOARD_LIMIT);

    overtimeCloudState = 'ready';
    return overtimeCloudStats;
}

/**
 * 雲端 RPC 一列 → 本檔內部 stat 形狀（同 overtimeTeacherStats() 一致）。
 * @param {object} row { teacher_name, total_seconds, record_count, subjects, classes }
 * ⚠ 秒數／次數一律經 Number() 再夾範圍：PostgREST 嘅 bigint 會以 JSON 數字
 *   或字串到達（視乎數值大小），直接相加會變成字串串接（"120" + "60" = "12060"）。
 */
function overtimeStatFromCloudRow(row) {
    if (!row || typeof row !== 'object') return null;
    const name = String(row.teacher_name || '').trim();
    if (!name) return null;
    const seconds = Math.max(0, Math.round(Number(row.total_seconds) || 0));
    const count = Math.max(0, Math.round(Number(row.record_count) || 0));
    return {
        name: name,
        seconds: seconds,
        count: count,
        subjects: Array.isArray(row.subjects) ? row.subjects.map(String).filter(Boolean) : [],
        classes: Array.isArray(row.classes) ? row.classes.map(String).filter(Boolean) : []
    };
}

/**
 * 依老師聚合拖堂秒數，降序（同分以姓名排，令榜單重繪時唔會跳位）。
 * ⚠ 呢個係「本機後備」聚合：雲端連唔上時排行榜先用佢。
 *   本機清單只含「同一部裝置、所有帳號」嘅紀錄，所以呢個榜係唔完整嘅，
 *   頁面必須講明（見 overtimeLeaderboardHtml 嘅失敗提示）。
 * @returns {Array<{name:string,seconds:number,count:number,subjects:string[],classes:string[]}>}
 * ⚠ 協同教學（"徐梓駿/蕭沛強"）拆成兩位老師，各記全額秒數，唔對半分：
 *   同一堂課確實係兩位老師一齊拖；對半分（各 30 秒）係一個冇人驗證得到
 *   嘅數字，而且對半之後兩位都排唔上頭，個榜就失去意義。
 *   ⇒ 因此「各人之和」會大於「課堂總拖堂時數」，係刻意嘅，唔係計錯數。
 * ⚠ 拆名只做兩件事：split(OVERTIME_TEACHER_SPLIT) 同 trim()。唔會做任何
 *   「清洗」（例如去掉括號、去掉「老師」二字、統一全半角）—— 老師名嘅
 *   權威來源係課表，本模組只負責照抄同分類；一旦喺度加工，排行榜出現嘅
 *   名字就會同課表對唔上，用戶會直接質疑個榜嘅可信度。
 * ⚠ OVERTIME_TEACHER_SPLIT 係單字元 class 嘅正規表達式（無 g flag），
 *   split() 唔會累積 lastIndex，所以逐筆、逐秒重複呼叫都唔會有狀態殘留。
 */
function overtimeTeacherStats() {
    const map = Object.create(null);
    overtimeRecords().forEach(rec => {
        String(rec.teacher || '').split(OVERTIME_TEACHER_SPLIT).forEach(raw => {
            const name = raw.trim();
            if (!name) return;
            let item = map[name];
            if (!item) {
                item = { name: name, seconds: 0, count: 0, subjects: [], classes: [] };
                map[name] = item;
            }
            item.seconds += rec.seconds;
            item.count += 1;
            if (rec.subject && item.subjects.indexOf(rec.subject) === -1) item.subjects.push(rec.subject);
            if (rec.className && item.classes.indexOf(rec.className) === -1) item.classes.push(rec.className);
        });
    });
    return Object.keys(map)
        .map(name => map[name])
        .sort((a, b) => (b.seconds - a.seconds) || a.name.localeCompare(b.name));
}

/** 一串項目收成「A、B 等」（頒獎台每欄只有 ~100px，唔可以無限長） */
function overtimeListText(items, max) {
    const list = items || [];
    if (!list.length) return '';
    const limit = max || 2;
    const shown = list.slice(0, limit).join('、');
    return list.length > limit ? (shown + ' 等') : shown;
}

/**
 * 頒獎台一欄：台座（排名 ＋ 時間 ＋ 次數）＋ 台座上方嘅人物資訊欄。
 * ⚠ 依需求「唔顯示頭像」：呢度冇任何頭像圓圈／頭像佔位，
 *   台座上台只放數字同文字（見 overtime.css 嘅 .ot-podium 註解）。
 * ⚠ DOM 次序刻意係「台座上方資訊欄 → 台座」：資訊欄（.ot-podium__info）
 *   係 .ot-podium__col 嘅第一個子節點，台座緊隨其後，兩者由 flex 排開，
 *   唔會出現「台座頂邊壓住姓名」。
 * ⚠ 科目同班級刻意分兩行：一欄約 100px，「科目 · 班級」一行必定爆。
 * ⚠ 台座內只放「一行大字時間 ＋ 一行小字次數」：
 *   舊版第三行重覆印一次原始秒數（15 秒 大字下面再寫一次 15 秒），
 *   同一個數字喺同一個台座出現兩次，除咗佔位就只係噪音，所以刪咗。
 *   秒數原文仍然查得到 —— 4~10 名列表同拖堂紀錄都係用 overtimeDurationText()。
 */
function overtimePodiumColHtml(stat, rank) {
    const parts = overtimeDurationParts(stat.seconds);
    return '<div class="ot-podium__col ot-podium__col--' + rank + '">' +
        '<div class="ot-podium__info">' +
        '<span class="ot-podium__name">' + overtimeEscape(stat.name) + '</span>' +
        '<span class="ot-podium__sub">' + overtimeEscape(overtimeListText(stat.subjects, 1) || '未記錄科目') + '</span>' +
        '<span class="ot-podium__sub">' + overtimeEscape(overtimeListText(stat.classes, 1) || '未記錄班級') + '</span>' +
        '</div>' +
        '<div class="ot-podium__step">' +
        '<span class="ot-podium__rank">' + rank + '</span>' +
        '<span class="ot-podium__time">' + overtimeEscape(parts.value) +
        '<small>' + overtimeEscape(parts.unit) + '</small></span>' +
        '<span class="ot-podium__count">共 ' + stat.count + ' 次</span>' +
        '</div>' +
        '</div>';
}

/**
 * TOP 1~3 頒獎台。
 * ⚠ DOM 次序刻意係 2（左）→ 1（中）→ 3（右），唔係 1→2→3：
 *   需求要 TOP 1 居中居高，用 flex 排序就要靠 DOM 次序，唔靠 CSS order
 *   （order 會令讀屏讀出「第二名、第一名、第三名」，同視覺次序唔一致）。
 * ⚠ 只有一兩位老師時，缺少嘅一欄直接唔出（唔會出三個空台座）。
 */
function overtimePodiumHtml(top) {
    return '<div class="ot-podium">' +
        (top[1] ? overtimePodiumColHtml(top[1], 2) : '') +
        overtimePodiumColHtml(top[0], 1) +
        (top[2] ? overtimePodiumColHtml(top[2], 3) : '') +
        '</div>';
}

/** 4~10 名一列：排名數字 ＋ 姓名 ＋ 科目/班級 ＋ 總時長 */
function overtimeRowHtml(stat, rank) {
    const meta = [overtimeListText(stat.subjects), overtimeListText(stat.classes)]
        .filter(Boolean).join(' · ');
    const detail = meta ? (meta + ' · 共 ' + stat.count + ' 次') : ('共 ' + stat.count + ' 次');
    return '<div class="ot-row">' +
        '<span class="ot-row__no">' + rank + '</span>' +
        '<span class="ot-row__body">' +
        '<span class="ot-row__name">' + overtimeEscape(stat.name) + '</span>' +
        '<span class="ot-row__meta">' + overtimeEscape(detail) + '</span>' +
        '</span>' +
        '<span class="ot-row__time">' + overtimeEscape(overtimeDurationText(stat.seconds)) + '</span>' +
        '</div>';
}

/** 空狀態：講清楚「點樣先會有紀錄」，而唔係一句「冇資料」 */
function overtimeEmptyHtml() {
    return '<section class="ios-card">' +
        '<div class="ot-empty">' +
        '<span class="ot-empty__icon" data-icon="timer" data-icon-size="30"></span>' +
        '<span class="ot-empty__title">仲未有拖堂紀錄</span>' +
        '<span class="ot-empty__desc">到原定下課時間老師仲未落堂，就可以喺倒數頁按「開始拖堂計時」；' +
        '停止之後，時間會自動歸入該堂老師名下。</span>' +
        '</div></section>';
}

/**
 * 子頁面：老師拖堂排行榜（Beta）。內容係兩個獨立區塊 ——
 * 頒獎台卡、4~10 名列表卡，中間嘅 16px 間距由
 * #profile-detail-body（.ios-home）嘅 gap 提供；而卡片同上方導覽列之間嘅
 * 16px 內距由 .sub-page__body（padding: 16px）提供，本檔唔可以再加
 * margin-top / padding-top —— 兩處都加就會變成 32px（本專案舊版就係
 * 因為呢種「補丁式內距」而出現「卡片浮在半空」嘅問題，見 profile.css）。
 *
 * ⚠ 呢個函數係「同步」嘅（profileRenderDetail() 直接呼叫 page.html()），
 *   所以佢只可以由快取／本機即時砌出畫面，雲端數據由 overtimeLeaderboardAfter()
 *   拉返嚟之後再重畫（見 overtimePaintLeaderboard）。
 */
function overtimeLeaderboardHtml() {
    const board = overtimeLeaderboardStats();
    const stats = board.stats;

    /* ⚠ 頁頂嘅「Beta ＋ 資料範圍」說明欄已經移除：
         需求要求版面由頒獎台直接開始，唔好喺卡片之前多一段文字。
         「Beta」標籤同時搬去導覽列標題右側（見本檔尾 PROFILE_DETAIL_PAGES
         嘅 badge 欄 ＋ profile.css 嘅 .beta-badge），所以呢度唔應該再出一次
         —— 兩個地方都掛 Beta 就係同一句話講兩次。
       ⚠ 「已連結雲端」呢個資料範圍說明一併刪除，唔係因為佢冇用，而係因為
         佢同下面嘅失敗提示重複：雲端通嘅時候用戶根本唔需要知資料喺邊，
         連唔上嘅時候先至需要講（下面嗰句會出）。 */

    let html = '';

    // 雲端失敗／未取到：老實講明而家睇到嘅係本機紀錄，
    // 唔可以靜靜用本機數據扮成「全班排行榜」（個榜會細一大截）。
    if (board.source === 'local') {
        const note = overtimeCloudError ||
            (overtimeCloudState === 'loading' ? '正在連接雲端排行榜…' : '雲端排行榜載入中…');
        html += '<p class="ot-hint ot-hint--warn">' + overtimeEscape(note) + '</p>';
    }

    if (!stats.length) return html + overtimeEmptyHtml();

    html += '<section class="ios-card">' + overtimePodiumHtml(stats.slice(0, 3)) + '</section>';

    const rest = stats.slice(3, OVERTIME_LEADERBOARD_LIMIT);
    if (rest.length) {
        html += '<section class="ios-card"><div class="ios-list">' +
            rest.map((stat, i) => overtimeRowHtml(stat, i + 4)).join('') +
            '</div></section>';
    }

    // ⚠ 唔再報「另外 N 位老師未列出」：RPC 只回前 10 名，
    //   前端根本唔知後面仲有幾多位，亂填一個數就係講大話。
    if (stats.length >= OVERTIME_LEADERBOARD_LIMIT) {
        html += '<p class="ot-note">只顯示前 ' + OVERTIME_LEADERBOARD_LIMIT + ' 名，其餘名次未列出。</p>';
    }

    return html;
}

/**
 * 子頁面 after()：拉雲端排行榜並重畫。
 * ⚠ 唔可以呼叫 profileRenderDetail() 重畫：佢會再叫一次 after()，
 *   形成「拉資料 → 重畫 → 再拉資料」嘅無限迴圈。所以只換
 *   #profile-detail-body 嘅內容（見 overtimePaintLeaderboard）。
 */
async function overtimeLeaderboardAfter() {
    // 先即刻畫一次：有快取就出快取（唔會閃一下空白），
    // 冇快取就出「載入中…」（清走上一次嘅失敗原因，唔好一路掛住舊錯）。
    if (!overtimeCloudStats) {
        overtimeCloudError = '';
        overtimeCloudState = 'loading';
    }
    overtimePaintLeaderboard();

    await fetchOvertimeLeaderboard();

    // 唔論成敗都重畫：成功 → 換上雲端名次；失敗 → 把「載入中…」
    // 換成失敗原因，並改用本機聚合嘅數據。
    overtimePaintLeaderboard();
}

/**
 * 只重畫排行榜子頁面嘅內容（唔經 profileRenderDetail，見 after() 嘅註解）。
 * ⚠ 一定要確認「而家真係喺排行榜頁」才畫：呢個函數係非同步跑完之後才執行，
 *   用戶完全有可能已經返回上一頁（甚至入咗另一頁），盲畫就會把
 *   排行榜內容蓋到別人嘅頁面上。
 */
function overtimePaintLeaderboard() {
    if (typeof profileView === 'undefined' || profileView !== 'detail') return;
    if (typeof profileDetailKey === 'undefined' || profileDetailKey !== 'overtime') return;

    const body = document.getElementById('profile-detail-body');
    if (!body) return;

    body.innerHTML = overtimeLeaderboardHtml();
    if (typeof hydrateIcons === 'function') hydrateIcons(body);
}

/* =====================================================================
   八、註冊子頁面（個人中心 → 老師拖堂排行榜）
   =====================================================================
   ⚠ 冇喺 profile.js 嘅 PROFILE_DETAIL_PAGES 字面量度加 key：排行榜係獨立
     模組，key／標題／內容三樣嘢都應該跟模組一齊走（日後整頁刪除只需要
     刪 overtime.js ＋ index.html 一行入口，唔使再翻 profile.js）。
   ⚠ 必須喺 profile.js 之後載入（見 index.html 嘅 script 次序）：
     PROFILE_DETAIL_PAGES 係 profile.js 嘅 const，用 typeof 探測
     TDZ 期間嘅 const 一樣會 throw ReferenceError，唔似未宣告嘅變數咁安全。 */
if (typeof PROFILE_DETAIL_PAGES !== 'undefined') {
    // after：排行榜本體在雲端，一定要拉返嚟才畫得準。
    // profileRenderDetail() 會先同步呼叫 html()（出快取／載入中），
    // 之後才叫 after() 拉資料再重畫 —— 次序同 profile.js 嘅 storage 頁一致。
    // ⚠ 每次推入呢頁都會重新拉一次（html() 唔會留住上一次嘅快照），
    //   所以呢頁天生就係「即時榜」。
    PROFILE_DETAIL_PAGES.overtime = {
        title: '老師拖堂排行榜',
        // 導覽列標題右側嘅 Beta 膠囊（profile.js 讀 badge，profile.css 提供
        // .beta-badge 樣式）。放喺呢度而唔係喺 profile.js 寫 if (key === 'overtime')：
        // 頁面自己嘅標記應該跟模組一齊走，刪頁時唔使再翻 profile.js。
        badge: 'Beta',
        html: overtimeLeaderboardHtml,
        after: overtimeLeaderboardAfter
    };
}
