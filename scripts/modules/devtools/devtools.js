// ============================================================
// Developer / Admin Dashboard（開發者數據管理中心）
//
// 入口：
//   · 連續點擊「版本號」或標題「我的課表」5 下
//   · 長按版本號 0.8 秒
//   · 鍵盤 Ctrl + Shift + D
//
// 功能：
//   · Tab 分頁管理 4 個資料庫（事件 / 班級課表 / 假期 / 用戶與班級）
//   · 表格化 CRUD（新增、編輯、刪除）
//   · Raw JSON 編輯器（單鍵解析並套用）
//   · 匯出 / 匯入 / 重置為預設值
//   · 保存並套用 → 即時寫入 localStorage 並重繪 App（Hot Reload）
// ============================================================

const DEV_MODE_KEY = 'dev_mode_enabled';
const DEV_TAP_COUNT = 5;
const DEV_TAP_WINDOW = 1400;   // ms：幾秒內連點才算
const DEV_LONG_PRESS = 800;    // ms

// 分頁：label 為純文字、icon 對應 scripts/utils/icons.js 的圖示名（全站禁用 Emoji）
const DEV_TABS = [
    { id: 'events',    label: '月曆與事件', icon: 'calendar' },
    { id: 'schedules', label: '各班級課表', icon: 'book' },
    { id: 'holidays',  label: '假期與倒數', icon: 'sparkles' },
    { id: 'users',     label: '用戶與班級', icon: 'users' },
    { id: 'raw',       label: 'Raw JSON',  icon: 'puzzle' }
];

let devEnabled = false;
let devOpened = false;
let devTab = 'events';
let devDrafts = {};          // 集合名 → 未儲存草稿
let devDirty = {};           // 集合名 → true
let devScheduleClass = '';   // 課表分頁：目前檢視緊嘅班級 id
let devSelectedCell = null;  // 課表分頁：{ day, period }
let devRawTarget = '__all__';
let devToastTimer = null;

// ================= 小工具 =================

function devEl(id) {
    return document.getElementById(id);
}

function devToast(message) {
    const node = devEl('dev-toast');
    if (!node) return;
    node.textContent = message;
    node.classList.add('is-show');
    clearTimeout(devToastTimer);
    devToastTimer = setTimeout(() => node.classList.remove('is-show'), 1900);
}

function devStatus(message, kind) {
    const node = devEl('dev-status');
    if (!node) return;
    node.textContent = message || '';
    node.className = 'dev-status' + (kind ? ' is-' + kind : '');
}

function devDownload(filename, text) {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ================= 開發者模式開關 =================

function devIsEnabled() {
    return devEnabled;
}

async function devEnable(openNow) {
    devEnabled = true;
    Storage.set(DEV_MODE_KEY, true);
    devSyncFab();
    devToast('開發者模式已開啟');
    if (openNow !== false) await devOpen();
}

function devDisable() {
    devEnabled = false;
    Storage.set(DEV_MODE_KEY, false);
    devSyncFab();
    devClose();
    devToast('開發者模式已關閉');
}

function devSyncFab() {
    const fab = devEl('dev-fab');
    if (fab) fab.classList.toggle('is-visible', devEnabled);
}

async function devToggle() {
    if (devOpened) { devClose(); return; }
    if (!devEnabled) { await devEnable(true); return; }
    await devOpen();
}

// ================= 入口觸發 =================

function devBindTaps(element, onTrigger) {
    if (!element) return;
    let count = 0;
    let timer = null;
    let pressTimer = null;

    element.addEventListener('click', () => {
        count++;
        clearTimeout(timer);
        timer = setTimeout(() => { count = 0; }, DEV_TAP_WINDOW);

        if (count >= DEV_TAP_COUNT) {
            count = 0;
            clearTimeout(timer);
            onTrigger();
        } else if (count >= 2) {
            devToast('再點 ' + (DEV_TAP_COUNT - count) + ' 下進入開發者模式');
        }
    });

    const cancel = () => { clearTimeout(pressTimer); pressTimer = null; };
    element.addEventListener('pointerdown', () => {
        cancel();
        pressTimer = setTimeout(() => { pressTimer = null; onTrigger(); }, DEV_LONG_PRESS);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => element.addEventListener(ev, cancel));
}

function initDevTools() {
    devEnabled = Storage.get(DEV_MODE_KEY, false) === true;
    devSyncFab();

    const version = devEl('app-version');
    if (version) version.textContent = 'v' + APP_VERSION;

    const trigger = () => { devEnable(true); };
    devBindTaps(version, trigger);
    devBindTaps(devEl('header-title'), trigger);

    document.addEventListener('keydown', e => {
        if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
            e.preventDefault();
            devToggle();
        }
        if (e.key === 'Escape' && devOpened) devClose();
    });

    const fab = devEl('dev-fab');
    if (fab) fab.addEventListener('click', () => devOpen());

    const overlay = devEl('dev-overlay');
    if (overlay) overlay.addEventListener('click', e => { if (e.target === overlay) devClose(); });

    const fileInput = devEl('dev-import-file');
    if (fileInput) fileInput.addEventListener('change', devHandleImportFile);

    const body = devEl('dev-body');
    if (body) {
        body.addEventListener('input', devHandleInput);
        body.addEventListener('change', devHandleChange);
        body.addEventListener('click', devHandleClick);
    }

    console.log('%c開發者模式已就緒：Ctrl + Shift + D', 'color:#6a5cff;font-weight:bold');
}

// ================= 開 / 關面板 =================

async function devOpen() {
    const overlay = devEl('dev-overlay');
    if (!overlay) return;

    if (typeof authLoadClasses === 'function') {
        try { await authLoadClasses(); } catch (e) { /* auth.js 有內建備援清單 */ }
    }
    dbRegisterAllSchedules();

    devDrafts = {};
    devDirty = {};
    devSelectedCell = null;
    if (!devScheduleClass) {
        const schedules = DB.list('schedules');
        devScheduleClass = schedules.length ? (schedules[0].classId || 'default') : 'default';
    }

    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    devOpened = true;

    devRenderTabs();
    devRenderBody();
    devStatus('已載入 ' + DB.list('db').length + ' 個資料集合 · 改完記得按「保存並套用」');
}

function devClose() {
    const overlay = devEl('dev-overlay');
    if (!overlay) return;
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
    devOpened = false;
    devDrafts = {};
    devDirty = {};
}

// ================= 草稿管理（改動先入草稿，按「保存並套用」才寫入 DB） =================

function devDraft(name) {
    if (devDrafts[name] === undefined) devDrafts[name] = dbClone(DB.get(name));
    return devDrafts[name];
}

function devMarkDirty(name) {
    if (devDirty[name]) return;
    devDirty[name] = true;
    devRenderTabs();
    devUpdateFoot();
}

function devDiscardDrafts() {
    devDrafts = {};
    devDirty = {};
    devSelectedCell = null;
    devRenderTabs();
    devRenderBody();
    devStatus('已放棄未儲存的變更');
}

function devDirtyList() {
    return Object.keys(devDirty).filter(name => devDirty[name] && DB.def(name));
}

function devUpdateFoot() {
    const dirty = devDirtyList();
    const save = devEl('dev-save');
    if (save) save.disabled = dirty.length === 0;

    if (dirty.length === 0) {
        devStatus('所有集合已同步（目前沒有未儲存變更）');
    } else {
        devStatus(dirty.length + ' 個集合有未儲存變更：' + dirty.map(n => DB.def(n).label).join('、'), 'warn');
    }
}

// ================= 分頁 =================

function devRenderTabs() {
    const bar = devEl('dev-tabs');
    if (!bar) return;

    bar.innerHTML = DEV_TABS.map(tab => `
        <button type="button" class="dev-tab ${tab.id === devTab ? 'is-active' : ''}" data-dev-tab="${tab.id}">
            ${icon(tab.icon, { size: 15 })}<span>${tab.label}</span>${devTabDirty(tab.id) ? '<span class="dev-tab__dot"></span>' : ''}
        </button>`).join('');

    bar.querySelectorAll('[data-dev-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
            devTab = btn.getAttribute('data-dev-tab');
            devSelectedCell = null;
            devRenderTabs();
            devRenderBody();
        });
    });
}

