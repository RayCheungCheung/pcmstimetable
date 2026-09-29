// ================= 澳門即時天氣與惡劣天氣警示卡 =================
// 版本 1.1.0
//
// 定位：個人中心首頁最頂嗰張全寬卡（原本係「下個假期倒數」）。
// 資料源：澳門地球物理暨氣象局（SMG）官方 Open Data（免 Key、免註冊）。
//
// ⚠⚠ 需求原文寫嘅兩個網址，其中一個喺瀏覽器入面係抓唔到嘅，必須知道原因：
//   1. 實時天氣
//      需求：https://xml.smg.gov.mo/c_actualweather.xml
//      實測：該主機「完全冇」Access-Control-Allow-Origin，
//            連帶 Origin 一齊請求都唔會回 —— 瀏覽器會直接以 CORS 錯誤擋死，
//            程式碼寫得再對都只會見到「暫無資料」。
//      解法：同一份檔案喺 www.smg.gov.mo 有鏡像，而且回 ACAO: *，
//            故清單以 www 主機行先，xml 主機留作後備
//            （將來對方補上 CORS、或者 App 包成原生殼時會自動用得着）。
//   2. 特別天氣警告
//      需求：https://www.smg.gov.mo/smg/xml/specInfo.xml
//      實測：回 ACAO: *，可以直連，照用。
//            ⚠ 但 specInfo.xml 係「特別天氣信息」通報，唔係風球／暴雨嘅
//              正式 feed —— 冇警告喺身嘅時候，個檔係 Inforce=0 嘅空殼，
//              風球編號根本冇地方可以讀。所以本模組另外接上兩條正式 feed：
//              c_typhoon.xml（熱帶氣旋／風球）、c_rainstorm.xml（暴雨警告），
//              specInfo.xml 保留做補充來源（三者一齊判，取最嚴重嗰個）。
//
// 卡片五態（data-wx-state）：
//   loading → 開機尚未有數據（首次、且未連過）
//   ok      → 正常天氣
//   warn    → 橙黃警示 Badge（1／3 號風球、暴雨警告等）
//   danger  → 整張紅底警告卡（8／9／10 號風球）
//   error   → 抓唔到資料且冇快取
//
// ⚠ 圖示一律用 SVG（weather-icons.js 嘅 weatherGlyph()），嚴禁 Emoji：
//   需求【UI 排版規格】第 1 條明文「禁用 Emoji」，要嘅係蘋果氣象風嘅立體圖示。
//   Emoji 亦根本做唔到 —— 佢嘅外觀由系統字型話事，三平台三幅圖，
//   冇得統一、冇得跟主題調色。1.0.0 版用 Emoji 嘅寫法已經全部拆走。
//
// 卡片版面對應（1.1.0 起完全對照設計圖）：
//   左：56px 立體天氣圖示（.wx-card__icon）
//   中：22px／700 大溫度（.wx-card__title）＋ 12px 概況·地點·時間（.wx-card__sub）
//   右：iOS 圓角膠囊（.wx-card__pill）—— 正常態顯示氣溫＋濕度；
//       有風球／暴雨警告時「整粒膠囊」換成 ▲ 編號＋方向（紅／橙警示色）。

// ---------- 資料源 ----------
// 實時天氣：用「多個鏡像逐個試」嘅寫法，第一個成功嘅就用
const WX_ACTUAL_URLS = [
    'https://www.smg.gov.mo/smg/xml/c_actualweather.xml',
    'https://xml.smg.gov.mo/c_actualweather.xml'
];
const WX_TYPHOON_URL = 'https://www.smg.gov.mo/smg/xml/c_typhoon.xml';
const WX_RAINSTORM_URL = 'https://www.smg.gov.mo/smg/xml/c_rainstorm.xml';
const WX_SPECINFO_URL = 'https://www.smg.gov.mo/smg/xml/specInfo.xml';
const WX_FORECAST_URL = 'https://www.smg.gov.mo/smg/xml/c_forecast.xml';

// ---------- 時間常數 ----------
const WX_TTL_MS = 10 * 60 * 1000;      // 資料當「新鮮」嘅時限：10 分鐘（SMG 每 10 分鐘更新一次實測）
const WX_MIN_GAP_MS = 60 * 1000;       // 兩次抓取之間嘅最短間隔：防止切前台／重繪時連環撞爆對方伺服器
const WX_TIMEOUT_MS = 8000;            // 單次請求逾時

