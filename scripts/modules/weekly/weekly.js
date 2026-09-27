// ================= 共用常數 =================
const WEEKLY_DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
const WEEKLY_DAYS = [1, 2, 3, 4, 5, 6];      // 只顯示週一 ~ 週六
const WEEKLY_PERIOD_COUNT = 7;

// 老師欄位可能載多位老師，資料以「/」分隔（例如「容毅燊/張永豪」）。
// ⚠ 顯示上嚴禁用「‧」中點號分隔多位老師：渲染時亦一律用 /（見 renderWeeklyGrid）。
//    本 regex 只係「讀取兼容」——舊資料嘅 ‧ / · / ・ / 、 / ， / , 都照樣拆得開，
//    資料未及統一都唔會漏咗第二位老師。
const WEEKLY_TEACHER_SEPARATORS = /[‧·・、,，\/]/;

// 把「容毅燊/張永豪」拆成 ['容毅燊', '張永豪']
function weeklySplitTeachers(value) {
    return String(value == null ? '' : value)
        .split(WEEKLY_TEACHER_SEPARATORS)
        .map(name => name.trim())
        .filter(Boolean);
}

/**
 * 節次時間表：由課表資料推導（同一節在各日通常一樣，取出現最多次嘅為準）。
 * 特意唔寫死時間，令「節次標籤、課表格子、老師／科目彈窗」三處顯示嘅時間
 * 一定同資料一致，唔會各自寫死而走樣。
 */
function weeklyPeriodTimeMap() {
    const stats = {};

    Object.keys(scheduleData).forEach(day => {
        (scheduleData[day] || []).forEach(cls => {
            if (!cls || !cls.period || !cls.start || !cls.end) return;
            const key = String(cls.period);
            const sig = cls.start + '~' + cls.end;
            if (!stats[key]) stats[key] = {};
            stats[key][sig] = (stats[key][sig] || 0) + 1;
        });
    });

    const map = {};
    Object.keys(stats).forEach(period => {
        const best = Object.keys(stats[period]).sort((a, b) => stats[period][b] - stats[period][a])[0];
        const parts = best.split('~');
        map[period] = { start: parts[0], end: parts[1] };
    });
    return map;
}

// 單一節次嘅時間文字：上下兩行（'08:05\n08:50'）；冇資料就回傳空字串。
// ⚠ 唔寫死時間，全部由課表資料推導，改 data/schedule.json 就會自動跟隨。
function weeklyPeriodTimeText(period, times) {
    const slot = (times || {})[String(period)];
    return slot ? slot.start + '\n' + slot.end : '';
}