function devTabDirty(tabId) {
    if (tabId === 'events') return !!devDirty['events'];
    if (tabId === 'holidays') return !!devDirty['holidays'];
    if (tabId === 'users') return !!(devDirty['classes'] || devDirty['accounts']);
    if (tabId === 'schedules') return Object.keys(devDirty).some(k => k.indexOf('schedule:') === 0 && devDirty[k]);
    return devDirtyList().length > 0;
}

function devRenderBody() {
    const body = devEl('dev-body');
    if (!body) return;

    if (devTab === 'events') body.innerHTML = devRenderRecordsTab('events');
    else if (devTab === 'holidays') body.innerHTML = devRenderRecordsTab('holidays');
    else if (devTab === 'schedules') { body.innerHTML = devRenderSchedulesTab(); devRenderScheduleEditor(); }
    else if (devTab === 'users') body.innerHTML = devRenderUsersTab();
    else body.innerHTML = devRenderRawTab();

    if (devTab === 'raw') devSyncRawTextarea();
    devUpdateFoot();
}

// ================= ① 通用記錄表（事件 / 假期） =================

function devRenderRecordsTab(name) {
    const def = DB.def(name);
    const rows = devDraft(name) || [];
    const cols = def.fields;

    const head = '<th class="dev-col-idx">#</th>' +
        cols.map(f => `<th${f.width ? ` style="width:${f.width}"` : ''}>${escapeHtml(f.label)}${f.required ? ' *' : ''}</th>`).join('') +
        '<th class="dev-col-act">操作</th>';

    const body = rows.length === 0
        ? `<tr><td colspan="${cols.length + 2}" style="text-align:center;padding:22px;opacity:.5">目前沒有任何資料，點「新增」開始。</td></tr>`
        : rows.map((row, index) => {
            const cells = cols.map(f => `<td>${devRenderField(name, index, f, row)}</td>`).join('');
            return `<tr class="${devDirty[name] ? 'is-dirty' : ''}">
                        <td class="dev-col-idx">${index + 1}</td>
                        ${cells}
                        <td class="dev-col-act">
                            <button type="button" class="dev-btn dev-btn--ghost dev-btn--icon dev-btn--danger"
                                    data-dev-action="del-row" data-dev-name="${name}" data-dev-index="${index}"
                                    title="刪除這一行" aria-label="刪除這一行">${icon('trash', { size: 15 })}</button>
                        </td>
                    </tr>`;
        }).join('');

    const sourceLabel = {
        local: 'localStorage 覆寫版本',
        file: '靜態檔 ' + (def.file || ''),
        fallback: '內建備援值'
    }[DB.source(name)] || '未載入';

    const overrideHint = DB.isOverridden(name)
        ? `<p class="dev-hint">此集合目前讀取緊 localStorage 覆寫版本（開發者改過）。
             按「還原預設值」可清除覆寫，回到 <code>${escapeHtml(def.file || '')}</code> 的原始內容。</p>`
        : '';

    return `
        <div class="dev-bar">
            <button type="button" class="dev-btn dev-btn--primary" data-dev-action="add-row" data-dev-name="${name}">
                ${icon('plus', { size: 15 })} 新增
            </button>
            <button type="button" class="dev-btn" data-dev-action="raw-toggle" data-dev-name="${name}">
                ${icon('puzzle', { size: 15 })} 切換 Raw JSON
            </button>
            <button type="button" class="dev-btn" data-dev-action="reset-db" data-dev-name="${name}">
                ${icon('refresh', { size: 15 })} 還原預設值
            </button>
            <span style="flex:1"></span>
            <span style="opacity:.55;font-size:11.5px">共 ${rows.length} 筆 · 來源：${escapeHtml(sourceLabel)}</span>
        </div>
        ${overrideHint}
        <div class="dev-table-wrap">
            <table class="dev-table">
                <thead><tr>${head}</tr></thead>
                <tbody>${body}</tbody>
            </table>
        </div>`;
}