// 快取：用原生 localStorage（同 theme.js 一樣），刻意唔入 DB 集合 ——
// 呢份純粹係「上次成功抓到嘅天氣」，唔屬於用戶資料，唔應該出現喺
// 儲存空間頁／開發者面板／雲端同步清單入面。
const WX_CACHE_KEY = 'wx_snapshot_v1';

// ---------- 氣象站優先次序 ----------
// 'FM' = 大炮台。SMG《WeatherStationInfo》將 FM / TG / DC 分別標為
// 「澳門 / 氹仔 / 路環」三個地區，所以「澳門實時氣溫」＝ FM。
// 後面幾個係半島其他站，做 FM 讀唔到數時嘅後備。
const WX_STATION_ORDER = ['FM', 'EM', 'DP', 'MM', 'PE'];

// ---------- 狀態 ----------
// wxState.at：上次「至少一個來源成功」嘅時間戳；0 = 從未成功
let wxState = {
    at: 0,
    level: 'loading',
    actual: null,       // { station, tempText, humidity, wind, windDesc, observedAt }
    forecast: null,     // { short }
    warning: null,      // { kind, level, label, glyph, detail, signal, dirEn, dirZh }
    glyph: 'partly',    // 左邊圖示 key（見 weather-icons.js）
    signal: null        // 右邊膠囊要顯示嘅警告標示 { mark, en, zh }；null = 顯示氣溫／濕度
};
let wxFetching = false;
let wxTimer = null;
let wxBound = false;

// ============================================================
// 網絡
// ============================================================

/**
 * 抓一段文字（XML）。
 * ⚠ cache: 'no-store' 係必須：天氣係「即時」資料，任何中間層快取
 *   （瀏覽器 HTTP 快取 / 服務 worker）留住上一輪嘅結果都會令警示延遲。
 *   Service Worker 只攔同源請求，呢兩條跨域 feed 本來就直出網絡，呢個
 *   標頭係防瀏覽器自己嗰層。
 */
function wxFetchText(url) {
    return new Promise((resolve, reject) => {
        if (typeof fetch !== 'function') { reject(new Error('no-fetch')); return; }
        const ac = (typeof AbortController === 'function') ? new AbortController() : null;
        let timer = 0;
        if (ac) timer = setTimeout(() => ac.abort(), WX_TIMEOUT_MS);
        const done = fn => value => {
            if (timer) { clearTimeout(timer); timer = 0; }
            fn(value);
        };
        fetch(url, {
            cache: 'no-store',
            mode: 'cors',
            credentials: 'omit',
            headers: { 'Accept': 'application/xml, text/xml, */*' },
            signal: ac ? ac.signal : undefined
        })
            .then(res => {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.text();
            })
            .then(done(resolve))
            .catch(done(reject));
    });
}

/** 逐個鏡像試，回第一個成功嘅文字；全部失敗就 reject */
function wxFetchFirst(urls) {
    let i = 0;
    const next = () => {
        if (i >= urls.length) return Promise.reject(new Error('all-sources-failed'));
        const url = urls[i++];
        return wxFetchText(url).catch(next);
    };
    return next();
}

// ============================================================
// XML 解析小工具
// ============================================================

/**
 * 解析 XML 字串。
 * ⚠ DOMParser 解析失敗「唔會」throw —— 佢會回一份含 <parsererror> 嘅文件，
 *   唔自己檢查就會將「SMG 換咗做維護頁」當成「冇警告」靜靜報平安。
 */
function wxParseXml(text) {
    if (typeof text !== 'string' || text.indexOf('<') < 0) return null;
    if (typeof DOMParser !== 'function') return null;
    let doc = null;
    try { doc = new DOMParser().parseFromString(text, 'text/xml'); } catch (e) { return null; }
    if (!doc || !doc.documentElement) return null;
    const bad = doc.getElementsByTagName('parsererror');
    if (bad && bad.length) return null;
    return doc;
}

/** 節點清單轉真陣列（XML 係 live collection，slice 完先好放心迭代） */
function wxTags(node, tag) {
    if (!node || !node.getElementsByTagName || !tag) return [];
    const list = node.getElementsByTagName(tag);
    return list ? Array.prototype.slice.call(list) : [];
}

