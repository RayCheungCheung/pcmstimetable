// ================= 功能：深色/淺色模式 =================
// 使用者偏好（localStorage 'theme'）有三個可能值：
//   'light' | 'dark'  → 用戶明確鎖定，唔受系統影響
//   'auto'            → 跟隨系統顯示設定
//   （完全未設定）     → 等同 'auto'
//
// ⚠ applyTheme() 只會寫出已解析嘅 'light' / 'dark'，永遠唔會寫出
//   data-theme="auto"。一旦寫成 "auto"，:root[data-theme="light"] 嗰批
//   淺色覆寫規則會全部配對唔到，淺色主題就會壞掉。

/** 讀取使用者偏好（未設定過一律視為 'auto'） */
function themePreference() {
    const saved = localStorage.getItem('theme');
    return (saved === 'light' || saved === 'dark' || saved === 'auto') ? saved : 'auto';
}

/** 系統目前是否偏好深色 */
function themeSystemPrefersDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

/** 把偏好解析成真正要套用嘅主題（只有 'light' 或 'dark'） */
function themeResolve(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return themeSystemPrefersDark() ? 'dark' : 'light';
}

function initTheme() {
    applyTheme(themeResolve(themePreference()));

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        // 只有「跟隨系統」先應該被系統帶動；
        // 用戶已明確揀咗深／淺色就唔可以被系統蓋過。
        if (themePreference() === 'auto') {
            applyTheme(e.matches ? 'dark' : 'light');
        }
    });
}

/**
 * 設定主題偏好並即時套用。
 * 個人中心「外觀與主題」抽屜嘅唯一入口 —— 唔喺 profile.js 直接寫
 * localStorage，避免同本檔嘅解析邏輯各寫一次而走音。
 */
function setThemePreference(pref) {
    const value = (pref === 'light' || pref === 'dark' || pref === 'auto') ? pref : 'auto';
    localStorage.setItem('theme', value);
    applyTheme(themeResolve(value));
    return value;
}

function applyTheme(theme) {
    const resolved = themeResolve(theme);
    document.documentElement.setAttribute('data-theme', resolved);
    const toggleBtn = document.getElementById('theme-toggle');
    if (toggleBtn) {
        const iconHost = toggleBtn.querySelector('.theme-icon') || toggleBtn;
        // 深色模式 → 極簡線條太陽；淺色模式 → 極簡線條彎月（SF Symbols 風格）
        iconHost.innerHTML = icon(resolved === 'dark' ? 'sun' : 'moon', { size: 20 });
    }
}

function toggleTheme() {
    // 由「現時實際顯示緊」嘅主題反向切換，並把偏好固定成明確值
    // （即係由跟隨系統變成鎖定），符合用戶撳呢粒掣嘅預期。
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
