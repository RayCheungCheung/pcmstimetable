// ============================================================
// icons.js — 全站統一 SVG 圖示系統
//
// 規範（iOS 18 / SF Symbols / Lucide 風格）：
//   · viewBox 24x24、fill: none、stroke: currentColor
//   · stroke-width: 1.8、linecap/linejoin: round
//   · 顏色跟隨父層 color（currentColor）
//
// Emoji 使用邊界（Strict Boundaries）：
//   · 系統 UI（TabBar / Header / 按鈕 / 表單 / 設定面板）→ 嚴禁 Emoji，一律 SVG。
//   · 內容層（假期列表 / 活動清單）→ 允許使用 Emoji 作節日視覺標籤，
//     透過 contentIcon() 渲染（有 Emoji 用 Emoji，否則退回線條圖示）。
//
//   HTML：<span data-icon="sun" data-icon-size="20"></span>
//   JS  ：el.innerHTML = icon('trash', { size: 16 });
//         el.innerHTML = contentIcon(h.icon, { size: 28, fallback: 'sparkles' });
// ============================================================

const APP_ICON_STROKE = 1.8;
const APP_ICON_SIZE = 18;

// 圖示本體（只有路徑，不含 <svg> 外框）
const APP_ICON_PATHS = {
    /* ---------- 主題 / 外觀 ---------- */
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',

    /* ---------- 基本操作 ---------- */
    search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.2-4.2"/>',
    close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    plus: '<path d="M12 5.5v13M5.5 12h13"/>',
    pencil: '<path d="M4 20h4L18.5 9.5a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m14 6 4 4"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6.5 7 7.5 19a2 2 0 0 0 2 1.9h5a2 2 0 0 0 2-1.9L17.5 7"/><path d="M9.5 7V5.2a2 2 0 0 1 2-2h1a2 2 0 0 1 2 2V7"/>',
    undo: '<path d="M8.5 14 3.5 9l5-5"/><path d="M3.5 9H15a5.5 5.5 0 0 1 0 11h-3.5"/>',
    refresh: '<path d="M3.5 12a8.5 8.5 0 1 0 3-6.5L3.5 8"/><path d="M3.5 3.5V8H8"/>',
    lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><path d="M12 14.4v2.4"/>',
    save: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H16l4 4v12.5A1.5 1.5 0 0 1 18.5 21h-13A1.5 1.5 0 0 1 4 19.5Z"/><path d="M8 3v5.5h7"/><path d="M8 21v-6h8v6"/>',
    download: '<path d="M12 3.5v11.5"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4.5 19.5h15"/>',
    upload: '<path d="M12 15.5V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M4.5 19.5h15"/>',
    copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15 5v-.5A1.5 1.5 0 0 0 13.5 3h-8A1.5 1.5 0 0 0 4 4.5v8A1.5 1.5 0 0 0 5.5 14H6"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 6.5"/>',
    checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.3 2.6 2.6 5-5.4"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 16.5V11"/><path d="M12 7.8h.01"/>',
    alert: '<path d="M10.3 4 2.4 17.7A2 2 0 0 0 4.1 20.7h15.8a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v4"/><path d="M12 17h.01"/>',
    bell: '<path d="M18 9.5a6 6 0 1 0-12 0c0 3.8-1.5 5.3-1.5 5.3h15S18 13.3 18 9.5Z"/><path d="M10.4 18a2 2 0 0 0 3.2 0"/>',
    star: '<path d="m12 3.6 2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.9l6-.8Z"/>',
    dot: '<circle cx="12" cy="12" r="3"/>',

    /* ---------- 箭頭 / 導航 ---------- */
    chevronLeft: '<path d="m14.5 5-7 7 7 7"/>',
    chevronRight: '<path d="m9.5 5 7 7-7 7"/>',
    grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
    layoutGrid: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
    calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="3"/><path d="M3 10h18M8 2.5v4M16 2.5v4"/>',
    calendarDots: '<rect x="3" y="4.5" width="18" height="16.5" rx="3"/><path d="M3 10h18M8 2.5v4M16 2.5v4"/><circle cx="8.4" cy="14.4" r=".9"/><circle cx="12" cy="14.4" r=".9"/><circle cx="15.6" cy="14.4" r=".9"/><circle cx="8.4" cy="18" r=".9"/><circle cx="12" cy="18" r=".9"/><circle cx="15.6" cy="18" r=".9"/>',
    timer: '<path d="M10 2h4"/><path d="M12 14v-4"/><circle cx="12" cy="14" r="8"/>',
    umbrella: '<path d="M3.4 10.6a8.6 8.6 0 0 1 17.2 0Z"/><path d="M12 10.6V18"/><path d="M12 18a2.5 2.5 0 0 0 5 0"/>',
    palmtree: '<path d="M10.9 21c.3-4.4 1.4-7.9 2.9-10.8"/><path d="M13.8 10.2C11.6 8.1 8.6 7.6 6.1 9"/><path d="M13.8 10.2C12.6 7.4 10.2 5.7 7.4 6.1"/><path d="M13.8 10.2c2.4-2 5.4-2 7.8 0"/><path d="M13.8 10.2c2-2.6 2.4-5.8 1.2-8.7"/><path d="M7.6 21h8"/>',

    /* ---------- 內容 / 資料 ---------- */
    chart: '<path d="M3 20.5h18"/><path d="M6.6 20.5v-6.2M12 20.5V5.5M17.4 20.5v-9"/>',
    book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v17.5H6.5A2.5 2.5 0 0 0 4 22Z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>',
    bookOpen: '<path d="M12 7.2v13.3"/><path d="M2.8 18.4a1 1 0 0 1-1-1V4.2a1 1 0 0 1 1-1h5.4a4 4 0 0 1 3.8 2.5 4 4 0 0 1 3.8-2.5h5.4a1 1 0 0 1 1 1v13.2a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3Z"/>',
    clipboard: '<rect x="5" y="4.5" width="14" height="17" rx="2.5"/><path d="M9 4.5v-1A1.5 1.5 0 0 1 10.5 2h3A1.5 1.5 0 0 1 15 3.5v1"/><path d="M9 11h6M9 15.5h4"/>',
    users: '<path d="M15.5 20.5v-1.6a4 4 0 0 0-4-4H6.5a4 4 0 0 0-4 4v1.6"/><circle cx="9" cy="7.2" r="3.7"/><path d="M22 20.5v-1.6a4 4 0 0 0-3-3.85"/><path d="M16 3.9a4 4 0 0 1 0 7.4"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4.6 20.6a7.4 7.4 0 0 1 14.8 0"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.4V12l3 1.8"/>',
    video: '<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="m15.5 11.5 5.5-3.2v7.4l-5.5-3.2Z"/>',
    pin: '<path d="M12 21.2s6.8-5.6 6.8-11a6.8 6.8 0 1 0-13.6 0c0 5.4 6.8 11 6.8 11Z"/><circle cx="12" cy="10" r="2.5"/>',
    alignLeft: '<path d="M4 6.5h16M4 12h11M4 17.5h16"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5Z"/>',
    school: '<path d="M12 3.6 2.6 8.3 12 13l9.4-4.7Z"/><path d="M6.2 10.6v5.2c0 1.7 2.6 3 5.8 3s5.8-1.3 5.8-3v-5.2"/>',
    target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
    palette: '<path d="M12 21a9 9 0 1 1 9-9c0 2.2-1.7 3.5-3.9 3.5h-1.5a2 2 0 0 0-1.4 3.4A1.9 1.9 0 0 1 12 21Z"/><circle cx="8" cy="10.2" r="1"/><circle cx="12" cy="7.6" r="1"/><circle cx="15.8" cy="10.2" r="1"/>',
    puzzle: '<path d="M9.6 3.4a2 2 0 1 1 4 0v1.4H17a1 1 0 0 1 1 1v3.4h1.4a2 2 0 1 1 0 4H18V16.6a1 1 0 0 1-1 1h-3.4v1.4a2 2 0 1 1-4 0V17.6H6.2a1 1 0 0 1-1-1v-3.4H3.8a2 2 0 1 1 0-4h1.4V5.8a1 1 0 0 1 1-1h3.4Z"/>',
    sliders: '<path d="M4 8h9M19 8h1M4 16h3M13 16h7"/><circle cx="16" cy="8" r="2.3"/><circle cx="10" cy="16" r="2.3"/>',
    inbox: '<path d="M4 13.2h4.2l1.4 2.8h4.8l1.4-2.8H20"/><path d="M4 13.2 6.6 4.6h10.8L20 13.2v5.6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z"/>',
    eye: '<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',

    /* ---------- 語意圖示（事件 / 假期） ---------- */
    sparkles: '<path d="M10 7.6 11.4 12l4.4 1.4-4.4 1.4L10 19.2 8.6 14.8 4.2 13.4 8.6 12Z"/><path d="M18 3v3.2M19.6 4.6h-3.2"/><path d="M5.4 18.6v2.2M6.5 19.7H4.3"/>',
    flag: '<path d="M5.2 21.2V3.4"/><path d="M5.2 4.4h13.6l-2.6 4.6 2.6 4.6H5.2"/>',
    mountain: '<path d="m2.8 18.6 6.6-11 4 6.5 2-3.2 5.8 7.7Z"/>',
    tree: '<path d="M12 3.2 7.2 10.8h9.6Z"/><path d="M12 8.4 5.6 17.6h12.8Z"/><path d="M12 17.6v3.4"/>',
    gift: '<rect x="3.4" y="9.2" width="17.2" height="11.6" rx="2"/><path d="M3.4 13.6h17.2M12 9.2v11.6"/><path d="M12 9.2C10.6 5.7 9.6 4.2 8.2 4.2a2.1 2.1 0 0 0 0 5Z"/><path d="M12 9.2c1.4-3.5 2.4-5 3.8-5a2.1 2.1 0 0 1 0 5Z"/>',
    flower: '<circle cx="12" cy="6.9" r="2.9"/><circle cx="16.4" cy="10.4" r="2.9"/><circle cx="14.7" cy="15.9" r="2.9"/><circle cx="9.3" cy="15.9" r="2.9"/><circle cx="7.6" cy="10.4" r="2.9"/><circle cx="12" cy="11.6" r="1.6"/>',
    leaf: '<path d="M4.2 20c0-8.2 5-14 15.6-15.2C19.6 15.6 14.2 20 9.4 20A5.2 5.2 0 0 1 4.2 20Z"/><path d="M9 15.2c2-2.6 4.6-4.6 8.2-6.2"/>',
    egg: '<path d="M12 3.2c3.3 0 6.1 5.1 6.1 9.2a6.1 6.1 0 0 1-12.2 0c0-4.1 2.8-9.2 6.1-9.2Z"/>'
};

