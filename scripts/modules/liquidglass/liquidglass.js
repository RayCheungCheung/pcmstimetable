/* ================= Liquid Glass Engine（離線強化版） =================
 *
 * 參考實作：GitHub ybouane/liquidglass
 *   - 同樣的 config 參數名（refraction / chromAberration / edgeHighlight / specular /
 *     fresnel / distortion / cornerRadius / zRadius / opacity / saturation /
 *     tintStrength / brightness / shadowOpacity / shadowSpread / shadowOffsetY）
 *   - 同樣的 API 形狀：LiquidGlass.init({ root, glassElements, defaults })
 *     element.dataset.config = '{"refraction":0.8}'、data-dynamic、
 *     instance.markChanged(el) / instance.destroy()
 *
 * 刻意不同的實作方式（重要，唔係偷懶）：
 *   原版用 WebGL fragment shader + html-to-image 將「root 內部」嘅 DOM 光柵化成貼圖再折射。
 *   但本 App 有兩個硬性限制：
 *     1. 離線 PWA：Service Worker 全量快取，專案註解已明言「唔用任何外部 CDN 庫」。
 *        原版只有 npm / jsdelivr ESM 一種載入方式，離線即失效。
 *     2. 底部 TabBar 要折射嘅係「root（#bottom-nav）以外」嘅頁面內容，
 *        而原版明確規定「root 本身唔會被擷取」，即係話照抄會折射到一片空白，
 *        反而令原本正常嘅 backdrop-filter 玻璃消失。
 *   所以這裡改用瀏覽器原生、可離線嘅等效管線：
 *     backdrop-filter: blur() saturate() url(#SVG filter)
 *       └─ feTurbulence（玻璃厚薄不均）→ feGaussianBlur →
 *          3 次 feDisplacementMap（R/G/B 各自唔同位移 = 真實色散）
 *          → feBlend screen 合成
 *   SVG 濾鏡直接作用於「真實背景」，做到真正嘅折射同色散，而唔係假光暈。
 *
 * 瀏覽器支援：Chrome/Edge 已驗證 backdrop-filter 接受 url(#filter)；
 *   Safari 唔支援 → 自動退回純 blur（見 applyToElement 的兩段式寫法）。
 * ========================================================================= */