/** 節點文字：壓平所有空白（XML 有縮排換行，唔壓平會出現一堆怪空白） */
function wxNodeText(node) {
    if (!node) return '';
    return String(node.textContent == null ? '' : node.textContent).replace(/\s+/g, ' ').trim();
}

/** 取子節點文字（同名多個時取第一個） */
function wxChildText(node, tag) {
    const list = wxTags(node, tag);
    return list.length ? wxNodeText(list[0]) : '';
}

/**
 * SMG 嘅量測節點係包住一層嘅：
 *   <Temperature><MeasureUnit>°C</MeasureUnit><Type>3</Type><Value>33</Value><dValue>32.8</dValue></Temperature>
 * ⚠ 唔可以直接 parseFloat(節點.textContent) —— 咁會變成 "%36565" 之類嘅垃圾。
 *   dValue 係實測值（一位小數），Value 係整數，前者優先。
 */
function wxMeasure(node, tag) {
    const list = wxTags(node, tag);
    if (!list.length) return null;
    const d = parseFloat(wxChildText(list[0], 'dValue'));
    if (isFinite(d)) return d;
    const v = parseFloat(wxChildText(list[0], 'Value'));
    return isFinite(v) ? v : null;
}

/** 取 XML 屬性 */
function wxAttr(node, name) {
    if (!node || !node.getAttribute) return '';
    return String(node.getAttribute(name) || '').trim();
}

/**
 * Inforce：SMG 各條 feed 一律用 '0' 表示「未生效」。
 * ⚠ 唔可以用 truthy 判斷：'0' 係非空字串，係 truthy ——
 *   直接 `if (inforce)` 會將「冇警告」誤判成「有警告」。
 */
function wxInforce(value) {
    const v = String(value == null ? '' : value).trim().toLowerCase();
    if (!v) return false;
    return v !== '0' && v !== 'false' && v !== 'no' && v !== 'nil';
}

/** 多語言節點（<Event><Chinese>3號風球</Chinese><Portuguese>…</Portuguese></Event>）優先取中文 */
function wxChineseOf(node, tag) {
    const list = wxTags(node, tag);
    if (!list.length) return '';
    const zh = wxTags(list[0], 'Chinese');
    return zh.length ? wxNodeText(zh[0]) : wxNodeText(list[0]);
}

// ============================================================
// 各條 feed 嘅解析
// ============================================================

/** 實時氣象站數據 → { station, tempText, humidity, wind, windDesc, observedAt } */
function wxParseActual(text) {
    const doc = wxParseXml(text);
    if (!doc) return null;
    const stations = wxTags(doc, 'station');
    if (!stations.length) return null;

    const pickByCode = code => {
        for (let i = 0; i < stations.length; i++) {
            if (wxAttr(stations[i], 'code').toUpperCase() !== code) continue;
            if (wxMeasure(stations[i], 'Temperature') !== null) return stations[i];
        }
        return null;
    };

    let picked = null;
    for (let i = 0; i < WX_STATION_ORDER.length && !picked; i++) picked = pickByCode(WX_STATION_ORDER[i]);
    if (!picked) {
        for (let i = 0; i < stations.length && !picked; i++) {
            if (wxMeasure(stations[i], 'Temperature') !== null) picked = stations[i];
        }
    }
    if (!picked) return null;

    const temp = wxMeasure(picked, 'Temperature');
    if (temp === null) return null;

    const humidity = wxMeasure(picked, 'Humidity');
    const wind = wxMeasure(picked, 'WindSpeed');
    const windDesc = wxChildText(picked, 'WindDescription');

    return {
        station: wxChildText(picked, 'stationname') || wxAttr(picked, 'code') || '澳門',
        tempText: String(Math.round(temp)),
        humidity: humidity === null ? null : Math.round(humidity),
        wind: wind === null ? null : Math.round(wind),
        windDesc: windDesc,
        observedAt: wxClock(wxChildText(picked, 'RecordTime')) || wxClock(wxChildText(doc, 'SysPubdate'))
    };
}

