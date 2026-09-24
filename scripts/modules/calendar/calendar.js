// ================= 功能 8：日曆系統 =================
let calendarCurrentDate = new Date();
let calendarEvents = [];
let calendarSelectedDate = null;
let selectedEventType = 'exam';

// 事件資料統一由 DataManager（DB 集合 'events'）管理：
// localStorage（calendar_events）優先 → data/events.json → 空陣列
const CALENDAR_DB_NAME = 'events';

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

// ================= 點擊日期格子（直接彈出新增事件） =================
function onCalendarDateClick(dateStr) {
    calendarSelectedDate = dateStr;
    selectCalendarDate(dateStr);
    openAddCalendarEventModal(dateStr);
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
            <button class="cal-event-delete" onclick="deleteCalendarEvent('${e.id}')" aria-label="刪除事件">${icon('close', { size: 14 })}</button>
        </div>
    `;
    }).join('');
}

// ================= 輔助 =================
// 事件類別的預設圖示名（實際 SVG 由 scripts/utils/icons.js 產生）
function getCalEventIcon(type) {
    return dbEventIcon(type);
}

function getCalTypeName(type) {
    const names = { exam: '測驗 / 考試', homework: '作業截止', activity: '活動', holiday: '假期' };
    return names[type] || '事件';
}

function fmtDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ================= 彈窗控制 =================
function openAddCalendarEventModal(dateStr) {
    const modal = document.getElementById('add-calendar-event-modal');
    if (!modal) return;

    const dateInput = document.getElementById('calendar-event-date');
    if (dateInput) {
        dateInput.value = dateStr || fmtDate(new Date());
    }

    updateDateDisplay(dateInput.value);

    const titleInput = document.getElementById('calendar-event-title');
    if (titleInput) titleInput.value = '';

    selectedEventType = 'exam';
    document.querySelectorAll('.gcal-pill').forEach(pill => {
        pill.classList.toggle('active', pill.dataset.type === 'exam');
    });

    modal.style.display = 'flex';
    modal.classList.add('active');
}

function closeAddCalendarEventModal(event) {
    if (event && event.target !== event.currentTarget) return;
    const modal = document.getElementById('add-calendar-event-modal');
    if (!modal) return;
    modal.style.display = 'none';
    modal.classList.remove('active');
}

function selectEventType(type) {
    selectedEventType = type;
    const hiddenInput = document.getElementById('calendar-event-type');
    if (hiddenInput) hiddenInput.value = type;
    document.querySelectorAll('.gcal-pill').forEach(pill => {
        pill.classList.toggle('active', pill.dataset.type === type);
    });
}

function updateDateDisplay(dateStr) {
    const display = document.getElementById('gcal-date-display');
    if (!display || !dateStr) return;
    const d = new Date(dateStr);
    const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const months = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    display.textContent = `${months[d.getMonth()]}${d.getDate()}日 ${days[d.getDay()]}`;
}

document.addEventListener('DOMContentLoaded', () => {
    const dateInput = document.getElementById('calendar-event-date');
    if (dateInput) {
        dateInput.addEventListener('change', (e) => {
            updateDateDisplay(e.target.value);
        });
    }
});

// ================= 儲存事件 =================
function saveCalendarEvent() {
    const date = document.getElementById('calendar-event-date').value;
    const title = document.getElementById('calendar-event-title').value.trim();
    const type = selectedEventType;

    if (!date || !title) {
        alert('請填寫標題與日期！');
        return;
    }

    const newEvent = {
        id: `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        date: date,
        title: title,
        type: type,
        icon: getCalEventIcon(type)
    };

    calendarEvents.push(newEvent);
    saveEventsToStorage();
    closeAddCalendarEventModal();
    renderCalendar();
    selectCalendarDate(date);
}

// ================= 刪除事件 =================
function deleteCalendarEvent(eventId) {
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