// ================= 功能 3：本週課表總覽 =================
function renderWeeklyGrid() {
    const container = document.getElementById('weekly-grid-container');
    if (!container) return;

    bindWeeklyGridEvents(container);

    const times = weeklyPeriodTimeMap();

    let html = '<table class="weekly-table">';
    // ⚠ 節次欄寬一定要寫喺呢個表頭格：table-layout: fixed 只認第一行嘅欄寬，
    //    寫喺下面 <td class="period-cell"> 會被完全忽略，令時間文字被 ellipsis 截斷。
    html += '<thead><tr><th class="period-col"></th>';
    WEEKLY_DAYS.forEach(day => {
        html += `<th>週${WEEKLY_DAY_NAMES[day]}</th>`;
    });
    html += '</tr></thead><tbody>';

    for (let period = 1; period <= WEEKLY_PERIOD_COUNT; period++) {
        // 節次欄：上層「第 X 節」，下層時間分兩行（靠 CSS white-space: pre-line 斷行）
        // ⚠ 唔可以喺 <td> 直接用 display:flex，會令佢脫離表格佈局，所以要包一層 inner
        html += `
            <td class="period-cell">
                <div class="period-cell__inner">
                    <span class="period-label">第${period}節</span>
                    <span class="period-time">${weeklyPeriodTimeText(period, times)}</span>
                </div>
            </td>
        `;

        WEEKLY_DAYS.forEach(day => {
            const classes = scheduleData[day] || [];
            const cls = classes.find(c => c.period === period);

            if (!cls) {
                html += '<td class="empty-cell">—</td>';
                return;
            }

            const teachers = weeklySplitTeachers(cls.teacher);
            // 用 data 屬性傳值 + 事件代理，避免科目名含引號時 onclick 字串被截斷
            html += `
                <td class="class-cell">
                    <div class="cell-content">
                        <div class="mini-subject subject-title" data-subject="${escapeHtml(cls.subject)}">${escapeHtml(cls.subject)}</div>
                        ${teachers.length ? `<div class="mini-teacher">${teachers.map(name =>
                            `<span class="teacher-name" data-teacher="${escapeHtml(name)}">${escapeHtml(name)}</span>`
                        ).join('<span class="teacher-sep">/</span>')}</div>` : ''}
                    </div>
                </td>
            `;
        });
        html += '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
}

// 事件代理：格子係每次重繪產生，绑定一次喺容器上就唔怕被覆蓋
function bindWeeklyGridEvents(container) {
    if (!container || container._weeklyClickBound) return;
    container._weeklyClickBound = true;

    container.addEventListener('click', event => {
        const target = event.target;
        if (!target || typeof target.closest !== 'function') return;

        const subjectEl = target.closest('.subject-title');
        if (subjectEl) {
            openSubjectScheduleModal(subjectEl.dataset.subject);
            return;
        }

        const teacherEl = target.closest('.teacher-name');
        if (teacherEl) {
            // ⚠ 阻止冒泡：老師名嵌喺課堂卡片（.class-cell）之內，唔攔嘅話
            //    同一 click 會再傳到卡片本身嘅處理器，令「全級課表」彈窗
            //    一開就被課堂詳情蓋住／互相搶 focus。
            event.stopPropagation();
            event.preventDefault();
            // 改為跨班級全域搜尋（全級總課表）。
            // openTeacherScheduleModal 保留唔刪：仍然係「單班檢視」同後備路徑。
            showTeacherGlobalSchedule(teacherEl.dataset.teacher);
        }
    });
}

// ================= 彈窗共用外殼 =================
function openWeeklyModal(innerHtml, extraClass) {
    closeInfoModal();      // 先清走舊彈窗，避免疊住兩層

    const overlay = document.createElement('div');
    overlay.className = 'info-modal-overlay';
    overlay.setAttribute('onclick', 'closeInfoModal(event)');

    const content = document.createElement('div');
    // extraClass 讓個別彈窗可以加闊（全級總課表要放 6 欄網格，380px 會被擠爆）。
    // 唔傳 == 同以前完全一樣，原有彈窗（老師單班／科目）不受影響。
    content.className = 'info-modal-content' + (extraClass ? ' ' + extraClass : '');
    content.setAttribute('onclick', 'event.stopPropagation()');
    content.innerHTML = innerHtml;

    overlay.appendChild(content);
    document.body.appendChild(overlay);

    bindWeeklyModalEscape();
}

// ESC 關閉（只绑一次）
function bindWeeklyModalEscape() {
    if (document._weeklyModalEscBound) return;
    document._weeklyModalEscBound = true;

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeInfoModal();
    });
}

function weeklyModalHeader(iconName, title) {
    return `
        <div class="info-modal-header">
            <div class="info-modal-title">
                <span class="info-modal-icon">${icon(iconName, { size: 22 })}</span>
                <span>${escapeHtml(title)}</span>
            </div>
            <button class="info-modal-close" onclick="closeInfoModal()">${icon('close', { size: 15 })}</button>
        </div>
    `;
}