// 依欄位定義生成輸入元件
function devRenderField(name, index, field, row) {
    const common = `data-dev-name="${name}" data-dev-index="${index}" data-dev-key="${escapeHtml(field.key)}"`;
    const value = row[field.key];
    const val = value === undefined || value === null ? '' : value;

    if (field.type === 'select') {
        const options = (field.options || []).map(opt =>
            `<option value="${escapeHtml(opt.value)}"${String(opt.value) === String(val) ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`
        ).join('');
        return `<select class="dev-select" ${common}>${options}</select>`;
    }

    if (field.type === 'color') {
        const fallback = dbEventType(row.type || 'other').color;
        return `<div class="dev-color-cell">
                    <input type="color" class="dev-color ${val ? '' : 'is-default'}"
                           value="${escapeHtml(val || fallback)}" ${common}>
                    <button type="button" class="dev-btn dev-btn--ghost dev-btn--icon"
                            data-dev-action="clear-color" data-dev-name="${name}" data-dev-index="${index}"
                            title="清除自訂顏色（改用類別預設色）">${icon('close', { size: 14 })}</button>
                </div>`;
    }

    const type = field.type === 'date' ? 'date' : 'text';
    const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : '';
    return `<input type="${type}" class="dev-input" value="${escapeHtml(val)}"${placeholder} ${common}>`;
}

// ================= ② 各班級課表 =================

function devRenderSchedulesTab() {
    const schedules = DB.list('schedules');
    if (!schedules.length) {
        return '<p class="dev-hint">尚未有任何課表集合，請先到「用戶與班級」確認班級清單。</p>';
    }

    const current = schedules.find(d => (d.classId || 'default') === devScheduleClass) || schedules[0];
    devScheduleClass = current.classId || 'default';
    const name = current.name;
    const draft = devDraft(name) || {};

    const picker = schedules.map(d => {
        const id = d.classId || 'default';
        return `<button type="button" class="dev-btn ${id === devScheduleClass ? 'dev-btn--primary' : ''}"
                        data-dev-action="pick-schedule" data-dev-class-id="${escapeHtml(id)}">
                    ${escapeHtml(d.label)}${devDirty[d.name] ? ' ·未存' : ''}
                </button>`;
    }).join('');

    // 節次欄 = 預設 1~7 節 ∪ 資料中出現過的節次（避免有第 8 節時被隱藏）
    const periods = DB_SCHEDULE_PERIODS.slice();
    DB_SCHEDULE_DAYS.forEach(day => {
        (draft[day] || []).forEach(item => {
            const p = Number(item.period);
            if (p && periods.indexOf(p) < 0) periods.push(p);
        });
    });
    periods.sort((a, b) => a - b);

    const head = '<th>節次</th>' + DB_SCHEDULE_DAYS.map(day => `<th>週${DB_DAY_NAMES_FULL[day]}</th>`).join('');

    const rows = periods.map(period => {
        const cells = DB_SCHEDULE_DAYS.map(day => {
            const item = (draft[day] || []).find(x => Number(x.period) === period);
            const selected = devSelectedCell && devSelectedCell.day === day && devSelectedCell.period === period;
            const inner = item
                ? `<span class="dev-cell__subject">${escapeHtml(item.subject)}</span>
                   <span class="dev-cell__meta">${escapeHtml(item.teacher || '—')}${item.room ? ' · ' + escapeHtml(item.room) : ''}</span>
                   <span class="dev-cell__meta">${escapeHtml(item.start || '')}${item.end ? '~' + escapeHtml(item.end) : ''}</span>`
                : `<span class="dev-cell__meta">${icon('plus', { size: 13 })} 點擊新增</span>`;
            return `<td><button type="button" class="dev-cell ${item ? '' : 'is-empty'} ${selected ? 'is-selected' : ''}"
                            data-dev-action="pick-cell" data-dev-day="${day}" data-dev-period="${period}">${inner}</button></td>`;
        }).join('');
        return `<tr><td>第 ${period} 節</td>${cells}</tr>`;
    }).join('');

    return `
        <div class="dev-bar">${picker}</div>
        <p class="dev-hint">
            點任何一格即可編輯「科目 / 老師 / 教室 / 時間」。集合：<code>${escapeHtml(name)}</code>
            　檔案：<code>${escapeHtml(current.file || '')}</code>
            ${DB.isOverridden(name) ? '（目前讀取緊 localStorage 覆寫版本）' : ''}
        </p>
        <div class="dev-grid-wrap">
            <table class="dev-grid">
                <thead><tr>${head}</tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <div class="dev-bar" style="margin-top:12px">
            <button type="button" class="dev-btn" data-dev-action="raw-toggle" data-dev-name="${name}">
                ${icon('puzzle', { size: 15 })} 切換 Raw JSON
            </button>
            <button type="button" class="dev-btn" data-dev-action="reset-db" data-dev-name="${name}">
                ${icon('refresh', { size: 15 })} 還原預設值
            </button>
            <span style="flex:1"></span>
            <span style="opacity:.55;font-size:11.5px">共 ${dbScheduleDayCount(draft)} 堂課</span>
        </div>
        <div id="dev-schedule-editor"></div>`;
}

