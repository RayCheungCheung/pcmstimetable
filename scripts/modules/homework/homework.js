// ================= 功能 9：測驗 / 作業倒數 =================
let homeworkData = [];

async function initHomework() {
    try {
        const response = await fetch(appUrl('data/homework.json'));
        const data = await response.json();
        homeworkData = data.homework || [];

        renderHomework();
        checkHomeworkReminders();
        setInterval(checkHomeworkReminders, 60 * 60 * 1000);
    } catch (error) {
        console.error('載入測驗 / 作業失敗:', error);
        homeworkData = [];
        renderHomework();
    }
}

function renderHomework() {
    const container = document.getElementById('homework-container');
    if (!container) return;

    if (homeworkData.length === 0) {
        container.innerHTML = `<div class="hw-empty">暫時沒有測驗或作業</div>`;
        return;
    }

    const now = new Date();
    now.setHours(0, 0, 0, 0);

    // 按截止日期排序
    const sorted = [...homeworkData].sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

    let html = '';
    sorted.forEach(hw => {
        const dueDate = new Date(hw.dueDate);
        dueDate.setHours(0, 0, 0, 0);
        const diffDays = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));

        let cardClass = '';
        let countdownClass = 'safe';
        let countdownText = `${diffDays}`;
        let countdownLabel = '天';

        if (diffDays < 0) {
            cardClass = '';
            countdownClass = 'passed';
            countdownText = '已過';
            countdownLabel = '';
        } else if (diffDays === 0) {
            cardClass = 'urgent';
            countdownClass = 'urgent';
            countdownText = icon('clock', { size: 20 });
            countdownLabel = '今天';
        } else if (diffDays === 1) {
            cardClass = 'urgent';
            countdownClass = 'urgent';
            countdownText = '1';
            countdownLabel = '明天';
        } else if (diffDays <= 3) {
            cardClass = 'urgent';
            countdownClass = 'urgent';
        } else if (diffDays <= 7) {
            cardClass = 'soon';
            countdownClass = 'soon';
        }

        html += `
            <div class="hw-card ${cardClass}">
                <div class="hw-subject-badge">${hw.subject}</div>
                <div class="hw-info">
                    <div class="hw-title">${hw.title}</div>
                    <div class="hw-meta">${hw.group} · 截止：${hw.dueDate}</div>
                    ${hw.submit ? `<div class="hw-submit-tag">須繳交</div>` : ''}
                </div>
                <div class="hw-countdown ${countdownClass}">
                    <div class="hw-countdown-number">${countdownText}</div>
                    <div class="hw-countdown-label">${countdownLabel}</div>
                </div>
            </div>
        `;
    });
    container.innerHTML = html;
}

// ================= 提醒 =================
function checkHomeworkReminders() {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const reminded = JSON.parse(localStorage.getItem('homeworkReminded') || '{}');
    let updated = false;

    homeworkData.forEach(hw => {
        const dueDate = new Date(hw.dueDate);
        dueDate.setHours(0, 0, 0, 0);
        const diffDays = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));

        const key = `${hw.subject}-${hw.title}`;
        if (!reminded[key]) reminded[key] = {};

        if (diffDays === 3 && !reminded[key].day3) {
            sendNotification('測驗 / 作業提醒', `${hw.title} 將於 3 天後截止！`);
            reminded[key].day3 = true;
            updated = true;
        }
        if (diffDays === 1 && !reminded[key].day1) {
            sendNotification('測驗 / 作業提醒', `${hw.title} 將於明天截止！`);
            reminded[key].day1 = true;
            updated = true;
        }
        if (diffDays === 0 && !reminded[key].day0) {
            sendNotification('測驗 / 作業提醒', `${hw.title} 就是今天截止！`);
            reminded[key].day0 = true;
            updated = true;
        }
    });

    if (updated) localStorage.setItem('homeworkReminded', JSON.stringify(reminded));
}

function sendNotification(title, body) {
    if (Notification.permission === 'granted') {
        new Notification(title, { body: body });
    }
}

function requestNotificationPermission() {
    if (!('Notification' in window)) {
        alert('你的瀏覽器不支援通知功能');
        return;
    }
    Notification.requestPermission().then(permission => {
        if (permission === 'granted') {
            alert('已開啟通知提醒！');
        } else {
            alert('你拒絕了通知權限，將無法收到提醒');
        }
    });
}