// ================= 彈窗 A：該老師嘅一週課表 =================
function openTeacherScheduleModal(teacherName) {
    const name = String(teacherName == null ? '' : teacherName).trim();
    if (!name) return;

    // 收集該老師全部課堂：key = "日|節"
    const slots = {};
    let total = 0;

    Object.keys(scheduleData).forEach(day => {
        (scheduleData[day] || []).forEach(cls => {
            if (!cls || !cls.period) return;
            if (weeklySplitTeachers(cls.teacher).indexOf(name) === -1) return;
            slots[day + '|' + cls.period] = cls;
            total++;
        });
    });

    if (!total) return;

    const times = weeklyPeriodTimeMap();

    let grid = '<table class="week-modal-table"><thead><tr><th></th>';
    WEEKLY_DAYS.forEach(day => { grid += `<th>週${WEEKLY_DAY_NAMES[day]}</th>`; });
    grid += '</tr></thead><tbody>';

    for (let period = 1; period <= WEEKLY_PERIOD_COUNT; period++) {
        const time = times[String(period)];
        grid += `<tr><th class="wm-period">
                    <span class="wm-period__n">${period}</span>
                    ${time ? `<span class="wm-period__t">${time.start}</span>` : ''}
                 </th>`;

        WEEKLY_DAYS.forEach(day => {
            const cls = slots[day + '|' + period];
            // 有課 → 高亮卡片；空堂 → 留灰底（一眼睇出老師幾時得閒）
            if (cls) {
                const timeText = cls.start && cls.end ? `${cls.start} ~ ${cls.end}` : '';
                grid += `<td class="wm-cell is-on" title="${escapeHtml(cls.subject + (timeText ? ' · ' + timeText : ''))}">
                            <span class="wm-cell__subject">${escapeHtml(cls.subject)}</span>
                         </td>`;
            } else {
                grid += '<td class="wm-cell"><span class="wm-cell__dot"></span></td>';
            }
        });
        grid += '</tr>';
    }
    grid += '</tbody></table>';

    openWeeklyModal(
        weeklyModalHeader('user', name + ' 老師的課表') +
        `<div class="info-modal-subtitle">本週共 ${total} 堂課 · 灰格代表空堂</div>` +
        `<div class="week-modal-grid">${grid}</div>`
    );
}

// ================= 彈窗 C：老師「全級」總課表（跨班級全域掃描） =================
/**
 * 跨班級搜尋某位老師嘅所有課堂，並以「全級總課表」彈窗呈現。
 *
 * 與上面 openTeacherScheduleModal 嘅分別（後者保留，唔會刪）：
 *   openTeacherScheduleModal  → 只掃 scheduleData（＝目前選中班級），
 *                               所以只見到「該班」嘅課，睇唔到老師喺其他班嘅課。
 *   showTeacherGlobalSchedule → 掃 DB 內「所有已註冊班級」嘅課表集合
 *                               （schedule:<classId>），逐堂標註授課班級。
 *
 * @param {string} teacherName 老師姓名（由 .teacher-name 拆出嘅單一名字）
 * @returns {Promise<void>}
 */
async function showTeacherGlobalSchedule(teacherName) {
    const name = String(teacherName == null ? '' : teacherName).trim();
    if (!name) return;

    const title = name + ' 老師 - 全級總課表';

    // 先出「載入中」：DB.load() 未命中快取時要走網絡，唔可以令畫面似「壞咗」
    openWeeklyModal(
        weeklyModalHeader('user', title) +
        '<div class="info-modal-subtitle">正在搜尋全級課表…</div>',
        'is-wide'      // 同最終結果同寬，避免載入完成後彈窗突然變闊
    );

    let body;
    try {
        const targets = weeklyGlobalClassTargets();
        const scans = await Promise.all(targets.map(weeklyLoadClassSchedule));
        const lessons = weeklyCollectTeacherLessons(name, scans);

        // 全級都搵唔到（例如各班資料尚未載入完成）→ 退回原本「按班級」彈窗，
        // 至少顯示目前班級睇得到嘅課，唔會畀使用者一個空白彈窗。
        if (!lessons.length) {
            openTeacherScheduleModal(name);
            return;
        }

        body = weeklyRenderTeacherGlobal(lessons);
    } catch (e) {
        body = '<div class="info-modal-empty">搜尋全級課表時發生錯誤：' +
            escapeHtml(e && e.message ? e.message : String(e)) + '</div>';
    }

    // is-wide：6 欄網格 + 班級標籤，用預設 380px 會被擠壓變形
    openWeeklyModal(weeklyModalHeader('user', title) + body, 'is-wide');
}

/**
 * 建立「要掃嘅班級」清單。
 * 三個來源合併，避免任何一種資料未載入就走漏班級：
 *   1. DB 的 classes 集合 —— 權威班名（初二信／初二望…）
 *   2. DB 已註冊嘅 schedule:* 集合 —— 涵蓋所有班級專屬課表
 *   3. 目前班級 —— 排最前，且一定有記憶體內資料（scheduleData）
 */