function devRenderScheduleEditor() {
    const box = devEl('dev-schedule-editor');
    if (!box) return;

    if (!devSelectedCell) { box.innerHTML = ''; return; }

    const name = dbScheduleName(devScheduleClass);
    const draft = devDraft(name) || {};
    const day = devSelectedCell.day;
    const period = devSelectedCell.period;
    const item = (draft[day] || []).find(x => Number(x.period) === period) || {};

    const field = (key, label, placeholder) => `
        <div class="dev-field">
            <label for="dev-cell-${key}">${label}</label>
            <input id="dev-cell-${key}" type="text" class="dev-input"
                   value="${escapeHtml(item[key] === undefined || item[key] === null ? '' : item[key])}"
                   placeholder="${placeholder}">
        </div>`;

    box.innerHTML = `
        <div class="dev-editor">
            <div class="dev-editor__title">編輯：週${DB_DAY_NAMES_FULL[day]} · 第 ${period} 節</div>
            <div class="dev-form-grid">
                ${field('subject', '科目 *', '例如：中文')}
                ${field('teacher', '老師', '例如：陳老師')}
                ${field('room', '教室', '例如：E303')}
            </div>
            <div class="dev-form-grid" style="margin-top:8px">
                ${field('start', '開始時間', '09:00')}
                ${field('end', '結束時間', '09:45')}
            </div>
            <div class="dev-bar" style="margin:12px 0 0">
                <button type="button" class="dev-btn dev-btn--primary" data-dev-action="cell-save">
                    ${icon('checkCircle', { size: 15 })} 套用到草稿
                </button>
                <button type="button" class="dev-btn dev-btn--danger" data-dev-action="cell-delete">
                    ${icon('trash', { size: 15 })} 清空這一格
                </button>
                <button type="button" class="dev-btn dev-btn--ghost" data-dev-action="cell-cancel">取消</button>
            </div>
        </div>`;
}

// ================= ③ 用戶與班級 =================

