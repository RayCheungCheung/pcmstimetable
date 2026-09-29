// ================= 天氣專用「立體質感」圖示組（內嵌 SVG） =================
// 版本 1.0.0
//
// 用途：澳門即時天氣卡（.wx-card__icon，見 weather.js／weather.css）嘅天氣圖示。
//
// ⚠ 點解唔用 Emoji（需求規格第 1 條明文「禁用 Emoji」之外嘅技術原因）：
//   Emoji 嘅外觀由「系統字型」話事 —— ☀️ 喺 iOS、Windows、Android 係
//   三幅完全唔同嘅圖，冇得統一成蘋果氣象嗰種立體感，亦冇得跟主題調色。
//
// ⚠ 點解唔用 PNG：
//   本 App 係可離線嘅單頁應用（Service Worker precache）。一張 PNG 要
//   另外 precache、要為 @2x／@3x 備三個尺寸、仲會多一個 404 風險；
//   SVG 一個檔案就覆蓋所有解像度，而且可以用 CSS 控制大小同透明度。
//
// ⚠ 所有圖示一律 viewBox="0 0 64 64"，由呼叫方指定實際像素尺寸 ——
//   同 icons.js 嘅 icon(name, size) 完全一致嘅做法。
//
// ⚠ 漸變 id 每次呼叫都要唯一：同一頁面可能同時出現兩粒圖示（卡片主圖示
//   ＋ 風球膠囊），id 撞咗第二粒就會借用到第一粒嘅顏色。
//   故有一個單調遞增嘅序號 wxGlyphSeq。

let wxGlyphSeq = 0;

/**
 * 產生一組唯一嘅 id 後綴。
 * ⚠ 一定要喺同一次呼叫內共用同一組 id（唔可以逐個 defs 叫一次），
 *   否則同一個 SVG 內部嘅 fill="url(#…)" 會指去唔存在嘅 id，圖示會變全黑。
 */
function wxGlyphIds() {
    wxGlyphSeq += 1;
    return 'wxg' + wxGlyphSeq;
}

/** 水滴（雨點）：路徑以原點為尖端，方便逐粒 translate + scale */
function wxGlyphDrop(x, y, scale, fill) {
    return '<path transform="translate(' + x + ' ' + y + ') scale(' + scale + ')"' +
        ' d="M0 0c2.7 4.3 5.1 7.1 5.1 9.8a5.1 5.1 0 0 1-10.2 0C0 7.1 2.4 4.3 0 0z"' +
        ' fill="' + fill + '"/>';
}

/** 雲朵本體：三圓一底，全部用同一個 userSpaceOnUse 漸變（否則接縫會有色階） */
function wxGlyphCloud(fill, extra) {
    return '<g' + (extra || '') + '>' +
        '<circle cx="21" cy="35" r="12" fill="' + fill + '"/>' +
        '<circle cx="34" cy="27" r="15" fill="' + fill + '"/>' +
        '<circle cx="46" cy="35" r="10" fill="' + fill + '"/>' +
        '<rect x="18" y="34" width="30" height="13" rx="6.5" fill="' + fill + '"/>' +
        // 頂部高光：立體感嘅來源（純裝飾，唔影響辨識）
        '<ellipse cx="30" cy="19" rx="11" ry="4.6" fill="#fff" opacity="0.5"/>' +
        '</g>';
}

