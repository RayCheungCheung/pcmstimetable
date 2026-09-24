// ============================================================
// DataManager（DB）— App 唯一嘅資料存取層（Single Source of Truth）
//
// 讀取優先序（三個層級）：
//   1. localStorage 覆寫（使用者／開發者改過嘅版本）
//   2. 靜態 .json 檔案（data/*.json，即預設值）
//   3. 程式內建備援值（連網絡都無時仍然唔會白畫面）
//
// 寫入：一律寫入 localStorage，唔會改動伺服器上嘅 .json。
// 因此「重置為預設值」＝ 刪掉 localStorage 覆寫，下次重新讀靜態檔。
//
// 所有集合（collection）都用同一份描述（descriptor）驅動，
// 開發者面板（devtools.js）可以直接由描述生成表格／表單／Raw JSON 編輯器。
// ============================================================

const DB_PREFIX = 'appdb_v1_';
const APP_VERSION = '2.5.0';   // 與 service-worker.js 的 CACHE_NAME、index.html 的 ?v= 標記同步

// 班級清單的資料結構版本，對照 data/classes.json 的 schemaVersion。
// 一旦唔一致 → 清掉 localStorage 內殘留嘅舊班級快取（auth_classes_cache），
// 否則舊清單會永遠蓋過新嘅 classes.json（UI 出現舊班別嘅根本原因）。
const DB_CLASSES_SCHEMA_KEY = 'appdb_classes_schema_v';

// ================= 共用常數 =================

// 月曆事件類別：value 同時係 CSS class 名，color 係預設顏色
// icon 為 scripts/utils/icons.js 的圖示名（全站禁止 Emoji）
const DB_EVENT_TYPES = [
    { value: 'holiday',  label: '假期',      icon: 'sparkles',  color: '#ff5f9e' },
    { value: 'exam',     label: '測驗 / 考試', icon: 'clipboard', color: '#ff9f0a' },
    { value: 'homework', label: '作業截止',  icon: 'book',      color: '#6a5cff' },
    { value: 'activity', label: '活動',      icon: 'target',    color: '#00c2a8' },
    { value: 'other',    label: '其他',      icon: 'pin',       color: '#8e8e93' }
];

// 面板「圖示」欄位可揀的圖示（對應 icons.js 的 APP_ICON_PATHS）
const DB_ICON_CHOICES = [
    { value: 'sparkles',  label: '慶祝' },
    { value: 'flag',      label: '旗幟' },
    { value: 'gift',      label: '禮物' },
    { value: 'tree',      label: '聖誕樹' },
    { value: 'moon',      label: '月亮' },
    { value: 'flower',    label: '花卉' },
    { value: 'leaf',      label: '葉子' },
    { value: 'egg',       label: '彩蛋' },
    { value: 'mountain',  label: '山岳' },
    { value: 'book',      label: '書本' },
    { value: 'bookOpen',  label: '開卷' },
    { value: 'clipboard', label: '測驗' },
    { value: 'target',    label: '活動' },
    { value: 'pin',       label: '標記' },
    { value: 'star',      label: '星號' },
    { value: 'bell',      label: '提醒' },
    { value: 'clock',     label: '時鐘' },
    { value: 'timer',     label: '倒數' },
    { value: 'calendar',  label: '月曆' },
    // 假期統一用 palmtree（跟 TabBar「假期」同款；umbrella 已不再作為假期圖示）
    { value: 'palmtree',  label: '椰樹 / 假期' },
    { value: 'school',    label: '學校' },
    { value: 'dot',       label: '圓點' }
];

const DB_DAY_NAMES_FULL = ['日', '一', '二', '三', '四', '五', '六'];

// 課表編輯器用嘅星期欄（跟 App 現有資料模型：1=週一 … 6=週六）
const DB_SCHEDULE_DAYS = [1, 2, 3, 4, 5, 6];
const DB_SCHEDULE_PERIODS = [1, 2, 3, 4, 5, 6, 7];

function dbEventType(type) {
    return DB_EVENT_TYPES.find(t => t.value === type) || DB_EVENT_TYPES[DB_EVENT_TYPES.length - 1];
}

// 取得事件類別的預設圖示名
function dbEventIcon(type) {
    return dbEventType(type).icon;
}

function dbIsHexColor(value) {
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(value || '').trim());
}