function devRenderUsersTab() {
    const classDoc = devDraft('classes') || { classes: [], defaultClassId: '', defaultSchedule: '' };
    const accounts = devDraft('accounts') || [];
    const classDef = DB.def('classes');

    // ---- 班級清單 ----
    const classCells = classDef.fields.map(f => `<th>${escapeHtml(f.label)}${f.required ? ' *' : ''}</th>`).join('');
    const classRows = classDoc.classes.length === 0
        ? `<tr><td colspan="${classDef.fields.length + 2}" style="text-align:center;padding:18px;opacity:.5">尚無班級</td></tr>`
        : classDoc.classes.map((cls, index) => {
            const cells = classDef.fields.map(f => {
                const attr = `data-dev-name="classes" data-dev-class-index="${index}" data-dev-key="${f.key}"`;
                if (f.type === 'select') {
                    const options = (f.options || []).map(opt =>
                        `<option value="${escapeHtml(opt.value)}"${String(opt.value) === String(cls[f.key]) ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`
                    ).join('');
                    return `<td><select class="dev-select" ${attr}>${options}</select></td>`;
                }
                const val = cls[f.key] === undefined || cls[f.key] === null ? '' : cls[f.key];
                return `<td><input type="text" class="dev-input" value="${escapeHtml(val)}" ${attr}></td>`;
            }).join('');
            return `<tr class="${devDirty['classes'] ? 'is-dirty' : ''}">
                        <td class="dev-col-idx">${index + 1}</td>
                        ${cells}
                        <td class="dev-col-act">
                            <button type="button" class="dev-btn dev-btn--ghost dev-btn--icon dev-btn--danger"
                                    data-dev-action="del-class" data-dev-class-index="${index}" title="刪除班級"
                                    aria-label="刪除班級">${icon('trash', { size: 15 })}</button>
                        </td>
                    </tr>`;
        }).join('');

    const defaultOptions = classDoc.classes.map(cls =>
        `<option value="${escapeHtml(cls.id)}"${String(cls.id) === String(classDoc.defaultClassId) ? ' selected' : ''}>${escapeHtml(cls.name)}</option>`
    ).join('');

    // ---- 帳號清單 ----
    const accFields = DB.def('accounts').fields.filter(f => f.key !== 'provider');
    const accCells = accFields.map(f => `<th>${escapeHtml(f.label)}</th>`).join('');
    const accRows = accounts.length === 0
        ? `<tr><td colspan="${accFields.length + 3}" style="text-align:center;padding:18px;opacity:.5">目前沒有已註冊的帳號</td></tr>`
        : accounts.map((acc, index) => {
            const cells = accFields.map(f => {
                const val = acc[f.key] === undefined || acc[f.key] === null ? '' : acc[f.key];
                return `<td><input type="text" class="dev-input" value="${escapeHtml(val)}"
                            data-dev-name="accounts" data-dev-acc-index="${index}" data-dev-key="${f.key}"></td>`;
            }).join('');
            const current = (typeof authGetCurrentAccount === 'function') ? authGetCurrentAccount() : null;
            const isCurrent = current && current.id === acc.id;
            return `<tr class="${devDirty['accounts'] ? 'is-dirty' : ''}">
                        <td class="dev-col-idx">${isCurrent ? icon('star', { size: 13 }) : index + 1}</td>
                        ${cells}
                        <td style="opacity:.55;font-size:11px">${escapeHtml(acc.provider || 'local')}</td>
                        <td class="dev-col-act">
                            <button type="button" class="dev-btn dev-btn--ghost dev-btn--icon dev-btn--danger"
                                    data-dev-action="del-account" data-dev-acc-index="${index}" title="移除帳號"
                                    aria-label="移除帳號">${icon('trash', { size: 15 })}</button>
                        </td>
                    </tr>`;
        }).join('');

    return `
        <div class="dev-section-title">${icon('school', { size: 16 })} 班級清單（classes.json）</div>
        <div class="dev-bar">
            <button type="button" class="dev-btn dev-btn--primary" data-dev-action="add-class">
                ${icon('plus', { size: 15 })} 新增班級
            </button>
            <button type="button" class="dev-btn" data-dev-action="raw-toggle" data-dev-name="classes">
                ${icon('puzzle', { size: 15 })} 切換 Raw JSON
            </button>
            <button type="button" class="dev-btn" data-dev-action="reset-db" data-dev-name="classes">
                ${icon('refresh', { size: 15 })} 還原預設值
            </button>
        </div>
        <div class="dev-table-wrap">
            <table class="dev-table">
                <thead><tr><th class="dev-col-idx">#</th>${classCells}<th class="dev-col-act">操作</th></tr></thead>
                <tbody>${classRows}</tbody>
            </table>
        </div>
        <div class="dev-form-grid" style="margin-top:10px">
            <div class="dev-field">
                <label for="dev-default-class">預設班級 defaultClassId</label>
                <select id="dev-default-class" class="dev-select"
                        data-dev-name="classes" data-dev-key="__defaultClassId">
                    <option value="">— 未設定 —</option>${defaultOptions}
                </select>
            </div>
            <div class="dev-field">
                <label for="dev-default-schedule">預設課表 defaultSchedule</label>
                <input id="dev-default-schedule" type="text" class="dev-input"
                       value="${escapeHtml(classDoc.defaultSchedule || '')}"
                       data-dev-name="classes" data-dev-key="__defaultSchedule">
            </div>
        </div>

        <div class="dev-section-title">${icon('user', { size: 16 })} 已註冊帳號（auth_accounts）</div>
        <div class="dev-bar">
            <button type="button" class="dev-btn" data-dev-action="raw-toggle" data-dev-name="accounts">
                ${icon('puzzle', { size: 15 })} 切換 Raw JSON
            </button>
            <button type="button" class="dev-btn" data-dev-action="reload-accounts">
                ${icon('refresh', { size: 15 })} 由 localStorage 重新讀取
            </button>
            <span style="flex:1"></span>
            <span style="opacity:.55;font-size:11.5px">共 ${accounts.length} 個帳號 · 星號 = 目前登入</span>
        </div>
        <p class="dev-hint">帳號資料（密碼雜湊等）唔會顯示，改動只會更新名稱、Email 與班級綁定。</p>
        <div class="dev-table-wrap">
            <table class="dev-table">
                <thead><tr><th class="dev-col-idx">#</th>${accCells}<th>來源</th><th class="dev-col-act">操作</th></tr></thead>
                <tbody>${accRows}</tbody>
            </table>
        </div>`;
}

// ================= ④ Raw JSON 編輯器 =================

function devRawOptions() {
    const options = [{ value: '__all__', label: '全部集合（整個資料庫）' }];
    DB.list('db').concat(DB.list('schedules')).forEach(def => {
        options.push({ value: def.name, label: def.label + '  ·  ' + def.name });
    });
    return options;
}

function devRenderRawTab() {
    const options = devRawOptions().map(opt =>
        `<option value="${escapeHtml(opt.value)}"${opt.value === devRawTarget ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`
    ).join('');

    return `
        <div class="dev-bar">
            <span style="font-size:11.5px;opacity:.7">目標集合</span>
            <select class="dev-select" id="dev-raw-target" style="max-width:340px">${options}</select>
            <button type="button" class="dev-btn" data-dev-action="raw-pretty">
                ${icon('palette', { size: 15 })} 格式化
            </button>
            <button type="button" class="dev-btn" data-dev-action="raw-copy">
                ${icon('copy', { size: 15 })} 複製
            </button>
            <button type="button" class="dev-btn dev-btn--primary" data-dev-action="raw-apply">
                ${icon('save', { size: 15 })} 解析並套用
            </button>
        </div>
        <p class="dev-hint">
            可以直接貼上完整 JSON。按「解析並套用」後會即時寫入 localStorage 並重新渲染 App，
            唔需要手動重新整理。「全部集合」模式下請用 <code>{ "collections": { ... } }</code> 格式。
        </p>
        <textarea class="dev-textarea" id="dev-raw-text" spellcheck="false"
                  placeholder='{ "events": [ ... ] }'></textarea>`;
}

function devSyncRawTextarea() {
    const area = devEl('dev-raw-text');
    const target = devEl('dev-raw-target');
    if (target) {
        target.onchange = () => {
            devRawTarget = target.value;
            devSyncRawTextarea();
        };
    }
    if (!area) return;

    if (devRawTarget === '__all__') {
        area.value = JSON.stringify(DB.exportObject(), null, 4);
    } else if (devDirty[devRawTarget]) {
        area.value = JSON.stringify(devDrafts[devRawTarget], null, 4);
    } else {
        area.value = JSON.stringify(DB.get(devRawTarget), null, 4);
    }
}