/** 共用 defs：雲／雨／太陽／閃電／風球嘅漸變，全部 userSpaceOnUse */
function wxGlyphDefs(id, set) {
    const out = [];
    out.push('<defs>');
    if (set.cloud) {
        out.push('<linearGradient id="' + id + 'c" gradientUnits="userSpaceOnUse"' +
            ' x1="14" y1="16" x2="50" y2="48">' +
            '<stop offset="0" stop-color="#FFFFFF"/>' +
            '<stop offset="0.55" stop-color="#EAF1F8"/>' +
            '<stop offset="1" stop-color="#C3D3E4"/>' +
            '</linearGradient>');
    }
    if (set.sun) {
        out.push('<radialGradient id="' + id + 's" gradientUnits="userSpaceOnUse"' +
            ' cx="22" cy="20" r="20">' +
            '<stop offset="0" stop-color="#FFF6C2"/>' +
            '<stop offset="0.5" stop-color="#FFD54F"/>' +
            '<stop offset="1" stop-color="#FF9F0A"/>' +
            '</radialGradient>');
    }
    if (set.rain) {
        out.push('<linearGradient id="' + id + 'r" gradientUnits="userSpaceOnUse"' +
            ' x1="18" y1="40" x2="46" y2="60">' +
            '<stop offset="0" stop-color="#7FD8FF"/>' +
            '<stop offset="1" stop-color="#0A84FF"/>' +
            '</linearGradient>');
    }
    if (set.bolt) {
        out.push('<linearGradient id="' + id + 'b" gradientUnits="userSpaceOnUse"' +
            ' x1="24" y1="30" x2="42" y2="58">' +
            '<stop offset="0" stop-color="#FFE066"/>' +
            '<stop offset="1" stop-color="#FF9500"/>' +
            '</linearGradient>');
    }
    if (set.wind) {
        out.push('<linearGradient id="' + id + 'w" gradientUnits="userSpaceOnUse"' +
            ' x1="10" y1="10" x2="54" y2="54">' +
            '<stop offset="0" stop-color="#9BD0FF"/>' +
            '<stop offset="1" stop-color="#3E6FA8"/>' +
            '</linearGradient>');
    }
    if (set.alert) {
        out.push('<linearGradient id="' + id + 'a" gradientUnits="userSpaceOnUse"' +
            ' x1="12" y1="10" x2="52" y2="56">' +
            '<stop offset="0" stop-color="#FFE066"/>' +
            '<stop offset="1" stop-color="#FF9F0A"/>' +
            '</linearGradient>');
    }
    out.push('</defs>');
    return out.join('');
}

// ---------- 圖示本體 ----------
// 每個 key 對應一個 function(id) → SVG 內容字串
const WX_GLYPH_BODY = {
    // ☀️ 晴：立體太陽球 + 八道柔光
    sun: function (id) {
        let rays = '';
        for (let i = 0; i < 8; i++) {
            rays += '<rect x="31" y="4" width="2.6" height="7" rx="1.3" fill="url(#' + id + 's)"' +
                ' opacity="0.85" transform="rotate(' + (i * 45) + ' 32 32)"/>';
        }
        return rays +
            '<circle cx="32" cy="32" r="15" fill="url(#' + id + 's)"/>' +
            '<ellipse cx="26" cy="25" rx="6" ry="4" fill="#fff" opacity="0.45"' +
            ' transform="rotate(-28 26 25)"/>';
    },
    // ⛅ 晴間多雲：太陽退到雲後
    partly: function (id) {
        return '<circle cx="41" cy="21" r="11" fill="url(#' + id + 's)"/>' +
            wxGlyphCloud('url(#' + id + 'c)');
    },
    // ☁️ 多雲／密雲
    cloud: function (id) {
        return wxGlyphCloud('url(#' + id + 'c)', ' transform="translate(-2 -2)"');
    },
    // 🌦️ 有驟雨：太陽 + 雲 + 兩粒雨
    shower: function (id) {
        return '<circle cx="44" cy="19" r="10" fill="url(#' + id + 's)"/>' +
            wxGlyphCloud('url(#' + id + 'c)', ' transform="translate(-3 -3) scale(0.94)"') +
            wxGlyphDrop(26, 47, 1, 'url(#' + id + 'r)') +
            wxGlyphDrop(39, 47, 1.15, 'url(#' + id + 'r)');
    },
    // 🌧️ 有大雨：雲 + 三粒雨
    rain: function (id) {
        return wxGlyphCloud('url(#' + id + 'c)', ' transform="translate(0 -5)"') +
            wxGlyphDrop(22, 43, 1, 'url(#' + id + 'r)') +
            wxGlyphDrop(33, 43, 1.2, 'url(#' + id + 'r)') +
            wxGlyphDrop(44, 43, 1, 'url(#' + id + 'r)');
    },
    // ⛈️ 雷暴：雲 + 閃電
    storm: function (id) {
        return wxGlyphCloud('url(#' + id + 'c)', ' transform="translate(0 -6)"') +
            '<path d="M35 36l-11 17h8l-3.5 11L41 45h-8l2.6-9z" fill="url(#' + id + 'b)"/>';
    },
    // 🌫️ 煙霞／霧：雲 + 橫向氣流線
    mist: function (id) {
        return wxGlyphCloud('url(#' + id + 'c)', ' transform="translate(0 -7)"') +
            '<g stroke="url(#' + id + 'c)" stroke-width="4" stroke-linecap="round" opacity="0.85">' +
            '<path d="M14 46h30"/><path d="M20 55h22"/></g>';
    },
    // 🌪️ 熱帶氣旋：雙臂螺旋 + 風眼
    typhoon: function (id) {
        return '<g fill="none" stroke="url(#' + id + 'w)" stroke-width="7" stroke-linecap="round">' +
            '<path d="M32 9a23 23 0 0 1 20 11.5"/>' +
            '<path d="M32 55a23 23 0 0 1-20-11.5"/>' +
            '</g>' +
            '<circle cx="32" cy="32" r="6.5" fill="url(#' + id + 'w)"/>';
    },
    // 一般警告（雷暴／風暴潮／季候風…）：立體警告三角
    alert: function (id) {
        return '<path d="M32 8l24 42a5 5 0 0 1-4.3 7.5H12.3A5 5 0 0 1 8 50z"' +
            ' fill="url(#' + id + 'a)" stroke="#fff" stroke-width="2.5" stroke-linejoin="round" opacity="0.96"/>' +
            '<rect x="29.4" y="22" width="5.2" height="17" rx="2.6" fill="#fff"/>' +
            '<circle cx="32" cy="46" r="3.1" fill="#fff"/>';
    }
};