// 內容層節日 Emoji：只接受真係 Emoji 嘅值，其餘一律清空（系統 UI 嚴禁 Emoji）
function dbPickEmoji(value) {
    if (value === undefined || value === null) return '';
    if (typeof isEmojiValue === 'function' && isEmojiValue(value)) {
        return String(value).trim().slice(0, 12);
    }
    return '';
}

// 內建節日 Emoji 對照表：
// 舊資料（localStorage 內冇 emoji 欄位）載入時，依假期／活動名稱自動補上節日氛圍；
// 使用者已自行設定（包括刻意清空）嘅一律尊重，唔會被覆寫。
const DB_FESTIVAL_EMOJI = [
    [/教師節/, '🍎'],
    [/中秋/, '🥮'],
    [/國慶/, '🇨🇳'],
    [/重陽/, '🌼'],
    [/特區成立|回歸/, '🇲🇴'],
    [/聖誕/, '🎄'],
    [/冬至/, '🎄'],
    [/元旦/, '🥂'],
    [/春節|農曆新年|新年/, '🧧'],
    [/元宵/, '🏮'],
    [/婦女節/, '🌷'],
    [/復活節/, '🐰'],
    [/清明/, '🌿'],
    [/端午/, '🐲'],
    [/萬聖/, '🎃'],
    [/情人節/, '💗'],
    [/兒童節/, '🎈']
];

function dbFestivalEmoji(text) {
    const s = String(text === undefined || text === null ? '' : text);
    if (!s) return '';
    for (let i = 0; i < DB_FESTIVAL_EMOJI.length; i++) {
        if (DB_FESTIVAL_EMOJI[i][0].test(s)) return DB_FESTIVAL_EMOJI[i][1];
    }
    return '';
}

// 共用 HTML 轉義：開發者面板可以輸入任意文字，渲染前一律轉義
function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ================= 集合描述（Schema） =================
//
// 每個集合可以設定：
//   label / icon   面板顯示
//   file           靜態 JSON 路徑（無＝純 localStorage）
//   pick           由檔案物件中抽出邊個欄位（null＝用整份）
//   storageKey     localStorage key
//   array          true＝頂層係陣列
//   fields         開發者面板用嘅欄位定義（可自動生成表格／表單）
//   normalize      讀入後嘅正規化（補 id、補預設值）
//   fallback       連靜態檔都讀唔到時嘅備援值

const DB_FIELD_DEFS = {
    events: [
        { key: 'date',  label: '日期', type: 'date', required: true, width: '132px' },
        { key: 'title', label: '名稱', type: 'text', required: true },
        { key: 'type',  label: '類別', type: 'select', options: DB_EVENT_TYPES, width: '132px' },
        { key: 'emoji', label: '節日 Emoji', type: 'text', placeholder: '選填，例：🎄', width: '104px' },
        { key: 'icon',  label: '線條圖示', type: 'select', options: DB_ICON_CHOICES, width: '108px' },
        { key: 'color', label: '顏色', type: 'color', width: '56px' },
        { key: 'note',  label: '備註', type: 'text' }
    ],
    holidays: [
        { key: 'name',    label: '假期名稱', type: 'text', required: true },
        { key: 'date',    label: '開始日期', type: 'date', required: true, width: '132px' },
        { key: 'endDate', label: '結束日期', type: 'date', width: '132px' },
        { key: 'emoji',   label: '節日 Emoji', type: 'text', placeholder: '選填，例：🥮', width: '104px' },
        { key: 'icon',    label: '線條圖示', type: 'select', options: DB_ICON_CHOICES, width: '108px' },
        { key: 'note',    label: '備註', type: 'text' }
    ],
    classes: [
        { key: 'id',       label: '班級 ID', type: 'text', required: true, width: '132px' },
        { key: 'name',     label: '班級名稱', type: 'text', required: true },
        { key: 'code',     label: '英文代號', type: 'text', placeholder: '例：S2A', width: '96px' },
        { key: 'stage',    label: '階段', type: 'select', width: '96px',
          options: [{ value: '初中', label: '初中' }, { value: '高中', label: '高中' }] },
        { key: 'schedule', label: '課表路徑', type: 'text', placeholder: '留空 = 用預設課表' }
    ],
    accounts: [
        { key: 'name',      label: '名稱', type: 'text' },
        { key: 'email',     label: 'Email', type: 'text' },
        { key: 'provider',  label: '來源', type: 'text', width: '80px' },
        { key: 'classId',   label: '班級 ID', type: 'text', width: '132px' },
        { key: 'className', label: '班級名稱', type: 'text' }
    ]
};