function weeklyGlobalClassTargets() {
    const targets = [];
    const seen = {};
    const classNames = {};
    const hasDB = (typeof DB !== 'undefined') && DB && (typeof DB.get === 'function');

    // ---- 來源 1：權威班名 ----
    const doc = hasDB ? DB.get('classes') : null;
    const classes = (typeof dbClassArray === 'function') ? dbClassArray(doc) : [];
    classes.forEach(cls => {
        if (cls && cls.id) classNames[cls.id] = cls.name || cls.id;
    });

    const push = (classId, className, collection, preloaded) => {
        if (!classId || seen[classId]) return;
        seen[classId] = true;
        targets.push({
            classId: classId,
            // 冇班名時退回 classId，確保唔會顯示 undefined
            className: className || classNames[classId] || classId,
            collection: collection,
            preloaded: preloaded || null
        });
    };

    // ---- 來源 3：目前班級排最前，兼且一定有記憶體內資料 ----
    if (typeof currentScheduleName === 'string' && currentScheduleName) {
        const currentId = String(currentScheduleName).replace(/^schedule:/, '');
        if (currentId && currentId !== 'default') {
            push(currentId, classNames[currentId], currentScheduleName,
                (scheduleData && typeof scheduleData === 'object') ? scheduleData : null);
        }
    }

    // ---- 來源 2：DB 已註冊嘅全部課表集合 ----
    // ⚠ 「default」係「冇專屬檔案班級」嘅後備課表，唔屬於任何真實班級。
    //    佢同真實班級嘅內容重疊，一齊掃會令同一堂課被計兩次，
    //    所以另存，最後才決定用唔用。
    let fallback = null;
    const defs = (hasDB && typeof DB.list === 'function') ? DB.list('schedules') : [];
    defs.forEach(def => {
        if (!def || !def.name) return;

        const classId = def.classId || String(def.name).replace(/^schedule:/, '');
        if (!classId) return;

        // def.label 形如「初二信 課表」；冇權威班名時剝走尾綴做顯示名
        const label = String(def.label || '').replace(/\s*課表$/, '').trim();
        const className = classNames[classId] || label || classId;

        if (classId === 'default') {
            if (!fallback) {
                fallback = { classId: classId, className: className, collection: def.name, preloaded: null };
            }
            return;
        }

        push(classId, className, def.name, null);
    });

    // 只有連一個真實班級都冇（例如班級清單未載入）時，才用後備課表頂上，
    // 令「點老師名」至少仍然有嘢睇。
    if (!targets.length && fallback) targets.push(fallback);

    return targets;
}

/**
 * 讀取單一班級嘅課表。
 * 優先次序：記憶體內資料 → DB 記憶體快取 → DB.load()（可能走網絡）。
 * ⚠ 單一班級讀取失敗唔可以令整個彈窗爆掉，所以 catch 之後回傳空物件，
 *    其餘班級照樣顯示。
 */
function weeklyLoadClassSchedule(target) {
    const wrap = data => ({
        classId: target.classId,
        className: target.className,
        data: (data && typeof data === 'object') ? data : {}
    });

    const nonEmpty = value =>
        (value && typeof value === 'object' && Object.keys(value).length) ? value : null;

    const preloaded = nonEmpty(target.preloaded);
    if (preloaded) return Promise.resolve(wrap(preloaded));

    const cached = (typeof DB !== 'undefined') && DB && (typeof DB.get === 'function')
        ? nonEmpty(DB.get(target.collection))
        : null;
    if (cached) return Promise.resolve(wrap(cached));

    if (typeof DB === 'undefined' || !DB || typeof DB.load !== 'function') {
        return Promise.resolve(wrap({}));
    }

    return DB.load(target.collection).then(
        data => wrap(data),
        () => wrap({})      // 單班失敗當作冇課
    );
}

/**
 * 全域掃描：由所有班級嘅課表抽出該老師嘅每一堂課。
 * ⚠ 唔再只過濾單一 class_id —— 呢個就係「全級」嘅意思。
 */