/** '2026-09-29 12:35' → '12:35'（卡片位置有限，只顯示時分） */
function wxClock(stamp) {
    const m = String(stamp || '').match(/(\d{1,2}):(\d{2})/);
    return m ? (m[1].length < 2 ? '0' + m[1] : m[1]) + ':' + m[2] : '';
}

/** 今日天氣描述：只取 <WeatherDescription> 第一段（＝今日）嘅短標籤 */
function wxParseForecast(text) {
    const doc = wxParseXml(text);
    if (!doc) return null;
    const raw = wxChildText(doc.documentElement, 'WeatherDescription');
    if (!raw) return null;
    return { short: wxShortDesc(raw) };
}

// 天氣關鍵詞 → 短標籤 / 圖示 key。
// ⚠ 次序有意義：一定要由「最嚴重」排到「最輕微」，
//   因為 SMG 嘅描述係一段過（例：「天晴，部份時間多雲。」），
//   亂序會將有雷暴嘅日子報成「天晴」。
// glyph 對應 weather-icons.js 嘅 WX_GLYPH_BODY key。
const WX_DESC_RULES = [
    { re: /雷|thunder/i, label: '有雷暴', glyph: 'storm' },
    { re: /暴雨|大雨|豪雨/, label: '有大雨', glyph: 'rain' },
    { re: /雨|驟雨|陣雨/, label: '有驟雨', glyph: 'shower' },
    { re: /密雲|陰/, label: '密雲', glyph: 'cloud' },
    { re: /煙霞|霧/, label: '有煙霞', glyph: 'mist' },
    { re: /多雲/, label: '多雲', glyph: 'cloud' },
    { re: /晴/, label: '天晴', glyph: 'sun' }
];

/** 由一整段預報文字抽出最短而準確嘅標籤（逐行掃，回第一個命中嘅規則） */
function wxShortDesc(text) {
    const lines = String(text || '').split(/[\r\n]+/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/\s/g, '');
        if (!line) continue;
        for (let j = 0; j < WX_DESC_RULES.length; j++) {
            if (WX_DESC_RULES[j].re.test(line)) {
                // 「天晴，部份時間多雲」→ 兩個標籤都命中，合併講先唔會失真
                if (WX_DESC_RULES[j].label === '多雲' && /晴/.test(line)) {
                    return { label: '晴間多雲', glyph: 'partly' };
                }
                return { label: WX_DESC_RULES[j].label, glyph: WX_DESC_RULES[j].glyph };
            }
        }
    }
    return null;
}

/** 由天氣描述短標籤查圖示 key（冇標籤時回 null，由呼叫方決定後備） */
function wxWeatherGlyph(short) {
    return short && short.glyph ? short.glyph : null;
}

// 風球編號：「10」一定要排喺「1」前面，否則 '10號風球' 會被當成 1 號
const WX_TYPHOON_PATTERNS = [
    { signal: 10, re: /10\s*號|十號|tc\s*10|t10/i },
    { signal: 9, re: /9\s*號|九號|tc\s*9|t9/i },
    { signal: 8, re: /8\s*號|八號|tc\s*8|t8/i },
    { signal: 3, re: /3\s*號|三號|tc\s*3|t3/i },
    { signal: 1, re: /1\s*號|一號|tc\s*1|t1/i }
];

/**
 * 由一段文字判斷風球編號（0 = 唔係風球）。
 * ⚠ 唔靠單一欄位：SMG 嘅 Warncode / Status / Description 邊個有料用邊個，
 *   三個一齊丟入嚟判 —— 佢改欄位格式時唔會即刻整壞成張卡。
 */
function wxTyphoonSignal(text) {
    const s = String(text || '');
    if (!s) return 0;
    for (let i = 0; i < WX_TYPHOON_PATTERNS.length; i++) {
        if (WX_TYPHOON_PATTERNS[i].re.test(s)) return WX_TYPHOON_PATTERNS[i].signal;
    }
    return 0;
}