// 舊版資料的 Emoji → 圖示名（向後相容：舊 localStorage / 舊 JSON 仍然渲染得正常）
const APP_ICON_LEGACY = {
    '\u{1F31E}': 'sun', '\u2600\uFE0F': 'sun', '\u2600': 'sun', '\u{1F319}': 'moon', '\u{1F31B}': 'moon', '\u{1F315}': 'moon',
    '\u{1F50D}': 'search', '\u{1F50E}': 'search', '\u274C': 'close', '\u2716': 'close', '\u2715': 'close', '\u26D4': 'close',
    '\u2795': 'plus', '\u270F\uFE0F': 'pencil', '\u270F': 'pencil', '\u{1F5D1}\uFE0F': 'trash', '\u{1F5D1}': 'trash',
    '\u21A9\uFE0E': 'undo', '\u21A9': 'undo', '\u{1F504}': 'refresh', '\u267B\uFE0F': 'refresh', '\u267B': 'refresh',
    '\u{1F512}': 'lock', '\u{1F510}': 'lock', '\u{1F4BE}': 'save', '\u{1F4E5}': 'download', '\u{1F4E4}': 'upload', '\u{1F4CB}': 'copy',
    '\u2705': 'checkCircle', '\u2611\uFE0F': 'checkCircle', '\u2713': 'check', '\u26A0\uFE0F': 'alert', '\u26A0': 'alert',
    '\u2139\uFE0F': 'info', '\u2139': 'info', '\u{1F514}': 'bell', '\u2605': 'star',
    '\u{1F4C5}': 'calendar', '\u{1F4C6}': 'calendar', '\u{1F5D3}': 'calendarDots', '\u{1F5D3}\uFE0F': 'calendarDots',
    '\u{1F552}': 'clock', '\u23F0': 'clock', '\u23F1': 'timer', '\u23F2': 'timer',
    '\u{1F4CA}': 'chart', '\u{1F4C8}': 'chart', '\u{1F4C9}': 'chart', '\u{1F4DA}': 'book', '\u{1F4D6}': 'bookOpen', '\u{1F4D5}': 'book',
    '\u{1F4DD}': 'clipboard', '\u{1F4C4}': 'clipboard', '\u{1F308}': 'sparkles', '\u{1F3AF}': 'target', '\u{1F4CC}': 'pin',
    '\u{1F4CD}': 'pin', '\u2630': 'alignLeft', '\u2261': 'alignLeft', '\u{1F3A8}': 'palette', '\u{1F9E9}': 'puzzle',
    '\u2699\uFE0F': 'sliders', '\u{1F6E0}': 'sliders', '\u{1F6E0}\uFE0F': 'sliders', '\u{1F464}': 'user', '\u{1F468}\u200D\u{1F3EB}': 'user',
    '\u{1F465}': 'users', '\u{1F3EB}': 'school', '\u{1F310}': 'globe', '\u{1F441}': 'eye', '\u{1F4F9}': 'video', '\u{1F3A5}': 'video',
    '\u{1F389}': 'sparkles', '\u{1F38A}': 'sparkles', '\u{1F386}': 'sparkles', '\u2728': 'sparkles', '\u{1F9E7}': 'gift',
    '\u{1F381}': 'gift', '\u{1F384}': 'tree', '\u{1F332}': 'tree', '\u{1F1E8}\u{1F1F3}': 'flag', '\u{1F1F2}\u{1F1F4}': 'flag', '\u{1F6A9}': 'flag',
    '\u{1F3D4}\uFE0F': 'mountain', '\u{1F3D4}': 'mountain', '\u26F0\uFE0F': 'mountain', '\u{1F338}': 'flower', '\u{1F33F}': 'leaf',
    '\u{1F340}': 'leaf', '\u{1F430}': 'egg', '\u{1F95A}': 'egg', '\u{1F3D6}': 'umbrella', '\u{1F3D6}\uFE0F': 'umbrella', '\u26F1\uFE0F': 'umbrella',
    '\u{1F622}': 'inbox', '\u{1F4ED}': 'inbox', '\u2753': 'info'
};