function weeklyCollectTeacherLessons(teacherName, scans) {
    const lessons = [];

    scans.forEach(scan => {
        const data = (scan && scan.data) || {};
        Object.keys(data).forEach(day => {
            const dayNum = Number(day);
            if (!dayNum) return;

            (Array.isArray(data[day]) ? data[day] : []).forEach(cls => {
                if (!cls || !cls.period) return;
                // 拆開「容毅燊/張永豪」逐位精確比對；
                // 唔用 includes()，否則「張永」會誤中「張永豪」。
                if (weeklySplitTeachers(cls.teacher).indexOf(teacherName) === -1) return;

                lessons.push({
                    day: dayNum,
                    period: Number(cls.period) || 0,
                    start: cls.start || '',
                    end: cls.end || '',
                    subject: cls.subject || '',
                    room: cls.room || '',
                    classId: scan.classId,
                    className: scan.className
                });
            });
        });
    });

    // 跨班同日同節可以有多堂（老師同時教兩班屬異常，但顯示上要如實呈現）
    lessons.sort((a, b) =>
        (a.day - b.day) ||
        (a.period - b.period) ||
        String(a.className).localeCompare(String(b.className))
    );
    return lessons;
}

/**
 * 全級節次時間表：由「所有掃到嘅課堂」推導。
 * ⚠ 唔可以沿用 weeklyPeriodTimeMap()：佢只讀 scheduleData（＝目前班級），
 *    跨班時若某節次只出現喺其他班，就會拎唔到時間交白卷。
 * 同一節在不同班若時間不一致，取出現最多次嘅為準（與 weeklyPeriodTimeMap 同策略）。
 */
function weeklyLessonsTimeMap(lessons) {
    const stats = {};

    lessons.forEach(cls => {
        if (!cls.period || !cls.start || !cls.end) return;
        const key = String(cls.period);
        const sig = cls.start + '~' + cls.end;
        if (!stats[key]) stats[key] = {};
        stats[key][sig] = (stats[key][sig] || 0) + 1;
    });

    const map = {};
    Object.keys(stats).forEach(period => {
        const best = Object.keys(stats[period])
            .sort((a, b) => stats[period][b] - stats[period][a])[0];
        const parts = best.split('~');
        map[period] = { start: parts[0], end: parts[1] };
    });
    return map;
}

/**
 * 縱軸節次數：至少 WEEKLY_PERIOD_COUNT 行，資料有更大節次就自動延伸。
 * ⚠ 6 個班級檔實測都只有第 1~7 節（冇第 8 節），所以實際會出 7 行。
 *    刻意唔寫死 8 行：咁會多出一格永遠空白嘅橫行；而日後真係加第 8 節，
 *    呢度會自動跟隨，唔會漏課。
 */
function weeklyGlobalPeriodCount(lessons) {
    let count = WEEKLY_PERIOD_COUNT;
    lessons.forEach(cls => {
        if (cls.period > count) count = cls.period;
    });
    return count;
}

/**
 * 單一格嘅內容（科目 + 授課班級標籤）。
 * ⚠ 同一格可以有多過一堂課：實測全級資料有 18 個「同老師、同日、同節、跨多班」
 *    嘅格（例如余靜雯 週二第 1 節同時掛初二光／初二善／初二望）。
 *    所以先按科目分組 —— 同一科只寫一次科名，下面列出所有班級標籤，
 *    免得「分組英文」重複印 3 次；科目唔同就逐組顯示。
 */
function weeklyRenderTeacherCell(lessons) {
    const groups = [];
    const groupIndex = {};

    lessons.forEach(cls => {
        const subject = cls.subject || '—';
        if (groupIndex[subject] === undefined) {
            groupIndex[subject] = groups.length;
            groups.push({ subject: subject, lessons: [] });
        }
        groups[groupIndex[subject]].lessons.push(cls);
    });

    return groups.map(group => {
        const badges = group.lessons.map(cls => {
            const tip = cls.room ? cls.className + ' · ' + cls.room : cls.className;
            return `<span class="tg-cell-badge" title="${escapeHtml(tip)}">${escapeHtml(cls.className)}</span>`;
        }).join('');

        return `<div class="tg-cell">
                    <span class="wm-cell__subject">${escapeHtml(group.subject)}</span>
                    <span class="tg-cell__badges">${badges}</span>
                </div>`;
    }).join('');
}