// 風球方向。
// ⚠ 次序有意義：「東北」一定要排喺「東」前面，否則「八號東北風球」
//   會被當成「東」；同理「西南」要排喺「西」前面。
// ⚠ SMG 嘅 Warncode 用英文簡寫（例：TC8NE ／ TC8NW），Description 用中文，
//   兩個都要判 —— 邊個有料用邊個。
const WX_DIRECTIONS = [
    { re: /東北|northeast|\bNE\b/i, en: 'NE', zh: '東北' },
    { re: /西北|northwest|\bNW\b/i, en: 'NW', zh: '西北' },
    { re: /東南|southeast|\bSE\b/i, en: 'SE', zh: '東南' },
    { re: /西南|southwest|\bSW\b/i, en: 'SW', zh: '西南' },
    { re: /偏東|\bE\b/i, en: 'E', zh: '東' },
    { re: /偏西|\bW\b/i, en: 'W', zh: '西' }
];

/** 由風球文字（Warncode + Description）抽方向 → { en, zh }；判唔到回 null */
function wxTyphoonDir(raw) {
    const s = String(raw || '');
    if (!s) return null;
    for (let i = 0; i < WX_DIRECTIONS.length; i++) {
        if (WX_DIRECTIONS[i].re.test(s)) return { en: WX_DIRECTIONS[i].en, zh: WX_DIRECTIONS[i].zh };
    }
    return null;
}

/** 熱帶氣旋 feed → 風球警告物件 */
function wxParseTyphoon(text) {
    const doc = wxParseXml(text);
    if (!doc) return null;
    const node = wxTags(doc, 'TropicalCyclone')[0];
    if (!node) return null;
    if (!wxInforce(wxChildText(node, 'Inforce'))) return null;

    const desc = wxChildText(node, 'Description') || wxChildText(node, 'Major');
    const code = wxChildText(node, 'Warncode');
    const signal = wxTyphoonSignal([
        wxChildText(node, 'Status'),
        code,
        wxChildText(node, 'Major'),
        desc
    ].join(' '));

    const dir = wxTyphoonDir(code + ' ' + desc);

    if (!signal) {
        // 生效但讀唔到編號：唔可以當冇事，照樣報，只係冇編號
        if (!desc) return null;
        return wxTyphoonWarning(0, desc, dir);
    }
    return wxTyphoonWarning(signal, desc, dir);
}

/**
 * 依風球編號砌警告物件。
 * ⚠ 8 號或以上 = danger（整張卡轉 iOS 警告紅）；1／3 號 = warn（橙）。
 * @param {number} signal 風球編號（0 = 生效但讀唔到編號）
 * @param {string} detail SMG 原文（放 title 屬性，hover 睇得到）
 * @param {{en:string,zh:string}|null} dir 方向（1／3 號風球冇方向，回 null）
 */
function wxTyphoonWarning(signal, detail, dir) {
    const danger = signal >= 8;
    const named = signal ? signal + '號' : '';
    const dirZh = dir ? dir.zh : '';
    return {
        kind: 'typhoon',
        signal: signal,
        level: danger ? 'danger' : 'warn',
        glyph: 'typhoon',
        dirEn: dir ? dir.en : '',
        dirZh: dirZh,
        // 膠囊大字：有編號顯示編號（設計圖：▲ 8 NW 西北）
        pillMark: signal ? String(signal) : '風球',
        label: named ? named + dirZh + '風球生效中' : '熱帶氣旋警告生效中',
        sub: danger ? '停課及大眾運輸暫停，請注意安全' : '',
        detail: detail || ''
    };
}

/** 暴雨警告文字（黑色 > 紅色 > 黃色 > 普通），唔似暴雨警告就回 null */
function wxRainstormWarning(raw) {
    const s = String(raw || '');
    if (!/暴雨|rainstorm|\brb\b|\bro\b|\bry\b/i.test(s)) return null;
    let level = '';
    let label = '暴雨警告生效中';
    if (/黑|black/i.test(s)) { level = '黑色'; label = '黑色暴雨警告生效中'; }
    else if (/紅|red/i.test(s)) { level = '紅色'; label = '紅色暴雨警告生效中'; }
    else if (/黃|黄|yellow/i.test(s)) { level = '黃色'; label = '黃色暴雨警告生效中'; }
    return {
        kind: 'rainstorm',
        level: 'warn',
        glyph: 'rain',
        label: label,
        // 膠囊：大字「暴雨」＋細字「紅／黑／黃」—— 好過塞成一行長標籤
        pillMark: '暴雨',
        dirEn: '',
        dirZh: level,
        sub: '',
        detail: s
    };
}