const DB_BASE_DEFS = {
    events: {
        label: '月曆與事件',
        icon: 'calendar',
        group: 'db',
        file: 'data/events.json',
        pick: 'events',
        storageKey: 'calendar_events',      // 沿用舊 key，舊用家的自訂事件唔會唔見
        array: true,
        kind: 'records',
        fields: DB_FIELD_DEFS.events,
        fallback: [],
        normalize: function (list) {
            if (!Array.isArray(list)) return [];
            return list
                .filter(e => e && e.date && e.title)
                .map((e, index) => {
                    const type = e.type || 'holiday';
                    // 舊資料可能把 Emoji 塞在 icon 欄，統一搬到 emoji（內容層）
                    const hasEmojiKey = Object.prototype.hasOwnProperty.call(e, 'emoji');
                    const emoji = dbPickEmoji(e.emoji) || dbPickEmoji(e.icon) ||
                        (hasEmojiKey ? '' : (type === 'holiday' ? dbFestivalEmoji(e.title) : ''));
                    return {
                        id: e.id || ('default-' + index + '-' + e.date),
                        date: String(e.date),
                        title: String(e.title),
                        type: type,
                        // 有 Emoji 時，icon 只作為後備線條圖示
                        emoji: emoji,
                        icon: iconName(isEmojiValue(e.icon) ? '' : e.icon, dbEventIcon(type)),
                        color: dbIsHexColor(e.color) ? e.color : '',
                        note: e.note || ''
                    };
                });
        },
        emptyRow: function () {
            return {
                id: 'user-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9),
                date: new Date().toISOString().slice(0, 10),
                title: '',
                type: 'exam',
                emoji: '',
                icon: 'clipboard',
                color: '',
                note: ''
            };
        }
    },

    holidays: {
        label: '假期與倒數',
        icon: 'sparkles',
        group: 'db',
        file: 'data/holidays.json',
        pick: 'holidays',
        storageKey: DB_PREFIX + 'holidays',
        array: true,
        kind: 'records',
        fields: DB_FIELD_DEFS.holidays,
        fallback: [],
        normalize: function (list) {
            if (!Array.isArray(list)) return [];
            return list
                .filter(h => h && h.date && h.name)
                .map(h => {
                    const hasEmojiKey = Object.prototype.hasOwnProperty.call(h, 'emoji');
                    // 舊資料可能把 Emoji 塞在 icon 欄，統一搬到 emoji（內容層）
                    const emoji = dbPickEmoji(h.emoji) || dbPickEmoji(h.icon) ||
                        (hasEmojiKey ? '' : dbFestivalEmoji(h.name));
                    return {
                        name: String(h.name),
                        date: String(h.date),
                        endDate: h.endDate ? String(h.endDate) : String(h.date),
                        emoji: emoji,
                        icon: iconName(isEmojiValue(h.icon) ? '' : h.icon, 'sparkles'),
                        note: h.note || ''
                    };
                });
        },
        emptyRow: function () {
            const today = new Date().toISOString().slice(0, 10);
            return { name: '', date: today, endDate: today, emoji: '', icon: 'sparkles', note: '' };
        }
    },

    classes: {
        label: '班級清單',
        icon: 'school',
        group: 'db',
        file: 'data/classes.json',
        pick: null,
        storageKey: 'auth_classes_cache',   // 沿用 auth.js 舊 key
        array: false,
        kind: 'classes',
        fields: DB_FIELD_DEFS.classes,
        fallback: null,
        normalize: function (raw) {
            // 同時接受兩種寫法：{ classes: [...] } 與純陣列 [...]（簡化格式）
            const data = Array.isArray(raw)
                ? { classes: raw }
                : ((raw && typeof raw === 'object') ? raw : {});
            return {
                defaultClassId: data.defaultClassId || '',
                defaultSchedule: data.defaultSchedule || 'data/schedule.json',
                classes: Array.isArray(data.classes)
                    ? data.classes.filter(c => c && c.id && c.name).map(c => ({
                        id: String(c.id),
                        name: String(c.name),
                        // 英文代號統一存大寫，自訂輸入才可以不分大小寫比對
                        code: c.code ? String(c.code).trim().toUpperCase() : '',
                        stage: c.stage || '初中',
                        schedule: c.schedule || null
                    }))
                    : []
            };
        },
        emptyRow: function () {
            return { id: '', name: '', code: '', stage: '初中', schedule: null };
        }
    },

    accounts: {
        label: '用戶帳號',
        icon: 'user',
        group: 'db',
        file: null,                          // 純本機資料，無靜態檔
        pick: null,
        storageKey: 'auth_accounts',
        array: true,
        kind: 'accounts',
        fields: DB_FIELD_DEFS.accounts,
        fallback: [],
        normalize: function (list) {
            return Array.isArray(list) ? list.filter(a => a && a.id) : [];
        },
        emptyRow: function () {
            return { id: 'acc_' + Date.now().toString(16), name: '', email: '', provider: 'local',
                     classId: '', className: '' };
        }
    }
};

