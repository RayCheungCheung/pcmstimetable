// ================= 功能 6：課表卡片點擊展開 =================
function initCardExpand() {
    document.addEventListener('click', (e) => {
        const card = e.target.closest('.class-card');
        if (!card) return;

        // 如果點擊嘅係展開內容，唔好收埋
        if (e.target.closest('.expand-content')) return;

        // 切換展開狀態
        card.classList.toggle('expanded');

        if (card.classList.contains('expanded')) {
            const subject = card.querySelector('.subject').textContent;
            const teacher = card.querySelector('.teacher')?.textContent || '';
            const time = card.querySelector('.time').textContent;

            let expandContent = card.querySelector('.expand-content');
            if (!expandContent) {
                expandContent = document.createElement('div');
                expandContent.className = 'expand-content';
                expandContent.innerHTML = `
                    <div class="expand-row">
                        <span class="expand-label">科目</span>
                        <span class="expand-value">${subject}</span>
                    </div>
                    <div class="expand-row">
                        <span class="expand-label">老師</span>
                        <span class="expand-value">${teacher || '—'}</span>
                    </div>
                    <div class="expand-row">
                        <span class="expand-label">時間</span>
                        <span class="expand-value">${time}</span>
                    </div>
                    <div class="expand-row">
                        <span class="expand-label">備註</span>
                        <span class="expand-value">無</span>
                    </div>
                `;
                card.querySelector('.info').appendChild(expandContent);
            }
        } else {
            // 收起時移除展開內容
            const expandContent = card.querySelector('.expand-content');
            if (expandContent) expandContent.remove();
        }
    });
}