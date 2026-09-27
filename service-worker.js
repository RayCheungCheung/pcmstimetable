// ================= Service Worker =================
// 版本號升級：2.6.0 → 2.7.0
// 本次變更：
//   1. 開頁初始化改為「先選班級」：首次開啟（localStorage 未有 user_class）
//      唔會再預設顯示任何班級課表，改為顯示「請先選擇班級」引導卡並自動開班級選擇。
//   2. 班級偏好改存裝置層 localStorage.user_class（未登入都記得），
//      已選過 → 重開 App 直接載入該班課表。
//   3. S2B（初二望）教師資料修正（分組數學 譚鴻生·余麗君、數學AI 黃燦霖·譚鴻生 等）。
//   4. CACHE_NAME 升版，確保 index.html / scripts / data 全部重新 precache。
const CACHE_NAME = 'timetable-v2.7.0';
const urlsToCache = [
    './',
    './index.html',
    './manifest.json',
    './styles/main.css',
    './styles/icons.css',
    './styles/splash.css',
    './styles/themes/dark.css',
    './styles/themes/light.css',
    './styles/components/cards.css',
    './styles/components/buttons.css',
    './styles/components/animations.css',
    './styles/pages/menu.css',
    './styles/pages/schedule.css',
    './styles/pages/realtime.css',
    './scripts/main.js',
    './scripts/utils/storage.js',
    './scripts/utils/icons.js',
    './scripts/utils/db.js',
    './scripts/modules/search/search.css',
    './scripts/modules/theme/theme.js',
    './scripts/modules/theme/theme.css',
    './scripts/modules/weekly/weekly.js',
    './scripts/modules/weekly/weekly.css',
    './scripts/modules/holidays/holidays.js',
    './scripts/modules/holidays/holidays.css',
    './scripts/modules/animations/animations.js',
    './scripts/modules/expand/expand.js',
    './scripts/modules/expand/expand.css',
    './scripts/modules/calendar/calendar.js',
    './scripts/modules/calendar/calendar.css',
    './scripts/config/auth-config.js',
    './scripts/modules/auth/auth.js',
    './scripts/modules/auth/auth.css',
    './scripts/modules/profile/profile.js',
    './scripts/modules/profile/profile.css',
    './scripts/modules/devtools/devtools.js',
    './scripts/modules/devtools/devtools.css',
    './scripts/modules/liquidglass/liquidglass.js',
    './scripts/modules/liquidglass/liquidglass.css',
    './scripts/modules/homework/homework.js',
    './scripts/modules/homework/homework.css',
    './data/schedule.json',
    './data/classes.json',
    './data/schedules/junior2-xin.json',
    './data/schedules/junior2-wang.json',
    './data/schedules/junior2-ai.json',
    './data/schedules/junior2-shan.json',
    './data/schedules/junior2-zheng.json',
    './data/schedules/junior2-guang.json',
    './data/holidays.json',
    './data/events.json',
    './data/homework.json',
    './assets/icons/icon-192.png',
    './assets/icons/icon-512.png',
    './assets/icons/icon-maskable-512.png',
    './assets/images/app-logo.svg'
];

// 安裝：快取所有檔案
// 用 allSettled：只要有一個檔案 404（例如部署時漏咗上傳），都唔會令整個 SW 安裝失敗
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('已開啟快取');
            return Promise.allSettled(urlsToCache.map((url) => cache.add(url)));
        })
    );
    self.skipWaiting();
});

// 啟用：清除舊快取
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('刪除舊快取:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// 攔截請求：網路優先（確保拎到最新版本），失敗時回退快取（離線仍可用）
self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    // 只處理本專案 scope 內嘅請求
    // GitHub Pages 同一個 username.github.io 之下可能有多個專案／其他 SW，唔可以撈過界
    if (!request.url.startsWith(self.registration.scope)) return;

    event.respondWith(
        fetch(request).then((response) => {
            if (response && response.status === 200 && response.type === 'basic') {
                const responseToCache = response.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(request, responseToCache);
                });
            }
            return response;
        }).catch(() => {
            // ignoreSearch：離線時 request 可能帶住 ?v=2.5.0 版本戳，
            // 但 precache 落嚟嘅係無 query 嘅版本（./data/classes.json）。
            // 唔用 ignoreSearch 就會完全對唔上，變成離線讀唔到班級清單。
            return caches.match(request, { ignoreSearch: true }).then((cached) => {
                if (cached) return cached;
                if (request.mode === 'navigate') {
                    return caches.match('./index.html');
                }
                return Response.error();
            });
        })
    );
});