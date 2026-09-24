// ================= 共用常數 =================
const WEEKLY_DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
const WEEKLY_DAYS = [1, 2, 3, 4, 5, 6];      // 只顯示週一 ~ 週六
const WEEKLY_PERIOD_COUNT = 7;

// 老師欄位可能載多位老師，資料以「‧」分隔（例如「徐梓駿‧蕭沛強」）
const WEEKLY_TEACHER_SEPARATORS = /[‧·・、,，\/]/;

// 把「徐梓駿‧蕭沛強」拆成 ['徐梓駿', '蕭沛強']
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
                        ).join('<span class="teacher-sep">‧</span>')}</div>` : ''}
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
            openTeacherScheduleModal(teacherEl.dataset.teacher);
        }
    });
}

// ================= 彈窗共用外殼 =================
function openWeeklyModal(innerHtml) {
    closeInfoModal();      // 先清走舊彈窗，避免疊住兩層

    const overlay = document.createElement('div');
    overlay.className = 'info-modal-overlay';
    overlay.setAttribute('onclick', 'closeInfoModal(event)');

    const content = document.createElement('div');
    content.className = 'info-modal-content';
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