/** 暴雨 feed → 警告物件 */
function wxParseRainstorm(text) {
    const doc = wxParseXml(text);
    if (!doc) return null;
    const node = wxTags(doc, 'Rainstorm')[0];
    if (!node) return null;
    if (!wxInforce(wxChildText(node, 'Inforce'))) return null;
    return wxRainstormWarning([
        wxChildText(node, 'Warncode'),
        wxChildText(node, 'Major'),
        wxChildText(node, 'Description')
    ].join(' '));
}

/**
 * 特別天氣信息（specInfo.xml）→ 警告物件（補充來源）。
 * ⚠ 呢個 feed 一則通報可能講幾件事，做法係逐則檢查 Inforce，
 *   再喺文字入面搵「有冇風球／暴雨／其他警告」，取最嚴重嗰個。
 */
function wxParseSpecInfo(text) {
    const doc = wxParseXml(text);
    if (!doc) return null;
    const reports = wxTags(doc, 'SpecialInfoReport');
    let best = null;
    for (let i = 0; i < reports.length; i++) {
        const r = reports[i];
        if (!wxInforce(wxChildText(r, 'Inforce'))) continue;

        const event = wxChineseOf(r, 'Event');
        const title = wxChineseOf(r, 'Title');
        const desc = wxChineseOf(r, 'Description') || wxChildText(r, 'Description');
        const raw = [event, title, desc, wxChildText(r, 'Major')].join(' ');
        if (!raw.replace(/\s/g, '')) continue;

        const signal = wxTyphoonSignal(raw);
        let item = null;
        if (signal) item = wxTyphoonWarning(signal, desc || raw);
        if (!item) item = wxRainstormWarning(raw);
        if (!item && /警告|風球|雷暴|季候風|風暴潮/.test(raw)) {
            // 其他警告（雷暴／風暴潮／季候風…）：膠囊大字用最短嘅關鍵詞，
            // 細字統一寫「警告」—— 塞成一句長標籤落 56px 闊嘅膠囊一定爆。
            const key = /雷暴/.test(raw) ? '雷暴'
                : /風暴潮/.test(raw) ? '風暴潮'
                    : /季候風/.test(raw) ? '季候風'
                        : /大雨|暴雨/.test(raw) ? '大雨' : '警告';
            item = {
                kind: 'other',
                level: 'warn',
                glyph: 'alert',
                label: wxTrim(event || title || '特別天氣信息', 20),
                pillMark: key,
                dirEn: '',
                dirZh: '警告',
                sub: '',
                detail: desc || raw
            };
        }
        if (!item) continue;

        // 同一份文件多則生效通報：danger 優先，其次有風球編號嘅優先
        const score = (item.level === 'danger' ? 2 : 1) * 100 + (item.signal || 0);
        if (!best || score > best.score) best = { score: score, item: item };
    }
    return best ? best.item : null;
}

/** 多來源合併：danger 優先，其次風球編號大者優先 */
function wxPickWarning(list) {
    let best = null;
    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (!item) continue;
        const score = (item.level === 'danger' ? 2 : 1) * 100 + (item.signal || 0);
        if (!best || score > best.score) best = { score: score, item: item };
    }
    return best ? best.item : null;
}

/** 文字截短（卡片一行放唔落長篇通報） */
function wxTrim(text, max) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ============================================================
// 狀態組裝 + 渲染
// ============================================================

/**
 * 由三個來源砌出卡片要顯示嘅欄位（完全對照設計圖）。
 * level 嘅判斷次序（＝需求規格嘅優先級）：
 *   1. 有 8/9/10 號風球  → danger（整張紅底）
 *   2. 有 1/3 號風球、暴雨等 → warn（橙黃膠囊）
 *   3. 有實測天氣        → ok
 *   4. 乜都冇            → error
 *
 * ⚠ 版面分工（1.1.0 起）：左邊永遠係「今日天氣」，右邊膠囊永遠係
 *   「特別天氣報告」。所以危險警告唔會再搶走左邊嘅氣溫大字 ——
 *   警告由右邊膠囊以 ▲ 編號＋方向表達（紅／橙），資訊一項都冇少，
 *   而用戶仍然一眼睇到溫度。呢個係設計圖嘅明確要求。
 */