// ================= DB 本體 =================

const DB = {
    _defs: {},
    _cache: {},
    _loaded: {},
    _inflight: {},
    _listeners: {},
    _lastError: {},
    _source: {},

    /* ---------- 描述註冊 ---------- */

    // 註冊（或覆寫）一個集合描述；回傳正規化後嘅描述
    define: function (name, def) {
        const merged = Object.assign({}, def);
        merged.name = name;
        merged.storageKey = merged.storageKey || (DB_PREFIX + name.replace(/[^a-zA-Z0-9_-]/g, '_'));
        merged.array = merged.array !== false;
        this._defs[name] = merged;
        return merged;
    },

    def: function (name) {
        return this._defs[name] || null;
    },

    // 已註冊嘅集合名稱（可按 group 過濾）
    list: function (group) {
        return Object.keys(this._defs)
            .filter(name => !group || this._defs[name].group === group)
            .map(name => this._defs[name]);
    },

    /* ---------- 讀取 ---------- */

    // 同步讀：只回傳已經載入嘅記憶體版本（未載入＝undefined）
    get: function (name) {
        return this._cache[name];
    },

    isLoaded: function (name) {
        return this._loaded[name] === true;
    },

    // localStorage 有無覆寫版本
    isOverridden: function (name) {
        const def = this.def(name);
        if (!def) return false;
        try {
            return localStorage.getItem(def.storageKey) !== null;
        } catch (e) {
            return false;
        }
    },

    // 由 localStorage 直接讀（唔理記憶體快取），主要供面板顯示狀態
    readStored: function (name) {
        const def = this.def(name);
        if (!def) return null;
        try {
            const raw = localStorage.getItem(def.storageKey);
            return raw === null ? null : JSON.parse(raw);
        } catch (e) {
            return null;
        }
    },

    // 丟棄某個集合嘅 localStorage 覆寫版本（連記憶體快取一齊清），令靜態檔重新生效
    clearOverride: function (name) {
        const def = this.def(name);
        if (!def) return false;
        try {
            localStorage.removeItem(def.storageKey);
        } catch (e) {
            return false;
        }
        delete this._cache[name];
        delete this._loaded[name];
        delete this._inflight[name];
        this._source = this._source || {};
        delete this._source[name];
        return true;
    },

    /**
     * 載入一個集合。
     * options.force = true 時無視記憶體快取重新讀（重置、外部改動後用）。
     * 回傳 Promise<資料>。
     */
    load: function (name, options) {
        const opts = options || {};
        const self = this;
        const def = this.def(name);

        if (!def) return Promise.reject(new Error('DB 未註冊集合：' + name));
        if (this._loaded[name] && !opts.force) return Promise.resolve(this._cache[name]);
        if (this._inflight[name] && !opts.force) return this._inflight[name];

        const task = (async function () {
            const apply = function (raw, source) {
                const value = def.normalize ? def.normalize(raw) : raw;
                self._cache[name] = value;
                self._loaded[name] = true;
                self._lastError[name] = source === 'fallback' ? (self._lastError[name] || '') : '';
                self._source = self._source || {};
                self._source[name] = source;
                return value;
            };

            // 1) localStorage（最新修改）
            const stored = self.readStored(name);
            if (stored !== null && stored !== undefined) {
                return apply(stored, 'local');
            }

            // 2) 靜態 .json 檔案
            if (def.file) {
                try {
                    // 加 ?v=<APP_VERSION> 做 cache-buster：即使瀏覽器／CDN 仍然留住舊 JSON，
                    // 都要重新抓一次，避免新版 classes.json 被舊快取蓋住。
                    const base = (typeof appUrl === 'function') ? appUrl(def.file) : def.file;
                    const url = base + (base.indexOf('?') === -1 ? '?' : '&') + 'v=' + APP_VERSION;
                    const response = await fetch(url, { cache: 'no-store' });
                    if (response.ok) {
                        const json = await response.json();
                        const raw = def.pick ? json[def.pick] : json;
                        if (raw !== undefined && raw !== null) return apply(raw, 'file');
                    } else {
                        self._lastError[name] = 'HTTP ' + response.status;
                    }
                } catch (e) {
                    self._lastError[name] = e && e.message ? e.message : String(e);
                    console.warn('[DB] 讀取靜態檔失敗：' + name, e);
                }
            }

            // 3) 內建備援值
            return apply(def.fallback !== undefined ? def.fallback : (def.array ? [] : {}), 'fallback');
        })();

        this._inflight[name] = task.then(
            value => { delete self._inflight[name]; return value; },
            error => { delete self._inflight[name]; throw error; }
        );
        return this._inflight[name];
    },

    // 一次過載入多個集合
    loadAll: async function (names) {
        const list = names || this.list().map(d => d.name);
        const results = {};
        for (const name of list) {
            try {
                results[name] = await this.load(name);
            } catch (e) {
                console.warn('[DB] 載入失敗：' + name, e);
                results[name] = this.get(name);
            }
        }
        return results;
    },

    // 資料由邊度嚟：'local' | 'file' | 'fallback'
    source: function (name) {
        return this._source ? this._source[name] : undefined;
    },

    lastError: function (name) {
        return this._lastError[name] || '';
    },

    /* ---------- 寫入 ---------- */

    /**
     * 寫入並持久化（＝開發者面板嘅「保存並套用」）。
     * 只寫 localStorage，唔會改伺服器上嘅 .json。
     */
    set: function (name, value, options) {
        const opts = options || {};
        const def = this.def(name);
        if (!def) return false;

        const normalized = def.normalize ? def.normalize(value) : value;
        this._cache[name] = normalized;
        this._loaded[name] = true;

        if (!opts.silent) {
            try {
                localStorage.setItem(def.storageKey, JSON.stringify(normalized));
                if (this._source) this._source[name] = 'local';
            } catch (e) {
                console.error('[DB] 寫入 localStorage 失敗：' + name, e);
                return false;
            }
        }

        if (!opts.quiet) this.notify(name, { action: opts.action || 'set' });
        return true;
    },

    // 只更新記憶體，唔寫 localStorage（面板預覽用）
    setMemory: function (name, value) {
        const def = this.def(name);
        if (!def) return false;
        this._cache[name] = def.normalize ? def.normalize(value) : value;
        this._loaded[name] = true;
        return true;
    },

    // 刪除 localStorage 覆寫，令下次載入回到靜態檔預設值
    clearOverride: function (name) {
        const def = this.def(name);
        if (!def) return false;
        try {
            localStorage.removeItem(def.storageKey);
        } catch (e) {
            return false;
        }
        delete this._cache[name];
        delete this._loaded[name];
        delete this._inflight[name];
        return true;
    },

    // 重置單一集合 → 立即重新讀回靜態檔預設值
    reset: async function (name) {
        this.clearOverride(name);
        const value = await this.load(name, { force: true });
        this.notify(name, { action: 'reset' });
        return value;
    },

    /**
     * 重置全部「有靜態檔」嘅集合。
     * 預設唔會清帳號（accounts 係純本機資料，清咗就無得救）。
     */
    resetAll: async function (options) {
        const opts = options || {};
        const names = this.list().map(d => d.name).filter(name => {
            const def = this.def(name);
            if (!def.file) return opts.includeLocal === true;
            return true;
        });

        for (const name of names) this.clearOverride(name);
        for (const name of names) {
            try { await this.load(name, { force: true }); } catch (e) { /* ignore */ }
            this.notify(name, { action: 'reset' });
        }
        return names;
    },

    /* ---------- 匯出 / 匯入 ---------- */

    exportObject: function (names) {
        // 預設匯出「所有」已註冊集合（含各班課表）
        const target = names || Object.keys(this._defs);
        const out = {
            _app: 'my-schedule',
            _version: APP_VERSION,
            _exportedAt: new Date().toISOString(),
            collections: {}
        };
        target.forEach(name => {
            out.collections[name] = this.get(name);
        });
        return out;
    },

    exportJson: function (names) {
        return JSON.stringify(this.exportObject(names), null, 4);
    },

    /**
     * 匯入：接受 { collections: {...} } 或者直接 { events: [...], holidays: [...] }。
     * 回傳 { ok, applied:[], skipped:[] }。
     */
    importObject: function (payload, options) {
        const opts = options || {};
        const source = (payload && payload.collections) ? payload.collections : payload;
        const applied = [];
        const skipped = [];

        if (!source || typeof source !== 'object') {
            return { ok: false, error: '匯入內容唔係有效嘅 JSON 物件', applied, skipped };
        }

        Object.keys(source).forEach(name => {
            if (name.charAt(0) === '_') return;
            if (!this.def(name)) { skipped.push(name); return; }
            try {
                this.set(name, source[name], { action: 'import', quiet: true });
                applied.push(name);
            } catch (e) {
                skipped.push(name);
            }
        });

        if (!opts.quiet) {
            applied.forEach(name => this.notify(name, { action: 'import' }));
        }
        return { ok: applied.length > 0, applied, skipped };
    },

    /* ---------- 訂閱（Hot Reload 用） ---------- */

    subscribe: function (name, handler) {
        if (typeof handler !== 'function') return function () {};
        if (!this._listeners[name]) this._listeners[name] = [];
        this._listeners[name].push(handler);
        return () => this.unsubscribe(name, handler);
    },

    unsubscribe: function (name, handler) {
        const list = this._listeners[name];
        if (!list) return;
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
    },

    /**
     * 通知畫面重新渲染（集合名＝null 時通知全部）。
     * 訂閱 '*' 可以接到所有集合嘅改動（detail.name 話你知係邊個）。
     */
    notify: function (name, payload) {
        const detail = Object.assign({ name: name }, payload || {});
        const keys = name ? [name, '*'] : Object.keys(this._listeners);
        keys.forEach(key => {
            (this._listeners[key] || []).slice().forEach(fn => {
                try {
                    fn(name ? this.get(name) : undefined, detail);
                } catch (e) {
                    console.error('[DB] 監聽器出錯：' + key, e);
                }
            });
        });
    }
};

