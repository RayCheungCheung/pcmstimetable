// ================= 功能：深色/淺色模式 =================
function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = savedTheme || (systemPrefersDark ? 'dark' : 'light');
    applyTheme(theme);

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (!localStorage.getItem('theme')) {
            applyTheme(e.matches ? 'dark' : 'light');
        }
    });
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const toggleBtn = document.getElementById('theme-toggle');
    if (toggleBtn) {
        const iconHost = toggleBtn.querySelector('.theme-icon') || toggleBtn;
        // 深色模式 → 極簡線條太陽；淺色模式 → 極簡線條彎月（SF Symbols 風格）
        iconHost.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon', { size: 20 });
    }
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

    const toggleBtn = document.getElementById('theme-toggle');

    // 加入切換動畫
    if (toggleBtn) {
        toggleBtn.classList.add('switching');
        setTimeout(() => {
            applyTheme(newTheme);
            toggleBtn.classList.remove('switching');
        }, 200);
    } else {
        applyTheme(newTheme);
    }

    localStorage.setItem('theme', newTheme);
}