// 每個 key 需要邊幾個漸變
const WX_GLYPH_DEFS = {
    sun: { sun: 1 },
    partly: { sun: 1, cloud: 1 },
    cloud: { cloud: 1 },
    shower: { sun: 1, cloud: 1, rain: 1 },
    rain: { cloud: 1, rain: 1 },
    storm: { cloud: 1, bolt: 1 },
    mist: { cloud: 1 },
    typhoon: { wind: 1 },
    alert: { alert: 1 }
};

// 對外別名：語意 key → 圖示 key（weather.js 只會用左邊嗰組）
const WX_GLYPH_ALIAS = {
    clear: 'sun',
    sunny: 'sun',
    cloudy: 'cloud',
    overcast: 'cloud',
    drizzle: 'shower',
    showers: 'shower',
    heavyrain: 'rain',
    thunder: 'storm',
    fog: 'mist',
    haze: 'mist',
    cyclone: 'typhoon',
    warning: 'alert'
};

/**
 * 產生一粒天氣圖示（SVG 字串）。
 * @param {string} key  圖示 key（見 WX_GLYPH_BODY／WX_GLYPH_ALIAS）
 * @param {number} size 像素尺寸（預設 30）
 * @returns {string} SVG 標記；key 唔存在時回退去 partly（唔會回空字串 ——
 *   卡片左邊留一個空洞比畫錯圖更難睇得出係 bug）
 */
function weatherGlyph(key, size) {
    const px = Math.max(12, Math.round(Number(size) || 30));
    const name = WX_GLYPH_ALIAS[key] || key;
    const body = WX_GLYPH_BODY[name] || WX_GLYPH_BODY.partly;
    const defs = WX_GLYPH_DEFS[name] || WX_GLYPH_DEFS.partly;
    const id = wxGlyphIds();
    return '<svg class="wx-glyph" viewBox="0 0 64 64" width="' + px + '" height="' + px + '"' +
        ' role="img" aria-hidden="true" focusable="false">' +
        wxGlyphDefs(id, defs) + body(id) + '</svg>';
}

/** 由天氣短標籤攞圖示 key（睇 weather.js 嘅 WX_DESC_RULES） */
function weatherGlyphKeyOf(short) {
    return short && short.glyph ? short.glyph : 'partly';
}