// 由舊 Emoji（或已是圖示名）解析出圖示名
function iconName(value, fallback) {
    const raw = String(value === undefined || value === null ? '' : value).trim();
    if (APP_ICON_PATHS[raw]) return raw;
    if (APP_ICON_LEGACY[raw]) return APP_ICON_LEGACY[raw];
    return APP_ICON_PATHS[fallback] ? fallback : 'dot';
}

// 產生 <svg> 字串（name 可以是圖示名或舊 Emoji）
function icon(name, options) {
    const opts = options || {};
    const size = Number(opts.size) || APP_ICON_SIZE;
    const stroke = opts.strokeWidth || APP_ICON_STROKE;
    const key = iconName(name, opts.fallback);
    const extra = opts.className ? ' ' + opts.className : '';
    return '<svg class="app-icon' + extra + '" viewBox="0 0 24 24" width="' + size + '" height="' + size + '"' +
        ' fill="none" stroke="currentColor" stroke-width="' + stroke + '"' +
        ' stroke-linecap="round" stroke-linejoin="round"' +
        ' aria-hidden="true" focusable="false">' + APP_ICON_PATHS[key] + '</svg>';
}

// 面板下拉選單用：所有可選圖示名
const APP_ICON_NAMES = Object.keys(APP_ICON_PATHS);