// ================= 事件處理：輸入 =================

function devHandleInput(e) {
    const el = e.target;
    const name = el.getAttribute && el.getAttribute('data-dev-name');
    const key = el.getAttribute && el.getAttribute('data-dev-key');
    if (!name || !key) return;

    const draft = devDraft(name);
    if (!draft) return;

    const rowIndex = el.getAttribute('data-dev-index');
    const classIndex = el.getAttribute('data-dev-class-index');
    const accIndex = el.getAttribute('data-dev-acc-index');

    if (rowIndex !== null) {
        if (!draft[Number(rowIndex)]) return;
        draft[Number(rowIndex)][key] = el.value;
    } else if (classIndex !== null) {
        if (!draft.classes || !draft.classes[Number(classIndex)]) return;
        draft.classes[Number(classIndex)][key] = el.value;
    } else if (accIndex !== null) {
        if (!draft[Number(accIndex)]) return;
        draft[Number(accIndex)][key] = el.value;
    } else if (key === '__defaultClassId') {
        draft.defaultClassId = el.value;
    } else if (key === '__defaultSchedule') {
        draft.defaultSchedule = el.value;
    } else {
        return;
    }

    el.classList.remove('dev-input--invalid');
    const tr = el.closest ? el.closest('tr') : null;
    if (tr) tr.classList.add('is-dirty');
    devMarkDirty(name);
}

function devHandleChange(e) {
    const el = e.target;
    if (el.classList && el.classList.contains('dev-color')) {
        el.classList.toggle('is-default', !el.value);
    }
}

// ================= 事件處理：點擊 =================

function devHandleClick(e) {
    const btn = e.target.closest ? e.target.closest('[data-dev-action]') : null;
    if (!btn) return;

    const action = btn.getAttribute('data-dev-action');
    const name = btn.getAttribute('data-dev-name');

    switch (action) {
        case 'add-row': {
            const draft = devDraft(name);
            draft.push(DB.def(name).emptyRow());
            devMarkDirty(name);
            devRerenderBody();
            const main = devEl('dev-body');
            if (main) main.scrollTop = main.scrollHeight;
            break;
        }
        case 'del-row': {
            const index = Number(btn.getAttribute('data-dev-index'));
            const draft = devDraft(name);
            draft.splice(index, 1);
            devMarkDirty(name);
            devRerenderBody();
            break;
        }
        case 'clear-color': {
            const index = Number(btn.getAttribute('data-dev-index'));
            const draft = devDraft(name);
            if (draft[index]) draft[index].color = '';
            devMarkDirty(name);
            devRerenderBody();
            break;
        }
        case 'raw-toggle': {
            devRawTarget = name;
            devTab = 'raw';
            devRenderTabs();
            devRenderBody();
            break;
        }
        case 'reset-db':
            devResetCollection(name);
            break;

        // ---- 課表 ----
        case 'pick-schedule': {
            devScheduleClass = btn.getAttribute('data-dev-class-id') || 'default';
            devSelectedCell = null;
            devRerenderBody();
            break;
        }
        case 'pick-cell': {
            devSelectedCell = {
                day: Number(btn.getAttribute('data-dev-day')),
                period: Number(btn.getAttribute('data-dev-period'))
            };
            devRerenderBody();
            const editor = devEl('dev-schedule-editor');
            if (editor) editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            break;
        }
        case 'cell-save': {
            const day = devSelectedCell ? devSelectedCell.day : null;
            if (!day) break;
            const period = devSelectedCell.period;
            const name2 = dbScheduleName(devScheduleClass);
            const draft = devDraft(name2);
            const list = draft[day] || (draft[day] = []);

            const subject = (devEl('dev-cell-subject') || {}).value || '';
            const teacher = (devEl('dev-cell-teacher') || {}).value || '';
            const room = (devEl('dev-cell-room') || {}).value || '';
            const start = (devEl('dev-cell-start') || {}).value || '';
            const end = (devEl('dev-cell-end') || {}).value || '';

            if (!subject.trim()) {
                const input = devEl('dev-cell-subject');
                if (input) input.classList.add('dev-input--invalid');
                devStatus('科目不可留空（如要移除請按「清空這一格」）', 'error');
                break;
            }

            const existing = list.find(x => Number(x.period) === period);
            if (existing) {
                Object.assign(existing, { subject: subject.trim(), teacher: teacher.trim(), room: room.trim(), start: start.trim(), end: end.trim() });
            } else {
                list.push({ period: period, subject: subject.trim(), teacher: teacher.trim(), room: room.trim(), start: start.trim(), end: end.trim() });
            }
            list.sort((a, b) => a.period - b.period);
            devMarkDirty(name2);
            devRerenderBody();
            devStatus('已更新 週' + DB_DAY_NAMES_FULL[day] + ' 第 ' + period + ' 節（尚未儲存）', 'warn');
            break;
        }
        case 'cell-delete': {
            if (!devSelectedCell) break;
            const day = devSelectedCell.day;
            const period = devSelectedCell.period;
            const name2 = dbScheduleName(devScheduleClass);
            const draft = devDraft(name2);
            draft[day] = (draft[day] || []).filter(x => Number(x.period) !== period);
            devMarkDirty(name2);
            devRerenderBody();
            devStatus('已清空 週' + DB_DAY_NAMES_FULL[day] + ' 第 ' + period + ' 節（尚未儲存）', 'warn');
            break;
        }
        case 'cell-cancel':
            devSelectedCell = null;
            devRenderScheduleEditor();
            devRerenderBody();
            break;

        // ---- 班級 / 帳號 ----
        case 'add-class': {
            const draft = devDraft('classes');
            draft.classes.push({ id: '', name: '', stage: '初中', schedule: null });
            devMarkDirty('classes');
            devRerenderBody();
            break;
        }
        case 'del-class': {
            const index = Number(btn.getAttribute('data-dev-class-index'));
            const draft = devDraft('classes');
            draft.classes.splice(index, 1);
            devMarkDirty('classes');
            devRerenderBody();
            break;
        }
        case 'del-account': {
            const index = Number(btn.getAttribute('data-dev-acc-index'));
            const draft = devDraft('accounts');
            draft.splice(index, 1);
            devMarkDirty('accounts');
            devRerenderBody();
            break;
        }
        case 'reload-accounts': {
            devDrafts['accounts'] = dbClone(DB.get('accounts'));
            delete devDirty['accounts'];
            devRenderTabs();
            devRerenderBody();
            devStatus('已由 localStorage 重新讀取帳號清單');
            break;
        }

        // ---- Raw JSON ----
        case 'raw-pretty': {
            const area = devEl('dev-raw-text');
            try {
                area.value = JSON.stringify(JSON.parse(area.value), null, 4);
                devStatus('已格式化 JSON', 'ok');
            } catch (err) {
                devStatus('JSON 格式錯誤：' + (err.message || err), 'error');
            }
            break;
        }
        case 'raw-copy': {
            const area = devEl('dev-raw-text');
            navigator.clipboard.writeText(area.value)
                .then(() => { devStatus('已複製到剪貼板', 'ok'); devToast('已複製'); })
                .catch(() => devStatus('複製失敗，請手動選取', 'error'));
            break;
        }
        case 'raw-apply':
            devApplyRaw();
            break;
    }
}