function wxCompose(actual, forecast, warning) {
    const short = forecast && forecast.short ? forecast.short : null;
    const next = {
        at: Date.now(),
        actual: actual,
        forecast: short ? { label: short.label, glyph: short.glyph } : null,
        warning: warning,
        level: 'error',
        glyph: wxWeatherGlyph(short) || 'partly',
        signal: null,
        title: '暫無資料',
        sub: '天氣資料載入失敗，稍後自動重試',
        pillValue: '—',
        pillMeta: 'SMG'
    };

    if (warning) {
        next.level = warning.level === 'danger' ? 'danger' : 'warn';
        // 右邊膠囊整粒換成警告標示（▲ + 大字 + 方向／級別細字）
        next.signal = {
            mark: warning.pillMark || '警告',
            en: warning.dirEn || '',
            zh: warning.dirZh || ''
        };
        // 只有 danger 態先換走左邊嘅天氣圖示：8 號風球之下「打緊風」
        // 本身就係當日最重要嘅天氣資訊，天氣圖示反而係次要。
        if (next.level === 'danger') next.glyph = warning.glyph || 'typhoon';
    }

    if (actual) {
        next.title = actual.tempText + '°C';
        next.sub = (short ? short.label : '澳門') + ' · ' + actual.station +
            (actual.observedAt ? ' ' + actual.observedAt : '');
        next.pillValue = actual.tempText + '°C';
        next.pillMeta = actual.humidity === null ? 'SMG 實測' : '濕度 ' + actual.humidity + '%';
    } else if (!warning) {
        next.pillValue = '—';
        next.pillMeta = 'SMG';
    } else {
        // 有警告但讀唔到實測：唔好顯示「暫無資料」，改為交代警告本身
        next.title = warning.label || '天氣警告生效中';
        next.sub = '未能讀取實時氣溫，請留意氣象局消息';
    }

    return next;
}

/** 依目前狀態重畫卡片（同步、零網絡；DOM 唔存在就靜靜離開） */
function weatherRenderCard() {
    const card = document.getElementById('wx-card');
    if (!card) return;

    const icon = document.getElementById('wx-icon');
    const title = document.getElementById('wx-title');
    const sub = document.getElementById('wx-sub');
    const pill = document.getElementById('wx-pill');
    const signal = document.getElementById('wx-pill-signal');
    const pillValue = document.getElementById('wx-pill-value');
    const pillMeta = document.getElementById('wx-pill-meta');
    const setText = (id, text) => {
        const node = document.getElementById(id);
        if (node) node.textContent = text;
    };

    card.setAttribute('data-wx-state', wxState.level || 'loading');

    // 左邊天氣圖示：SVG（weather-icons.js），唔係 Emoji。
    // ⚠ typeof 守門唔係多餘：weather-icons.js 係獨立檔案，如果 Service Worker
    //   快取出咗「新 weather.js ＋ 冇 weather-icons.js」嘅半截組合，
    //   呢行會 throw 而令成個渲染中斷 —— 後果係卡片永遠卡喺「載入中…」，
    //   比少一粒圖示嚴重得多。冇圖示時底座留空，文字照樣出。
    if (icon) {
        icon.innerHTML = typeof weatherGlyph === 'function' ? weatherGlyph(wxState.glyph, 36) : '';
    }

    if (title) title.textContent = wxState.title || '—';
    if (sub) sub.textContent = wxState.sub || '';

    // 右邊膠囊：警告態＝整粒換成「▲ 編號＋方向」，正常態＝氣溫＋濕度
    const sig = wxState.signal;
    if (pill && signal) {
        if (sig && (sig.mark || sig.zh)) {
            setText('wx-pill-mark', sig.mark);
            setText('wx-pill-dir-en', sig.en);
            setText('wx-pill-dir-zh', sig.zh);
            signal.removeAttribute('hidden');
            pill.setAttribute('data-wx-pill', 'signal');
            // ▲8 NW 對讀屏器冇意義，補一句完整描述
            pill.setAttribute('aria-label',
                (wxState.warning && wxState.warning.label) || ('特別天氣報告 ' + sig.mark));
        } else {
            signal.setAttribute('hidden', '');
            pill.removeAttribute('data-wx-pill');
            pill.removeAttribute('aria-label');
        }
    }
    if (pillValue) pillValue.textContent = wxState.pillValue || '—';
    if (pillMeta) pillMeta.textContent = wxState.pillMeta || 'SMG';

    // 完整文字（風球通報可以好長）放落 title 屬性，桌面 hover 睇得到
    card.setAttribute('title', wxState.warning && wxState.warning.detail
        ? wxTrim(wxState.warning.detail, 160)
        : (wxState.title || '') + (wxState.sub ? '　' + wxState.sub : ''));
}