// 掛上基礎集合
Object.keys(DB_BASE_DEFS).forEach(name => DB.define(name, DB_BASE_DEFS[name]));

/* ================= 課表集合（依班級動態註冊） ================= */

function dbScheduleName(classId) {
    return 'schedule:' + (classId || 'default');
}

function dbScheduleLabel(classId, className) {
    if (className) return className + ' 課表';
    return classId ? classId + ' 課表' : '預設課表';
}

/**
 * 註冊（或更新）某個班級嘅課表集合。
 * file = null／'' 時退回預設課表檔案。
 */
function dbRegisterSchedule(classId, file, label) {
    const name = dbScheduleName(classId);
    const def = DB.def(name);
    const path = file || 'data/schedule.json';

    if (def && def.file === path && def.label === (label || def.label)) return def;

    return DB.define(name, {
        label: label || dbScheduleLabel(classId),
        icon: 'book',
        group: 'schedules',
        file: path,
        pick: null,
        array: false,
        kind: 'schedule',
        classId: classId || '',
        fallback: {},
        normalize: function (raw) {
            const data = (raw && typeof raw === 'object') ? raw : {};
            const out = {};
            DB_SCHEDULE_DAYS.forEach(day => {
                const list = Array.isArray(data[day]) ? data[day] : (Array.isArray(data[String(day)]) ? data[String(day)] : []);
                out[day] = list
                    .filter(item => item && item.subject)
                    .map(item => ({
                        period: Number(item.period) || 0,
                        start: item.start || '',
                        end: item.end || '',
                        subject: String(item.subject),
                        teacher: item.teacher || '',
                        room: item.room || ''
                    }))
                    .sort((a, b) => a.period - b.period);
            });
            return out;
        }
    });
}