/**
 * 渲染「老師全級總課表」：傳統一週課表網格（橫軸星期 / 縱軸節次）。
 *   橫軸：WEEKLY_DAYS ＝ 週一~週六。⚠ 唔可以只出週一~週五 ——
 *         全級資料實測有 30 堂週六課，砍掉週五之後嘅欄會直接漏課。
 *   縱軸：節次，附起訖時間。
 * 每個有課嘅格顯示「科目 + 授課班級標籤」，一眼睇出邊一節喺邊一班上課；
 * 冇課留灰底圓點，順便睇得出老師幾時得閒。
 */
function weeklyRenderTeacherGlobal(lessons) {
    // ⚠ 索引值一定要用「陣列」。唔可以好似舊 openTeacherScheduleModal 咁
    //    直接 slots[key] = cls —— 嗰樣會覆蓋掉同格嘅其他班，靜靜漏走資料。
    const cells = {};
    const classSeen = {};

    lessons.forEach(cls => {
        const key = cls.day + '|' + cls.period;
        (cells[key] = cells[key] || []).push(cls);
        classSeen[cls.className] = true;
    });

    const classCount = Object.keys(classSeen).length;
    const times = weeklyLessonsTimeMap(lessons);
    const periodCount = weeklyGlobalPeriodCount(lessons);

    let grid = '<table class="week-modal-table tg-grid"><thead><tr><th class="wm-period"></th>';
    WEEKLY_DAYS.forEach(day => { grid += `<th>週${WEEKLY_DAY_NAMES[day]}</th>`; });
    grid += '</tr></thead><tbody>';

    for (let period = 1; period <= periodCount; period++) {
        const time = times[String(period)];
        grid += `<tr><th class="wm-period">
                    <span class="wm-period__n">第${period}節</span>
                    ${time ? `<span class="wm-period__t">${time.start}</span>
                              <span class="wm-period__t">${time.end}</span>` : ''}
                 </th>`;

        WEEKLY_DAYS.forEach(day => {
            const cellLessons = cells[day + '|' + period];
            // 冇課 → 灰底圓點；有課 → 實色卡（同彈窗 A 一致）
            if (cellLessons && cellLessons.length) {
                grid += `<td class="wm-cell is-on">${weeklyRenderTeacherCell(cellLessons)}</td>`;
            } else {
                grid += '<td class="wm-cell"><span class="wm-cell__dot"></span></td>';
            }
        });

        grid += '</tr>';
    }
    grid += '</tbody></table>';

    return `
        <div class="info-modal-subtitle">全級共 ${lessons.length} 堂課 · 涵蓋 ${classCount} 個班級</div>
        <div class="week-modal-scroll">${grid}</div>
    `;
}

// ================= 彈窗 B：該科目嘅一週課堂 =================
function openSubjectScheduleModal(subjectName) {
    const name = String(subjectName == null ? '' : subjectName).trim();
    if (!name) return;

    const list = [];

    Object.keys(scheduleData).forEach(day => {
        (scheduleData[day] || []).forEach(cls => {
            if (!cls || cls.subject !== name) return;
            list.push({
                day: Number(day),
                period: cls.period,
                start: cls.start,
                end: cls.end,
                teacher: cls.teacher || ''
            });
        });
    });

    if (!list.length) return;

    list.sort((a, b) => (a.day - b.day) || (a.period - b.period));

    const items = list.map(cls => `
        <div class="info-modal-item">
            <div class="info-modal-item-day">週${WEEKLY_DAY_NAMES[cls.day]} 第${cls.period}節</div>
            <div class="info-modal-item-subject">${escapeHtml(cls.teacher || '—')}</div>
            <div class="info-modal-item-time">${cls.start} ~ ${cls.end}</div>
        </div>
    `).join('');

    openWeeklyModal(
        weeklyModalHeader('book', name + ' 課程總覽') +
        `<div class="info-modal-subtitle">本週共 ${list.length} 堂課</div>` +
        `<div class="info-modal-list">${items}</div>`
    );
}

// 舊名保留（向後兼容）
function showTeacherModal(teacherName) { openTeacherScheduleModal(teacherName); }
function showSubjectModal(subjectName) { openSubjectScheduleModal(subjectName); }

// ================= 關閉彈窗 =================
function closeInfoModal(event) {
    if (event && event.target !== event.currentTarget) return;
    const modal = document.querySelector('.info-modal-overlay');
    if (modal) modal.remove();
}