// ---------- 快取 ----------
function wxPersist() {
    try {
        localStorage.setItem(WX_CACHE_KEY, JSON.stringify({
            at: wxState.at,
            actual: wxState.actual,
            forecast: wxState.forecast,
            warning: wxState.warning
        }));
    } catch (e) { /* 私密模式／配額滿：純快取，寫唔入唔影響功能 */ }
}

function wxLoadCache() {
    let raw = null;
    try { raw = localStorage.getItem(WX_CACHE_KEY); } catch (e) { return false; }
    if (!raw) return false;
    let saved = null;
    try { saved = JSON.parse(raw); } catch (e) { return false; }
    if (!saved || typeof saved !== 'object') return false;
    if (!saved.actual && !saved.warning) return false;
    const composed = wxCompose(saved.actual || null, saved.forecast ? { short: saved.forecast } : null, saved.warning || null);
    composed.at = Number(saved.at) || 0;
    wxState = composed;
    return true;
}

// ============================================================
// 對外 API
// ============================================================

/**
 * 抓一次並重畫。
 * force=false 時有兩道閘：正在抓 → 直接返回；未過最短間隔 → 直接返回。
 * 兩道閘都係為咗「切前台／重繪」等高頻呼叫唔會撞爆 SMG 伺服器。
 */
function weatherRefresh(force) {
    if (wxFetching) return Promise.resolve(false);
    const now = Date.now();
    if (!force && wxState.at && (now - wxState.at) < WX_MIN_GAP_MS) return Promise.resolve(false);

    wxFetching = true;
    const jobs = [
        wxFetchFirst(WX_ACTUAL_URLS).then(wxParseActual).catch(() => null),
        wxFetchText(WX_TYPHOON_URL).then(wxParseTyphoon).catch(() => null),
        wxFetchText(WX_RAINSTORM_URL).then(wxParseRainstorm).catch(() => null),
        wxFetchText(WX_SPECINFO_URL).then(wxParseSpecInfo).catch(() => null),
        wxFetchText(WX_FORECAST_URL).then(wxParseForecast).catch(() => null)
    ];

    return Promise.all(jobs).then(results => {
        wxFetching = false;
        const actual = results[0];
        const forecast = results[4];
        const warning = wxPickWarning([results[1], results[2], results[3]]);

        // 全部來源都死（離線）：保留上一輪內容，唔好將已有資料抹成「暫無資料」
        if (!actual && !forecast && !warning) {
            if (!wxState.at) {
                wxState.level = 'error';
                weatherRenderCard();
            }
            return false;
        }

        wxState = wxCompose(actual, forecast, warning);
        wxPersist();
        weatherRenderCard();
        return true;
    }).catch(() => {
        // wxCompose 自身出錯嘅最後防線：唔可以令 App 開機流程斷喺呢度
        wxFetching = false;
        return false;
    });
}

/**
 * 開機初始化：先畫快取（零網絡、即時有內容），再背景抓新。
 * 同全 App 一貫嘅「先快後準（stale-while-revalidate）」一致 ——
 * 唔可以令個人中心首屏等一個跨域網絡請求。
 */
function weatherInit() {
    const hadCache = wxLoadCache();
    if (hadCache) weatherRenderCard();

    // 唔 await：開機流程唔應該被天氣拖住
    weatherRefresh(false);

    if (!wxTimer) wxTimer = setInterval(() => { weatherRefresh(false); }, WX_TTL_MS);

    if (!wxBound) {
        wxBound = true;
        // 由背景切返前台：順手更新一次（內建最短間隔閘，唔會連環打）
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) weatherRefresh(false);
        });
        // 重新連上網絡：即刻補一次（用戶拉返 Wi-Fi 之後唔應該等到下個 10 分鐘）
        window.addEventListener('online', () => { weatherRefresh(true); });
    }
}