// 重新渲染目前分頁（保留滾動位置）
function devRerenderBody() {
    const main = devEl('dev-body');
    const scroll = main ? main.scrollTop : 0;
    devRenderBody();
    if (main) main.scrollTop = scroll;
}

// ================= Raw JSON 套用 =================

function devApplyRaw() {
    const area = devEl('dev-raw-text');
    if (!area) return;

    let payload;
    try {
        payload = JSON.parse(area.value);
    } catch (err) {
        devStatus('JSON 解析失敗：' + (err.message || err), 'error');
        return;
    }

    if (devRawTarget === '__all__') {
        const result = DB.importObject(devNormalizeImportPayload(payload));
        devDrafts = {};
        devDirty = {};
        devRenderTabs();
        devRerenderBody();
        if (result.ok) {
            devStatus('已套用：' + result.applied.join('、') +
                (result.skipped.length ? '（略過：' + result.skipped.join('、') + '）' : ''), 'ok');
            devToast('Raw JSON 已套用');
        } else {
            devStatus('找不到可辨識的集合，請確認格式為 { "collections": { ... } }', 'error');
        }
        return;
    }

    const check = devValidate(devRawTarget, payload);
    if (!check.ok) {
        devStatus(check.error, 'error');
        return;
    }

    if (DB.set(devRawTarget, payload, { action: 'dev-raw' })) {
        delete devDrafts[devRawTarget];
        delete devDirty[devRawTarget];
        devRenderTabs();
        devStatus('「' + DB.def(devRawTarget).label + '」已由 Raw JSON 更新並即時套用', 'ok');
        devToast('已套用 ' + DB.def(devRawTarget).label);
    } else {
        devStatus('寫入 localStorage 失敗', 'error');
    }
}

// 兼容直接貼上 data/classes.json 的格式
function devNormalizeImportPayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    if (payload.collections) return payload;
    if (Array.isArray(payload.classes) &&
        (payload.defaultClassId !== undefined || payload.defaultSchedule !== undefined)) {
        return { collections: { classes: payload } };
    }
    // 純班級陣列（例如 [{ "id": "S2A", "name": "初二信", "code": "S2A" }, …]）
    // 視為班級集合：每項都要有 id + name，而且唔可以有日期／節次欄位，
    // 免得有人貼 events / holidays 嘅純陣列時被誤認成班級。
    if (Array.isArray(payload) && payload.length &&
        payload.every(item => item && typeof item === 'object' && item.id && item.name &&
            item.date === undefined && item.startDate === undefined &&
            item.start === undefined && item.end === undefined)) {
        return { collections: { classes: { classes: payload } } };
    }
    return payload;
}

// ================= 資料驗證 =================

