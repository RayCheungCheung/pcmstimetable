// ================= 功能 8：日曆系統（唯讀） =================
// 事件一律由 DB 集合 'events'（data/events.json）提供，使用者「唔可以自行新增」。
// 為此已經移除所有新增入口：
//   · 點擊日期格子只會檢視該日事件（原本會即時彈出新增視窗）
//   · 新增事件彈窗 #add-calendar-event-modal 及 saveCalendarEvent() 已整組刪除
// 要新增／修改事件，請改 data/events.json，或者由
// 「個人中心」頁尾嘅版本號連點 5 下，通過密碼驗證後，
// 喺開發者後台嘅「月曆與事件」分頁操作（後台 CRUD 不受影響）。
//   ⚠ 開發者模式「只可以有一個入口」，就係呢個連點（見 devtools.js 開頭
//     嘅入口搬遷史）。歷史上嘅「關於我們 → 開發者簡介 → 開發者模式」
//     已隨該子頁面按需求一併刪除，唔好照舊寫法搵返條路。
//
// ⚠ 刪除權限（漏洞修復，見下方 calendarCanDeleteEvent）：
//   · 官方假期（type === 'holiday'）屬出廠資料，對一般使用者完全唯讀：
//     事件清單唔渲染刪除鈕，deleteCalendarEvent() 亦會攔截。
//     只有通過密碼驗證、真正解鎖開發者模式之後，才顯示刪除鈕並放行。
//   · 其他類別（測驗／作業／活動／個人日程）維持原本行為，可自行清走。
let calendarCurrentDate = new Date();
let calendarEvents = [];
let calendarSelectedDate = null;

// 事件資料統一由 DataManager（DB 集合 'events'）管理：
// localStorage（calendar_events）優先 → data/events.json → 空陣列
const CALENDAR_DB_NAME = 'events';

// ================= 權限判斷（官方假期唯讀） =================

/**
 * 呢筆事件係唔係「官方假期」？
 *   · type === 'holiday'：現行 data/events.json 同開發者後台「假期」類別嘅判準
 *   · isHoliday === true：預留旗標，防止日後資料改咗欄位名而漏判
 */
function calendarIsOfficialHoliday(e) {
    if (!e) return false;
    return e.type === 'holiday' || e.isHoliday === true;
}

/**
 * 呢筆事件可唔可以刪？
 *   · 官方假期 → 一律唔可以刪（官方公佈資料，任何情況下唯讀）
 *   · 其他類別 → 使用者可自行刪除
 *
 * ⚠ v3.16.0：原本官方假期可以喺「已解鎖開發者模式」之下刪除，
 *    隨着開發者模式被徹底移除，呢條例外路徑已經封死。
 */
function calendarCanDeleteEvent(e) {
    return !calendarIsOfficialHoliday(e);
}

// ================= 初始化 =================
async function initCalendar() {
    await loadCalendarEvents();

    // 開發者面板改動事件後 → 即時重繪（Hot Reload）
    if (typeof DB !== 'undefined') {
        DB.subscribe(CALENDAR_DB_NAME, () => {
            calendarEvents = DB.get(CALENDAR_DB_NAME) || [];
            renderCalendar();
        });
    }

    renderCalendar();
}

async function loadCalendarEvents() {
    try {
        await DB.load(CALENDAR_DB_NAME);
        calendarEvents = DB.get(CALENDAR_DB_NAME) || [];
    } catch (e) {
        console.warn('載入事件資料失敗:', e);
        calendarEvents = [];
    }
    return calendarEvents;
}

function saveEventsToStorage() {
    DB.set(CALENDAR_DB_NAME, calendarEvents);
}

// ================= 月份切換 =================
function changeCalendarMonth(offset) {
    calendarCurrentDate.setMonth(calendarCurrentDate.getMonth() + offset);
    renderCalendar();
}

function goToCalendarToday() {
    calendarCurrentDate = new Date();
    renderCalendar();
}

// ================= 渲染月曆 =================
function renderCalendar() {
    const year = calendarCurrentDate.getFullYear();
    const month = calendarCurrentDate.getMonth();

    const titleEl = document.getElementById('calendar-title');
    if (titleEl) titleEl.textContent = `${year}年${month + 1}月`;

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();

    const today = new Date();
    const todayStr = fmtDate(today);

    let html = '';

    for (let i = firstDay - 1; i >= 0; i--) {
        html += `<div class="cal-cell other-month"><div class="cal-num">${prevMonthDays - i}</div></div>`;
    }

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dayEvents = calendarEvents.filter(e => e.date === dateStr);
        const isToday = dateStr === todayStr;
        const hasEvents = dayEvents.length > 0;

        let eventsHtml = '';
        dayEvents.slice(0, 2).forEach(e => {
            // 開發者自訂顏色（e.color）優先，否則用類別預設色
            const colorStyle = dbIsHexColor(e.color) ? ` style="background-color:${e.color}"` : '';
            eventsHtml += `<div class="cal-event ${e.type}"${colorStyle}>${contentIcon(e.emoji || e.icon, { size: 13, fallback: dbEventIcon(e.type) })}${escapeHtml(e.title)}</div>`;
        });
        if (dayEvents.length > 2) {
            eventsHtml += `<div class="cal-event more">+${dayEvents.length - 2}</div>`;
        }

        html += `
            <div class="cal-cell ${isToday ? 'today' : ''} ${hasEvents ? 'has-events' : ''}" 
                 onclick="onCalendarDateClick('${dateStr}')">
                <div class="cal-num">${day}</div>
                ${hasEvents ? '<div class="cal-dot"></div>' : ''}
                <div class="cal-events">${eventsHtml}</div>
            </div>
        `;
    }

    const totalCells = firstDay + daysInMonth;
    const remaining = (7 - (totalCells % 7)) % 7;
    for (let i = 1; i <= remaining; i++) {
        html += `<div class="cal-cell other-month"><div class="cal-num">${i}</div></div>`;
    }

    const gridEl = document.getElementById('calendar-grid');
    if (gridEl) gridEl.innerHTML = html;

    selectCalendarDate(todayStr);
}