(function (global) {
    'use strict';

    // 參數預設值（數值與原版 ybouane/liquidglass 一致，方便日後對照）
    const GLASS_DEFAULTS = {
        blurAmount: 0.00,
        refraction: 0.69,
        chromAberration: 0.05,
        edgeHighlight: 0.05,
        specular: 0.00,
        fresnel: 1.00,
        distortion: 0.00,
        cornerRadius: 65,
        zRadius: 40,
        opacity: 1.00,
        saturation: 0.00,
        tintStrength: 0.00,
        brightness: 0.00,
        shadowOpacity: 0.30,
        shadowSpread: 10,
        shadowOffsetY: 1
    };

    // 只保留會影響 SVG 折射濾鏡的參數 → 相同者共用同一個 <filter>，避免重複生成
    const FILTER_KEYS = ['refraction', 'chromAberration', 'distortion'];

    const SVG_NS = 'http://www.w3.org/2000/svg';

    let defsEl = null;              // 放 <filter> 的隱藏 <defs> 容器
    let filterSeq = 0;
    const filterCache = new Map();  // configKey -> filterId

    // 瀏覽器是否支援 backdrop-filter: url(#...)（Safari 會回 false）
    const supportsFilterUrl = (() => {
        try {
            return typeof CSS !== 'undefined' && CSS.supports
                ? CSS.supports('backdrop-filter', 'url("#lg-probe")')
                : false;
        } catch (err) {
            return false;
        }
    })();

    // ---------------------------------------------------------------- 工具

    function clamp(v, min, max) {
        return Math.min(Math.max(v, min), max);
    }

    function numberOr(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    function ensureDefs() {
        if (defsEl && defsEl.isConnected) return defsEl;

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('id', 'lg-svg-defs');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        // 不能 display:none（部分瀏覽器會忽略當中的 filter），用 0 尺寸定位收埋
        svg.setAttribute('style',
            'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;');

        const defs = document.createElementNS(SVG_NS, 'defs');
        svg.appendChild(defs);
        document.body.appendChild(svg);
        defsEl = defs;
        return defsEl;
    }

    function el(tag, attrs) {
        const node = document.createElementNS(SVG_NS, tag);
        Object.keys(attrs).forEach((k) => node.setAttribute(k, attrs[k]));
        return node;
    }

    /* 建立（或重用）一個液態玻璃折射濾鏡
     *
     * 濾鏡鏈：
     *   feTurbulence      產生玻璃內部厚薄不均嘅噪聲場
     *   feGaussianBlur    柔化噪聲，令折射邊界平滑（唔會出現硬邊撕裂）
     *   feDisplacementMap ×3  分別用 R/G/B 三個通道各自位移唔同距離 → 色散
     *   feBlend screen ×2 將三個色版加返埋一齊（screen 等同加色）
     */
    function buildFilter(cfg) {
        const key = FILTER_KEYS.map((k) => Number(cfg[k]).toFixed(4)).join('|');
        if (filterCache.has(key)) return filterCache.get(key);

        const defs = ensureDefs();
        const id = `lg-refract-${++filterSeq}`;

        const baseScale = 2 + clamp(cfg.refraction, 0, 1) * 14;        // 主折射位移（px）
        const chroma = 0.4 + clamp(cfg.chromAberration, 0, 1) * 9;     // 色散偏移量
        const freq = 0.010 + clamp(cfg.distortion, 0, 1) * 0.020;      // 噪聲頻率

        const filter = el('filter', {
            id,
            x: '-25%',
            y: '-25%',
            width: '150%',
            height: '150%',
            // 用 sRGB 避免 linearRGB 造成嘅色偏，玻璃色散顏色先會準
            'color-interpolation-filters': 'sRGB'
        });

        filter.appendChild(el('feTurbulence', {
            type: 'fractalNoise',
            baseFrequency: `${freq.toFixed(4)} ${(freq * 1.6).toFixed(4)}`,
            numOctaves: 2,
            seed: 7,
            result: 'lgNoise'
        }));

        filter.appendChild(el('feGaussianBlur', {
            in: 'lgNoise',
            stdDeviation: (1.4 + clamp(cfg.distortion, 0, 1) * 2).toFixed(2),
            result: 'lgSoftNoise'
        }));

        // 三個色版各自唔同位移 → 邊緣出現紅/青/藍色邊（chromatic aberration）
        const channels = [
            { name: 'R', scale: baseScale * 1.18 + chroma, matrix: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0' },
            { name: 'G', scale: baseScale, matrix: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0' },
            { name: 'B', scale: baseScale * 0.86 - chroma, matrix: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0' }
        ];

        channels.forEach((ch) => {
            filter.appendChild(el('feDisplacementMap', {
                in: 'SourceGraphic',
                in2: 'lgSoftNoise',
                scale: ch.scale.toFixed(3),
                xChannelSelector: 'R',
                yChannelSelector: 'G',
                result: `lgDisp${ch.name}`
            }));
            filter.appendChild(el('feColorMatrix', {
                in: `lgDisp${ch.name}`,
                type: 'matrix',
                values: ch.matrix,
                result: `lgCh${ch.name}`
            }));
        });

        filter.appendChild(el('feBlend', {
            in: 'lgChR', in2: 'lgChG', mode: 'screen', result: 'lgChRG'
        }));
        filter.appendChild(el('feBlend', {
            in: 'lgChRG', in2: 'lgChB', mode: 'screen'
        }));

        defs.appendChild(filter);
        filterCache.set(key, id);
        return id;
    }

    // ---------------------------------------------------------------- 套用設定

    function readConfig(element, defaults) {
        const cfg = Object.assign({}, defaults);
        const raw = element.dataset ? element.dataset.config : null;
        if (!raw) return cfg;

        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') Object.assign(cfg, parsed);
        } catch (err) {
            console.warn('[LiquidGlass] data-config 不是有效 JSON，已略過：', element, err);
        }
        return cfg;
    }

    function applyToElement(element, cfg, defaults) {
        const blur = clamp(numberOr(cfg.blurAmount, defaults.blurAmount), 0, 1) * 40;
        const sat = 1 + numberOr(cfg.saturation, defaults.saturation);
        const bright = 1 + numberOr(cfg.brightness, defaults.brightness);

        // ── 兩段式寫法（關鍵）──────────────────────────────────────────
        // 先寫一定有效嘅純 blur 版本；再嘗試升級加 url(#filter)。
        // 若瀏覽器唔支援（例如 Safari），第二行會被直接忽略，
        // 玻璃仍然有 blur + 主題色，唔會成塊消失。
        const safeValue = `blur(${blur.toFixed(2)}px) saturate(${sat.toFixed(2)})`;
        element.style.backdropFilter = safeValue;
        element.style.webkitBackdropFilter = safeValue;

        let filterId = null;
        if (supportsFilterUrl) {
            filterId = buildFilter(cfg);
            element.style.backdropFilter =
                `blur(${blur.toFixed(2)}px) saturate(${sat.toFixed(2)}) brightness(${bright.toFixed(2)}) url("#${filterId}")`;
        }

        // ── 其餘光學參數 → CSS 變數，交由 liquidglass.css 疊圖層 ──────
        const setVar = (name, value) => element.style.setProperty(name, value);
        setVar('--lg-alpha', clamp(numberOr(cfg.opacity, defaults.opacity), 0, 1).toFixed(3));
        setVar('--lg-radius', `${numberOr(cfg.cornerRadius, defaults.cornerRadius)}px`);
        setVar('--lg-bevel', `${numberOr(cfg.zRadius, defaults.zRadius)}px`);
        setVar('--lg-rim', clamp(numberOr(cfg.edgeHighlight, defaults.edgeHighlight) * 12, 0, 1).toFixed(3));
        setVar('--lg-chroma', clamp(numberOr(cfg.chromAberration, defaults.chromAberration) * 12, 0, 1).toFixed(3));
        setVar('--lg-spec', clamp(numberOr(cfg.specular, defaults.specular), 0, 1).toFixed(3));
        setVar('--lg-fresnel', clamp(numberOr(cfg.fresnel, defaults.fresnel), 0, 1).toFixed(3));
        setVar('--lg-tint', clamp(numberOr(cfg.tintStrength, defaults.tintStrength), 0, 1).toFixed(3));
        setVar('--lg-shadow-a', clamp(numberOr(cfg.shadowOpacity, defaults.shadowOpacity), 0, 1).toFixed(3));
        setVar('--lg-shadow-spread', `${numberOr(cfg.shadowSpread, defaults.shadowSpread)}px`);
        setVar('--lg-shadow-y', `${numberOr(cfg.shadowOffsetY, defaults.shadowOffsetY)}px`);

        element.classList.add('lg-glass');
        element.dataset.lgFilter = filterId || '';
        return cfg;
    }

    function watchConfig(element, getDefaults) {
        if (element._lgObserver) return;

        const observer = new MutationObserver(() => {
            applyToElement(element, readConfig(element, getDefaults()), getDefaults());
        });
        observer.observe(element, { attributes: true, attributeFilter: ['data-config'] });
        element._lgObserver = observer;
    }

    // ---------------------------------------------------------------- 指標光源（specular 跟手）

    function bindPointerLight(root, elements) {
        if (root._lgPointerBound) return;
        root._lgPointerBound = true;

        let frame = 0;
        let lastEvent = null;

        const flush = () => {
            frame = 0;
            if (!lastEvent) return;

            elements.forEach((element) => {
                const rect = element.getBoundingClientRect();
                if (!rect.width || !rect.height) return;

                const lx = clamp((lastEvent.clientX - rect.left) / rect.width, 0, 1);
                const ly = clamp((lastEvent.clientY - rect.top) / rect.height, 0, 1);
                // 光源跟手 → 高光位置；同時輸出一組鏡像光源做 Blinn-Phong 雙光源感
                element.style.setProperty('--lg-lx', `${(lx * 100).toFixed(2)}%`);
                element.style.setProperty('--lg-ly', `${(ly * 100).toFixed(2)}%`);
                element.style.setProperty('--lg-lx2', `${((1 - lx) * 100).toFixed(2)}%`);
            });

            elements.forEach((element) => {
                element.classList.add('is-lit');
            });
        };

        const onMove = (event) => {
            lastEvent = event;
            if (!frame) frame = requestAnimationFrame(flush);
        };

        root.addEventListener('pointermove', onMove, { passive: true });
        root.addEventListener('pointerdown', onMove, { passive: true });
        root.addEventListener('pointerleave', () => {
            elements.forEach((element) => element.classList.remove('is-lit'));
        }, { passive: true });
    }

    // ---------------------------------------------------------------- 實例

    function createInstance(root, elements, defaults) {
        elements.forEach((element) => {
            applyToElement(element, readConfig(element, defaults), defaults);
            watchConfig(element, defaults);
        });

        bindPointerLight(root, elements);
        root.classList.add('lg-root');

        return {
            root,
            glassElements: elements,

            // 任何函式庫無法自行觀測嘅改動（例如 JS 直接改咗 background-image）都可以叫一次
            markChanged(element) {
                const targets = element ? [element] : elements;
                targets.forEach((target) => {
                    if (target) applyToElement(target, readConfig(target, defaults), defaults);
                });
            },

            // 流體形變：由 TabBar 物理層（tabbar 手勢）呼叫，
            // stretch/squash 係倍率（0.1 = 拉伸 10%），velocity 係 px/ms
            setMorph(element, morph) {
                if (!element) return;
                const stretch = clamp(numberOr(morph && morph.stretch, 0), 0, 0.5);
                const squash = clamp(numberOr(morph && morph.squash, 0), 0, 0.5);
                const speed = clamp(Math.abs(numberOr(morph && morph.velocity, 0)) / 2.4, 0, 1);

                element.style.setProperty('--lg-stretch', stretch.toFixed(4));
                element.style.setProperty('--lg-squash', squash.toFixed(4));
                element.style.setProperty('--lg-speed', speed.toFixed(3));
                element.classList.toggle('is-fluid', stretch > 0.004 || squash > 0.004);
            },

            destroy() {
                elements.forEach((element) => {
                    if (element._lgObserver) {
                        element._lgObserver.disconnect();
                        delete element._lgObserver;
                    }
                    element.classList.remove('lg-glass', 'is-lit', 'is-fluid');
                    element.style.backdropFilter = '';
                    element.style.webkitBackdropFilter = '';
                });
                root.classList.remove('lg-root');
                root._lgPointerBound = false;
            }
        };
    }

    const LiquidGlass = {
        defaults: GLASS_DEFAULTS,
        supportsFilterUrl,

        /* init({ root, glassElements, defaults }) → Promise<instance> */
        init(options) {
            const opts = options || {};
            const root = opts.root;
            if (!root) {
                console.warn('[LiquidGlass] init 需要 root 元素');
                return Promise.resolve(null);
            }

            const list = opts.glassElements
                ? Array.prototype.slice.call(opts.glassElements)
                : [];

            const defaults = Object.assign({}, GLASS_DEFAULTS, opts.defaults || {});
            const instance = createInstance(root, list, defaults);
            return Promise.resolve(instance);
        },

        // 由 JS 建立 <filter> 的識別碼（給 CSS 或其他模組查詢用）
        getFilterId(config) {
            return buildFilter(Object.assign({}, GLASS_DEFAULTS, config || {}));
        }
    };

    global.LiquidGlass = LiquidGlass;
})(window);