const DEV_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function devValidate(name, value) {
    const def = DB.def(name);
    if (!def) return { ok: false, error: '未知的集合：' + name };
    const kind = def.kind || 'records';

    if (kind === 'records') {
        const list = Array.isArray(value) ? value : null;
        if (!list) return { ok: false, error: def.label + '：資料必須是陣列' };

        for (let i = 0; i < list.length; i++) {
            const row = list[i];
            const where = def.label + ' 第 ' + (i + 1) + ' 行';
            for (const f of def.fields || []) {
                const raw = row[f.key];
                const text = raw === undefined || raw === null ? '' : String(raw);
                if (f.required && !text.trim()) {
                    return { ok: false, error: where + '：「' + f.label + '」不可留空' };
                }
                if (f.type === 'date' && text && !DEV_DATE_RE.test(text)) {
                    return { ok: false, error: where + '：「' + f.label + '」格式要係 YYYY-MM-DD' };
                }
            }
            if (row.color && !dbIsHexColor(row.color)) {
                return { ok: false, error: where + '：顏色格式要係 #RRGGBB' };
            }
        }

        if (name === 'holidays') {
            for (const h of list) {
                if (h.endDate && h.date && h.endDate < h.date) {
                    return { ok: false, error: '假期「' + h.name + '」的結束日期早過開始日期' };
                }
            }
        }
        return { ok: true };
    }

    if (kind === 'classes') {
        const list = (value && value.classes) || [];
        if (!list.length) return { ok: false, error: '至少要保留一個班級' };

        const seen = Object.create(null);
        for (const cls of list) {
            const id = String(cls.id || '').trim();
            if (!id) return { ok: false, error: '班級 ID 不可留空' };
            if (!String(cls.name || '').trim()) return { ok: false, error: '班級「' + id + '」缺少名稱' };
            if (seen[id]) return { ok: false, error: '班級 ID 重複：' + id };
            seen[id] = true;
        }
        if (value.defaultClassId && !seen[value.defaultClassId]) {
            return { ok: false, error: '預設班級 ID「' + value.defaultClassId + '」不在班級清單中' };
        }
        return { ok: true };
    }

    if (kind === 'schedule') {
        const data = value && typeof value === 'object' ? value : null;
        if (!data) return { ok: false, error: def.label + '：資料必須是物件' };

        for (const day of DB_SCHEDULE_DAYS) {
            const list = data[day];
            if (list === undefined) continue;
            if (!Array.isArray(list)) return { ok: false, error: '週' + DB_DAY_NAMES_FULL[day] + ' 的資料必須是陣列' };
            for (const item of list) {
                const period = Number(item.period);
                if (!period || period < 1 || period > 12) {
                    return { ok: false, error: '週' + DB_DAY_NAMES_FULL[day] + '：節次必須係 1 ~ 12' };
                }
                if (!String(item.subject || '').trim()) {
                    return { ok: false, error: '週' + DB_DAY_NAMES_FULL[day] + ' 第 ' + period + ' 節：科目不可留空' };
                }
            }
        }
        return { ok: true };
    }

    return { ok: true };
}

// ================= 保存並套用（Hot Reload） =================

function devSaveAll() {
    const names = devDirtyList();
    if (!names.length) {
        devStatus('沒有需要儲存的變更');
        return;
    }

    // 先全部驗證，任何一個唔過就唔會寫入（避免寫入一半）
    for (const name of names) {
        const check = devValidate(name, devDrafts[name]);
        if (!check.ok) {
            devStatus(check.error, 'error');
            devToast('儲存失敗，請檢查資料');
            return;
        }
    }

    const done = [];
    for (const name of names) {
        if (DB.set(name, devDrafts[name], { action: 'dev' })) {
            done.push(DB.def(name).label);
        } else {
            devStatus('寫入 localStorage 失敗：' + name, 'error');
            return;
        }
    }

    devDrafts = {};
    devDirty = {};
    devSelectedCell = null;
    devRenderTabs();
    devRenderBody();
    devStatus('已保存並套用：' + done.join('、') + '　→ App 已即時重新渲染', 'ok');
    devToast('已套用 ' + done.length + ' 個集合');
}

function devDiscard() {
    devDiscardDrafts();
}

// ================= 重置 =================

async function devResetCollection(name) {
    const def = DB.def(name);
    if (!def) return;

    const source = def.file ? '回到 ' + def.file + ' 的原始內容' : '清空所有本機資料';
    if (!window.confirm('確定要將「' + def.label + '」還原為預設值？\n\n· 會清除本機的覆寫版本\n· ' + source)) return;

    delete devDrafts[name];
    delete devDirty[name];
    await DB.reset(name);
    devRenderTabs();
    devRerenderBody();
    devStatus('已還原「' + def.label + '」為預設值', 'ok');
    devToast('已重置 ' + def.label);
}

async function devResetAll() {
    const confirmed = window.confirm(
        '確定要將「所有資料集合」還原為預設值？\n\n' +
        '· 事件、假期、班級清單、各班課表的本機修改都會被清除\n' +
        '· 已註冊的帳號唔會受影響\n\n（此操作無法復原）'
    );
    if (!confirmed) return;

    const names = await DB.resetAll();
    devDrafts = {};
    devDirty = {};
    devSelectedCell = null;
    devRenderTabs();
    devRenderBody();
    devStatus('已重置 ' + names.length + ' 個集合為預設值', 'ok');
    devToast('已重置全部資料');
}

// ================= 匯出 / 匯入 =================

function devExportAll() {
    const json = DB.exportJson();
    const stamp = new Date().toISOString().slice(0, 10);
    devDownload('my-schedule-db-' + stamp + '.json', json);

    const count = DB.list('db').length;
    devStatus('已匯出 ' + count + ' 個集合（' + Math.round(json.length / 1024) + ' KB）', 'ok');
    devToast('已匯出資料庫備份');
}

function devImportClick() {
    const input = devEl('dev-import-file');
    if (!input) return;
    input.value = '';
    input.click();
}

async function devHandleImportFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    try {
        const payload = devNormalizeImportPayload(JSON.parse(await file.text()));
        const result = DB.importObject(payload);
        devDrafts = {};
        devDirty = {};
        devRenderTabs();
        devRenderBody();

        if (result.ok) {
            devStatus('已匯入：' + result.applied.join('、') +
                (result.skipped.length ? '（略過未識別的集合：' + result.skipped.join('、') + '）' : ''), 'ok');
            devToast('匯入完成');
        } else {
            devStatus('匯入內容找不到可辨識的集合', 'error');
        }
    } catch (err) {
        devStatus('匯入失敗：' + (err && err.message ? err.message : err), 'error');
    }
}