// ================= 點擊日期格子（只檢視當日事件） =================
function onCalendarDateClick(dateStr) {
    calendarSelectedDate = dateStr;
    selectCalendarDate(dateStr);
}

// ================= 選擇日期 =================
function selectCalendarDate(dateStr) {
    calendarSelectedDate = dateStr;
    const dayEvents = calendarEvents.filter(e => e.date === dateStr);
    const titleEl = document.getElementById('calendar-events-title');
    const listEl = document.getElementById('calendar-events-list');

    if (!titleEl || !listEl) return;

    const [y, m, d] = dateStr.split('-');
    titleEl.textContent = `${y}年${parseInt(m)}月${parseInt(d)}日 的事件`;

    if (dayEvents.length === 0) {
        listEl.innerHTML = `<div class="cal-event-empty">這天沒有事件</div>`;
        return;
    }

    listEl.innerHTML = dayEvents.map(e => {
        const colorStyle = dbIsHexColor(e.color)
            ? ` style="box-shadow: inset 3px 0 0 0 ${e.color}"`
            : '';
        const noteHtml = e.note ? `<div class="cal-event-note">${escapeHtml(e.note)}</div>` : '';
        return `
        <div class="cal-event-item ${e.type}"${colorStyle}>
            <div class="cal-event-emoji">${contentIcon(e.emoji || e.icon, { size: 19, fallback: dbEventIcon(e.type) })}</div>
            <div class="cal-event-info">
                <div class="cal-event-title">${escapeHtml(e.title)}</div>
                <div class="cal-event-type">${getCalTypeName(e.type)}</div>
                ${noteHtml}
            </div>
            ${calendarDeleteButtonHtml(e)}
        </div>
    `;
    }).join('');
}

// ================= 輔助 =================
// 事件圖示一律直接用 dbEventIcon()（scripts/utils/icons.js 產生 SVG）；
// 舊有嘅 getCalEventIcon() 只服務已刪除嘅新增事件流程，已一併移除。
function getCalTypeName(type) {
    const names = { exam: '測驗 / 考試', homework: '作業截止', activity: '活動', holiday: '假期' };
    return names[type] || '事件';
}

function fmtDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 產生事件嘅刪除鈕 HTML；唔准刪就回傳空字串。
 *
 * ⚠ 關鍵係「完全唔渲染」，唔係用 CSS display:none 藏起 ——
 *   藏起嘅按鈕仍然留在 DOM 裡面，開 DevTools 一樣撳得到。
 */
function calendarDeleteButtonHtml(e) {
    if (!calendarCanDeleteEvent(e)) return '';
    return `<button class="cal-event-delete" onclick="deleteCalendarEvent('${e.id}')" aria-label="刪除事件">${icon('close', { size: 14 })}</button>`;
}

/**
 * 顯示提示。重用 app 層嘅 #profile-toast：佢係 position:fixed，
 * 而且刻意放喺所有 overlay 之外（見 profile.css「7. Toast」），
 * 本來就係全站通用嘅提示條，唔需要為日曆再整多一個。
 */
function calendarToast(message) {
    if (typeof profileToast === 'function') {
        profileToast(message);
        return;
    }
    // 後備：profile.js 未載入時，至少保證用戶收得到訊息，唔會靜靜地失敗
    window.alert(message);
}

// ================= 唯讀：原本嘅新增事件流程已經移除 =================
// 呢個位原本有：openAddCalendarEventModal() / closeAddCalendarEventModal() /
// selectEventType() / updateDateDisplay() / 日期輸入監聽 / saveCalendarEvent()。
// 使用者唔可以自己新增事件，所以全部刪除；事件資料只需要 DB 讀取 + renderCalendar()。

// ================= 刪除事件 =================
function deleteCalendarEvent(eventId) {
    // ⚠ 第二道防線，亦係真正嘅防線：
    //    唔渲染刪除鈕只係「唔好引誘誤觸」；呢個函式係 global scope，
    //    任何人喺 console 打 deleteCalendarEvent('<id>') 一樣叫得到。
    //    所以權限斷言必須放喺呢度，唔可以只靠 UI 隱藏。
    if (!calendarCanDeleteEvent(calendarEvents.find(e => e.id === eventId))) {
        calendarToast('官方假期無法刪除');
        return;
    }

    if (!confirm('確定要刪除這個事件嗎？')) return;

    const originalLength = calendarEvents.length;
    calendarEvents = calendarEvents.filter(e => e.id !== eventId);

    if (calendarEvents.length === originalLength) return;

    saveEventsToStorage();
    renderCalendar();
    if (calendarSelectedDate) {
        selectCalendarDate(calendarSelectedDate);
    }
}