// 由班級清單一次過註冊所有班級課表
function dbRegisterAllSchedules(classDoc) {
    const doc = classDoc || DB.get('classes');
    const classes = dbClassArray(doc);
    if (!classes.length) return [];

    const list = [];
    classes.forEach(cls => {
        list.push(dbRegisterSchedule(cls.id, cls.schedule, dbScheduleLabel(cls.id, cls.name)));
    });
    // 預設課表（無專屬檔案的班級都會用這一份）
    list.push(dbRegisterSchedule('default', (doc && doc.defaultSchedule) || 'data/schedule.json', '預設課表'));
    return list;
}

/**
 * 由班級文件取出班級陣列。
 * 同時接受兩種寫法，避免開發者面板（或手改）用簡化格式時整個清單變空：
 *   · { classes: [...] }               ← data/classes.json 正式格式
 *   · [ {...}, {...} ]                 ← 簡化格式（只有 id / name / code）
 */
function dbClassArray(doc) {
    if (Array.isArray(doc)) return doc.filter(item => item && item.id);
    if (doc && Array.isArray(doc.classes)) return doc.classes.filter(item => item && item.id);
    return [];
}

/* ================= 班級清單快取失效 ================= */

/**
 * 防止舊班級清單一直被 localStorage 蓋住。
 *
 * 症狀：UI 出現初一A／初二忠／初二勤 等唔存在於 data/classes.json 嘅班別。
 * 成因：DB 讀取次序係 localStorage → 靜態檔，而舊 session 寫落嘅
 *       auth_classes_cache 會永遠蓋過新版 classes.json。
 *
 * 做法：對照 data/classes.json 嘅 schemaVersion 同上次記錄嘅版本；
 *       唔一致就清掉覆寫版本，令新版班級清單真正生效（只會觸發一次）。
 * 回傳 true 代表今次有清過快取。
 */
