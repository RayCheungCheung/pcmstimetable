// 假期資料統一由 DataManager（DB 集合 'holidays'）管理：
// localStorage（appdb_v1_holidays）優先 → data/holidays.json → 空陣列
const HOLIDAYS_DB_NAME = 'holidays';

async function renderHolidays() {
    const container = document.getElementById('holidays-container');
    if (!container) return;

    try {
        await DB.load(HOLIDAYS_DB_NAME);
        const holidays = DB.get(HOLIDAYS_DB_NAME) || [];

        const now = new Date();
        now.setHours(0, 0, 0, 0);

        const upcoming = holidays
            .map(h => {
                const holidayDate = new Date(h.date);
                holidayDate.setHours(0, 0, 0, 0);
                const diffDays = Math.ceil((holidayDate - now) / (1000 * 60 * 60 * 24));
                return { ...h, daysLeft: diffDays };
            })
            .filter(h => h.daysLeft >= 0)
            .sort((a, b) => a.daysLeft - b.daysLeft);
        
        if (upcoming.length === 0) {
            container.innerHTML = '<div class="holiday-empty">暫時沒有即將到來的假期</div>';
            return;
        }
        
        container.innerHTML = upcoming.map((h, index) => {
            const isNext = index === 0;
            const isToday = h.daysLeft === 0;
            const isTomorrow = h.daysLeft === 1;
            
            return `
                <div class="holiday-card ${isNext ? 'next-holiday' : ''}">
                    <div class="holiday-emoji">${contentIcon(h.emoji || h.icon, { size: 28, fallback: 'sparkles' })}</div>
                    <div class="holiday-info">
                        <div class="holiday-name">${escapeHtml(h.name)}</div>
                        <div class="holiday-date">${h.date}${h.endDate && h.endDate !== h.date ? ' ~ ' + h.endDate : ''}</div>
                        ${h.note ? `<div class="holiday-note">${escapeHtml(h.note)}</div>` : ''}
                    </div>
                    <div class="holiday-countdown">
                        <div class="countdown-number">${isToday ? contentIcon(h.emoji, { size: 26, fallback: 'sparkles' }) : h.daysLeft}</div>
                        <div class="countdown-label">${isToday ? '今天' : isTomorrow ? '明天' : '天'}</div>
                    </div>
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('載入假期失敗:', error);
        container.innerHTML = '<div class="holiday-empty">載入假期資料失敗</div>';
    }
}

// 開發者面板改動假期後 → 即時重繪（Hot Reload）
DB.subscribe(HOLIDAYS_DB_NAME, () => {
    renderHolidays();
});