// ============================================================
// 內容層 Emoji（僅限假期列表 / 活動清單等內容，系統 UI 嚴禁使用）
// ============================================================

// 是否包含 Emoji（含國旗、變體選擇符、Keycap、ZWJ 組合、時間符號）
const APP_EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{FE0F}\u{200D}\u{20E3}]/u;

function isEmojiValue(value) {
    return typeof value === 'string' && APP_EMOJI_RE.test(value);
}

// 極簡轉義（icons.js 先於 db.js 載入，故不依賴 escapeHtml）
function escapeIconText(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 內容層徽章：值係 Emoji → 直接渲染 Emoji（節日氛圍）；否則退回 SVG 線條圖示
function contentIcon(value, options) {
    const opts = options || {};
    if (isEmojiValue(value)) {
        const size = Number(opts.size) || 24;
        const extra = opts.className ? ' ' + opts.className : '';
        return '<span class="emoji-badge' + extra + '" role="img" aria-hidden="true"' +
            ' style="font-size:' + size + 'px">' + escapeIconText(String(value).trim()) + '</span>';
    }
    return icon(value, opts);
}

// 內容層欄位正規化：Emoji 原樣保留，其餘一律轉成合法圖示名
function resolveContentIcon(value, fallbackIcon) {
    if (isEmojiValue(value)) return String(value).trim().slice(0, 12);
    return iconName(value, fallbackIcon);
}

// 把 <span data-icon="..."> 轉成真正的 SVG（支援動態插入的節點）
function hydrateIcons(root) {
    const scope = root || document;
    const nodes = scope.querySelectorAll('[data-icon]');
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const name = node.getAttribute('data-icon');
        if (node.getAttribute('data-icon-done') === name) continue;
        const size = node.getAttribute('data-icon-size');
        node.innerHTML = icon(name, size ? { size: size } : null);
        node.removeAttribute('data-icon-size');
        node.setAttribute('data-icon-done', name);
    }
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => hydrateIcons());
    } else {
        hydrateIcons();
    }
}