async function dbEnsureClassesSchema() {
    let remoteVersion = null;

    try {
        const base = (typeof appUrl === 'function') ? appUrl('data/classes.json') : 'data/classes.json';
        const response = await fetch(base + '?v=' + APP_VERSION, { cache: 'no-store' });
        if (response.ok) {
            const json = await response.json();
            if (json && typeof json.schemaVersion === 'number') remoteVersion = json.schemaVersion;
        }
    } catch (e) {
        console.warn('[DB] 檢查班級清單版本失敗:', e);
    }

    // 讀唔到 classes.json（離線又冇 SW 快取）→ 唔應該亂清，
    // 否則會誤刪用家自己改過嘅班級設定。等下次連得上再判斷。
    if (remoteVersion === null) return false;

    let seen = null;
    try {
        const raw = localStorage.getItem(DB_CLASSES_SCHEMA_KEY);
        seen = (raw === null || raw === '') ? null : Number(raw);
    } catch (e) {
        seen = null;
    }

    if (seen === remoteVersion) return false;

    // 版本唔一致 → 丟棄舊覆寫，回到 data/classes.json
    DB.clearOverride('classes');
    try {
        localStorage.setItem(DB_CLASSES_SCHEMA_KEY, String(remoteVersion));
    } catch (e) { /* 私密模式／配額已滿：忽略，清快取本身已經足夠 */ }

    console.log('[DB] 班級清單 schema ' + seen + ' → ' + remoteVersion + '，已清除舊班級快取');
    return true;
}

/* ================= 課表小工具 ================= */

function dbScheduleDayCount(schedule) {
    const data = schedule || {};
    return DB_SCHEDULE_DAYS.reduce((sum, day) => sum + ((data[day] || []).length), 0);
}

function dbScheduleSubjectCount(schedule) {
    const subjects = new Set();
    const data = schedule || {};
    DB_SCHEDULE_DAYS.forEach(day => {
        (data[day] || []).forEach(item => { if (item.subject) subjects.add(item.subject); });
    });
    return subjects.size;
}

// 深拷貝（面板改草稿時用，避免未儲存就污染 DB）
function dbClone(value) {
    if (value === undefined || value === null) return value;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (e) {
        return value;
    }
}
