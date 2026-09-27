// ================= Service Worker =================
// 版本號升級：4.16.0 → 4.17.0
// 本次變更（Splash Screen 首屏 Logo 防爆版 ＋ 收尾保險，承 4.16.0 破版修復）：
//   ⚠ 現象：初次載入嗰 2~3 秒（品牌 Splash），左邊會出現一個佔半屏嘅巨型書本
//     Logo，Loading 完結後才消失。同 4.16.0 修嘅係同一個病灶（Splash 圖層
//     跌落 <body> 嘅 flex 排版 + Logo 無上限），但今次補齊「首屏／零 CSS」
//     呢個時間窗嘅保險。
//   1. index.html：Splash 容器同品牌塊加咗 inline style 作最後一道防線
//      （inline style 蓋得過所有 stylesheet，CSS 未載入／載入失敗／版本唔一致
//      都照樣生效）：
//        · #splash-screen → position: fixed; inset: 0; Flex 置中; overflow: hidden
//        · .splash-logo   → width / height / max-width / max-height: 160px; flex: 0 0 auto
//      ⚠ 呢兩個值刻意同內嵌 critical CSS 重複，改尺寸要兩邊一齊改。
//   2. main.js（3.5.2 → 3.5.3）：
//        · 新增 dropSplashScreen()：inline display: none ＋ .removed ＋ 移除節點，
//          idempotent，正常收尾同 watchdog 共用。
//        · finishBrandSplash() 淡出階段除咗加 .hidden，仲會直接落
//          inline transition / opacity = 0 —— 唔再單純靠 CSS class（該規則
//          喺內嵌 critical CSS，樣式表版本唔一致就唔生效）。
//        · 新增 SPLASH_WATCHDOG_MS ＋ bootApp()：initApp() 拋錯即刻收走 Splash，
//          卡死就由 watchdog 兜底（正常啟動永遠唔會觸發）。主介面永遠優先，
//          唔會再出現「巨型 Logo 擋住 App」嘅殘留畫面。
//   3. ?v 同步升：main.js 3.5.3；SW 註冊 service-worker.js?v=4.17.0，
//      CACHE_NAME → timetable-v4.17.0。
//   ⚠ 4.16.0 嘅 HTML 已有 Splash 樣式，但 main.js 係快取優先 ——
//     唔升 main.js ?v 同 CACHE_NAME，裝置只會照跑舊邏輯。
//
// 上一版 4.15.0 → 4.16.0
// 本次變更（修復桌面版／大螢幕「左側 App Logo 爆成半屏黑卡」破版）：
//   ⚠ 成因（唔係側邊欄，亦唔係 Header Logo 走位）：
//     body 係 display: flex（row），正常只有 .phone-mockup 一個 in-flow 子元素。
//     Splash 樣式本來全部擺喺 index.html 內嵌 critical CSS，但更早嘅版本係擺喺
//     外部 styles/splash.css（該檔案依家已經係空佔位檔，亦刻意唔再 precache）。
//     一旦快取出現「舊 index.html（連 splash.css）＋ 新 splash.css（空）」呢個
//     組合，#splash-screen 就會失去 position: fixed → 跌落 in-flow，變成 body
//     嘅 flex item：同手機外框並排、被推到左邊；而 .app-logo 寫嘅係
//     width / height: 100%，app-logo.svg 原生又係 512 × 512 →
//     Logo 撐成一塊黑底大卡佔據半個螢幕。大螢幕只係更容易見到（手機斷點下
//     兩層疊埋一齊睇唔出）。
//   1. styles/main.css：新增「頂層圖層保險」——
//      · body > *:not(.phone-mockup) { position: fixed; }：頂層圖層一律固定定位，
//        任何一層失去自身樣式都唔會再同手機外框爭 body 嘅 flex 空間。
//      · :where(#splash-screen) 系列：Splash 即使失去內嵌 critical CSS，都仍然係
//        全螢幕固定層，品牌塊封頂 160 × 160。全部用 :where() 令權重歸零 →
//        正常情況完全唔生效，亦唔會變成第二個「真相來源」蓋過 critical CSS。
//      · .header-logo 補 max-width / max-height（現值 30px，只係加封頂）。
//      ?v 2.7.0 → 2.7.1。
//   2. auth.css：.app-logo 由「純 width / height: 100%，完全冇上限」加上
//      max-width / max-height: 120px（登入頁 Badge 88px、班級引導 64px 都夠用）。
//      ⚠ Splash 嘅 160px Logo 由 index.html 內嵌 "#splash-screen .splash-logo__img"
//        嘅 max-width / max-height: 160px 覆寫（ID 權重高於 class），唔受影響。
//      ?v 2.7.0 → 2.7.1。
//   3. index.html：
//      · 內嵌 critical CSS：#splash-screen .splash-logo 加 flex: 0 0 auto ＋
//        max-width / max-height: 160px；.splash-logo__img 加 max-width /
//        max-height: 160px。
//      · 三個 <img>（.header-logo ×1、.app-logo ×2）補 width / height 屬性：
//        CSS 未載入（或樣式表版本不一致）嘅空窗期，SVG 唔會先用原生
//        512 × 512 撐爆版面，再等 CSS 收返細。
//      · ?v 同步升：main.css 2.7.1、auth.css 2.7.1；SW 註冊
//        service-worker.js?v=4.16.0，CACHE_NAME → timetable-v4.16.0。
//      ⚠ SW 對 JS／CSS 係快取優先，唔升 ?v ＋ CACHE_NAME 用戶只會見到舊樣式；
//        而今次破版本身就係「舊 HTML 配新 CSS」造成，CACHE_NAME 一定要升。
//      ⚠ urlsToCache 用唔帶 query 嘅路徑，清單本身毋須改（全部檔案都已在清單內）。
//      ⚠ APP_VERSION 維持 3.5.1 不變（依既有政策，改版型／修 CSS 唔升介面版本號）。
//
// 上一版 4.14.0 → 4.15.0
// 本次變更（「開發者」改為單一垂直置中卡片模板：置中標題 ＋ 成員垂直排列 ＋ 頁尾標語）：
//   1. profile.js：
//      · profileDetailAboutHtml() 由「每位成員各自一張 .ios-card」改為
//        「全頁唯一一張大卡」：卡內順序為 區塊標題 → 成員 → 頁尾標語，
//        整塊 .dev-panel 以一個內容項傳入 profileListCardHtml()（卡片外框
//        仍然只有嗰一個定義源頭，唔自己砌 <section class="ios-card">）。
//        成員陣列一空就整張卡唔渲染，唔會留低一張「得個標題」嘅空卡。
//      · profileDevMemberHtml() 改為垂直置中區塊：圓形頭像（縮寫）→ 姓名 →
//        班別 → 社交 Icon 掣列，順序同模板圖一致；唔再包卡片外框
//        （否則會變成「卡片裡面包卡片」）。
//      · 班別由 Badge 改為純藍字（.dev-member__tag → .dev-member__class）：
//        模板圖上只係一行藍字，加底色會多出一層標籤質感。
//      · 分隔線一律交由 CSS 以相鄰選擇器（.dev-member + .dev-member）判定，
//        唔喺 DOM 插 <hr>：唔係咁樣就一定要用 :last-child 補救「最後一位
//        後面多一條線」。
//      · ⚠ 成員「簡介文字」完全唔存在：卡片一多一行描述就會退返做列表項。
//        需求提到嘅「M56運動會暗組織學員」等描述冇、亦唔應該有入口。
//      · ⚠ 冇加「解鎖管理員驗證」掣：開發者模式全站只可以有一個入口
//        （個人中心頁尾版本號連點 5 下）。需求文件提到嘅 openDevAuthModal()
//        本專案從來冇存在過，唔可以為咗「跟足文件」而新開一個函式名。
//      ?v 3.5.7 → 3.5.8。
//   2. profile-content.js：新增 PROFILE_DEVELOPER_PANEL_TITLE（卡片頂部灰字
//      區塊標題「開發者」）。刻意唔同 PROFILE_DETAIL_PAGES.about.title 合併：
//      一個係卡片內嘅分區名、一個係導覽列上嘅頁名。並喺成員註解補明
//      「呢度冇、亦唔應該有簡介文字欄位」。?v 3.5.6 → 3.5.7。
//   3. profile.css：
//      · 新增 .dev-panel（置中容器）／.dev-panel__title（灰字區塊標題）。
//      · .dev-member 改為 flex column ＋ align-items: center（垂直置中），
//        頭像 48px → 64px（名牌嘅視覺重心），姓名 15px → 17px。
//      · 新增 .dev-member__class（純藍字班別）取代 .dev-member__tag（膠囊
//        Badge）；連帶刪除 .dev-member__id／.dev-member__foot（左右分欄
//        版面嘅產物，置中版面再冇用途）。
//      · 新增分隔線 .dev-member + .dev-member、.dev-member + .detail-tribute。
//        ⚠ 需求原文寫 1px solid #E5E5EA，呢度改用 var(--lg-line)：硬編淺灰
//          喺深色主題下會變成一條發光白線。厚度保留 1px（比全站其他 0.5px
//          hairline 粗），因為分隔嘅係兩位唔同成員兩個大區塊。
//      · .detail-tribute 移入卡內：width: 100% ＋ padding 撐開上下留白，
//        分隔線改由上面嗰條相鄰規則提供。
//      · .dev-social 由「靠右」改為 justify-content: center（置中）；社交掣
//        36px 圓形 → 40px 圓角方形（模板圖係 App 圖示隱喻，圓形留返畀頭像）。
//      ?v 3.37.0 → 3.38.0。
//   4. index.html：同步升 ?v（profile.css 3.38.0、profile-content.js 3.5.7、
//      profile.js 3.5.8）；SW 註冊 service-worker.js?v=4.15.0，
//      CACHE_NAME → timetable-v4.15.0。
//      ⚠ SW 對 JS／CSS 係快取優先，唔升 ?v ＋ CACHE_NAME 用戶只會見到舊卡片。
//      ⚠ urlsToCache 用唔帶 query 嘅路徑，清單本身毋須改（全部檔案都已在清單內）。
//      ⚠ icons.js 今次完全冇改（heart 圖示上一版已恢復），維持 ?v 2.16.0。
//   5. ⚠ APP_VERSION 維持 3.5.1 不變（依既有政策，改 UI／加內容唔升介面版本號）。
//
// 版本號升級：4.13.0 → 4.14.0
// 本次變更（成員卡改為 iOS 名片式排版；社交連結由列表改為橫向 Icon 掣）：
//   1. profile.js：
//      · profileDevMemberHtml() 重寫為「名片」：左側頭像 ＋ 姓名（上）／班別
//        Badge（下），社交連結排成一行圓形 Icon 掣貼喺第二行右側。舊版把
//        IG／GitHub 逐條排成 .ios-row（有 chevron、有 hairline、每條 52px 高），
//        每張卡被撐到三四行，睇落完全係一個預設列表 —— 呢個正是今次要擺脫嘅觀感。
//      · profileDevInitials() 由「取前兩個字首字母」改為「每個字取首字母」
//        （上限 3 個）：Chan Hong Tang 舊寫法會得出 'CH'，同需求指明嘅 'CHT'
//        唔一致；Ray Cheung 仍然係 'RC'，不受影響。
//      · 社交連結由 <button onclick="profileOpenExternal(...)"> 改為
//        <a href target="_blank" rel="noopener noreferrer">：目的地本來就係
//        一條網址，連結語意先啱（讀屏讀「連結」、可另開分頁）。連帶把
//        「只接受 https://」嘅守衛由「撳嗰陣先檢查」改為「渲染前過濾」。
//      · ⚠ profileOpenExternal() 因此再冇任何呼叫點，已整個刪除（連帶
//        profileNavRowHtml() 嘅第 5 個參數 icon 一併刪除）—— 留一個永遠
//        唔會被填嘅參數，只會令人以為仲有地方靠佢 render 圖示。
//      · profileDetailAboutHtml() 恢復頁尾致敬標語（純裝飾 <p>，唔用 .ios-card）。
//      ?v 3.5.6 → 3.5.7。
//   2. profile-content.js：
//      · Ray Cheung 嘅 socials 補上個人網站一行（網址由使用者提供：
//        https://raycheungcheung.github.io/MyProtfolio/）。該檔原有「唔可以
//        猜測網址」嘅留白註解已按確認結果改寫。
//      · 恢復 PROFILE_ABOUT_TRIBUTE（「為澳門培正中學師生打造」）。
//        ⚠ 心形刻意唔包含喺字串內：個 ❤ 係 icons.js 嘅 heart SVG，
//          由 profile.js 拼入句子中間（即「用 ❤ 為…」）。字串內「唔可以」
//          寫 ❤️ Emoji —— 全站系統 UI 嚴禁 Emoji。
//      ?v 3.5.5 → 3.5.6。
//   3. icons.js：恢復 heart 圖示（唯一使用者就係上面嗰句標語）。?v 2.15.0 → 2.16.0。
//      · ⚠ 恢復時「冇」加入 APP_ICON_LEGACY：佢只由程式碼硬編引用，
//        並非由假期／活動資料嘅 emoji 欄位解析出嚟。
//   4. profile.css：
//      · 新增 .dev-member__foot（第二行：Badge 靠左、社交掣靠右）、
//        .dev-social（橫向掣列）、.dev-social__link（36px 圓形底）＋
//        :active 回饋（scale 0.92，沿用 .wa-iconbtn 嘅按壓語言）。
//      · 刪除 .dev-member:not(:last-child) 嘅 hairline —— 卡內再冇第二段
//        內容（社交列已變成卡內嘅 Icon 掣），分隔線再冇存在意義。
//      · .dev-member__tag 原本寫 display: inline-block 令闊度貼住文字；
//        佢而家係 flex item，而 flex item 嘅 display 會被 blockify，
//        嗰句聲明完全冇作用，故改為 flex: 0 1 auto 並改寫註解。
//      · 恢復 .detail-tribute / __icon / __text 三段（頁尾致敬標語）。
//        ⚠ 標語用 inline 排列而唔用 flex ＋ gap：句入面夾住個心，
//          用 flex 就會喺窄螢幕斷喺「用」同個心之間，睇落似兩截文字。
//      ?v 3.36.0 → 3.37.0。
//   5. index.html：頁尾版本號（開發者模式入口）維持不變；只同步升 ?v。
//      ⚠ 需求文件提到嘅「解鎖管理員驗證按鈕（openDevAuthModal()）」今次按使用者
//        確認「唔加」：本專案從來冇 openDevAuthModal 呢個函式，而且開發者模式
//        全站只可以有一個入口（頁尾版本號連點 5 下）。喺本頁再加一粒就會變成
//        第二個入口，安全性嚟自伺服器端驗證而唔係「冇人知有第二道門」。
//   6. ?v 同步升：icons.js 2.15.0 → 2.16.0、profile-content.js 3.5.5 → 3.5.6、
//      profile.js 3.5.6 → 3.5.7、profile.css 3.36.0 → 3.37.0；
//      SW 註冊 service-worker.js?v=4.14.0，CACHE_NAME → timetable-v4.14.0。
//      ⚠ SW 對 JS／CSS 係快取優先，唔升 ?v ＋ CACHE_NAME 用戶只會見到舊卡片。
//      ⚠ urlsToCache 用唔帶 query 嘅路徑，清單本身毋須改（全部檔案都已在清單內）。
//   7. ⚠ APP_VERSION 維持 3.5.1 不變（依既有政策，改 UI／加內容唔升介面版本號）。
//
// 版本號升級：4.12.0 → 4.13.0
// 本次變更（「開發者簡介」整頁併入「關於我們」，開發者模式入口搬返頁尾版本號連點）：
//   1. profile.js：「關於我們」重寫為兩部分 —— 「App 資訊」（App 名稱 ＋ 簡介 ＋
//      版本號，三者同屬一個 .detail-callout）＋ 開發者成員卡（每位一張 .ios-card）。
//      刪除原本嘅「聯絡／法律」卡、「開發者簡介」入口卡同頁尾致敬標語。
//      ?v 3.5.5 → 3.5.6。
//      · ⚠ PROFILE_DETAIL_PAGES 嘅 developer 一項已移除，profileDetailDeveloperHtml()
//        整個函式刪除；但成員卡渲染器（profileDevInitials / profileDevMemberHtml /
//        profileOpenExternal）係搬去「關於我們」繼續用，唔係一併刪走。
//      · ⚠ 私隱政策 / 服務條款 / 回報問題 / 聯絡支援 冇失去入口 —— 主選單本身
//        各自已有，呢頁只係重複入口，刪走唔會令任何功能失聯。
//   2. profile-content.js：刪除 PROFILE_DEVELOPER_NAME、PROFILE_DEVELOPER_TAGLINE、
//      PROFILE_ABOUT_TRIBUTE 三個常數（成員卡改嵌「關於我們」之後再無渲染位置），
//      PROFILE_DEVELOPER_MEMBERS 保留不變。?v 3.5.4 → 3.5.5。
//   3. profile.css：刪除 .detail-tribute / __icon / __text（頁尾致敬標語三段），
//      新增 .detail-callout__version（App 資訊區塊第三行）。?v 3.35.0 → 3.36.0。
//   4. icons.js：刪除 heart 圖示 —— 佢唯一嘅使用者就係致敬標語，
//      而 data-icon="heart" 全專案已零命中，該處註解改寫為「已刪除」記錄。
//      ?v 2.14.0 → 2.15.0。
//   5. devtools.js：恢復「版本號連點 5 下」入口（document 層事件委派，
//      2 秒內 5 下 → devRequestAccess()），並喺 devBootstrap() 嘅雲端檢查
//      「之前」綁定（純本機模式下起碼會出「雲端未啟用」提示，唔會撳極都冇反應）。
//      ?v 1.1.0 → 1.2.0。devtools.css 恢復 [data-dev-version] 防禦規則，同版。
//      · ⚠ 「開發者模式只可以有一個入口」仍然成立：唯一入口就係呢個連點。
//        入口搬遷史：版本號連點 → 「關於我們 → 開發者簡介」頁尾一列 →
//        （今次）版本號連點。
//      · ⚠ 舊版嘅長按 / Ctrl+Shift+D / FAB 仍然永久廢除，唔係一齊恢復：
//        佢們係「不需驗證即可開啟面板」嘅路徑，同連點版本號唔同性質。
//   6. calendar.js：開頭註解嘅開發者模式路徑改為「個人中心頁尾版本號連點 5 下」
//      （舊寫法「關於我們 → 開發者簡介 → 開發者模式」已隨該子頁面失效）。
//      ?v 2.8.0 → 2.9.0。
//   7. index.html：頁尾 #app-version 加 data-dev-version 標記（入口認人用），
//      並改寫開頭「開發者模式」同頁尾兩段註解（連同入口搬遷史）。
//   8. ?v 同步升：icons.js 2.14.0 → 2.15.0、profile-content.js 3.5.4 → 3.5.5、
//      profile.js 3.5.5 → 3.5.6、profile.css 3.35.0 → 3.36.0、
//      devtools.js 1.1.0 → 1.2.0、devtools.css 1.1.0 → 1.2.0、calendar.js 2.8.0 → 2.9.0；
//      SW 註冊 service-worker.js?v=4.13.0，CACHE_NAME → timetable-v4.13.0。
//      ⚠ SW 對 JS／CSS 係快取優先，唔升 ?v ＋ CACHE_NAME 用戶只會見到舊頁
//        （尤其今次連服務健康都變咗：唔升就會仍然見到嗰個已經刪咗嘅入口）。
//      ⚠ urlsToCache 用唔帶 query 嘅路徑，清單本身毋須改（全部檔案都已在清單內）。
//   9. ⚠ APP_VERSION 維持 3.5.1 不變（依既有政策，改 UI／加內容唔升介面版本號）。
//
// 版本號升級：4.11.0 → 4.12.0
// 本次變更（「開發者簡介」改為成員卡 ＋ 社交連結，移除簡介文字）：
//   1. icons.js：新增 instagram / github 兩個品牌標記（?v 2.13.0 → 2.14.0）。
//      · instagram 用「圓角方 + 圓 + 圓點」線條畫法，符合全站 fill:none +
//        stroke:currentColor 規範；
//      · github 係 octocat 剪影，本質上冇線條版本，故喺路徑內寫
//        fill="currentColor" stroke="none" 覆寫 —— 依 moreHorizontal 先例，
//        呢個係「單色實心」而唔係「彩色圖示」，仍然跟 currentColor 走。
//      · ⚠ 兩個都冇加入 APP_ICON_LEGACY：佢哋只由社交列硬編引用，
//        並非由假期／活動資料嘅 emoji 欄位解析出嚟。
//   2. profile-content.js：PROFILE_DEVELOPER_FOCUS（三行簡介）刪除，
//      新增 PROFILE_DEVELOPER_MEMBERS（Ray Cheung／Chan Hong Tang，
//      tag 初二正，各附 IG ＋ GitHub 連結）。?v 3.5.3 → 3.5.4。
//      · ⚠ 成員姓名與網址由使用者提供，屬已確認資料；本檔原有「未經確認嘅
//        成員姓名、連結一律唔加」嘅原則仍然有效，兩者唔矛盾（前者防虛構，
//        後者係資料擁有者自己交出嚟）。
//      · ⚠ Ray Cheung 嘅「個人網站」掣未有網址，故刻意留白 —— 本專案明令
//        唔可以造假（包括猜測網址）。確認後喺該成員嘅 socials 補一行
//        { icon: 'globe', label: '個人網站', url: '…' } 即可，毋須改 profile.js。
//   3. profile.js：新增 profileDevInitials() / profileDevMemberHtml() /
//      profileOpenExternal()，並重寫 profileDetailDeveloperHtml()。
//      · 成員卡 = 頭像（姓名縮寫）＋ 姓名 ＋ 班別 Badge，接住社交列，
//        中間冇任何簡介文字。?v 3.5.4 → 3.5.5。
//      · ⚠ 頭像用文字縮寫而唔用相片：assets/ 冇、亦唔應該為此新增二進位
//        資產；遠端頭像 URL 一離線就變爛圖，同本頁「離線可讀」相衝。
//      · ⚠ 社交列經 profileNavRowHtml() 產生（唔自己砌 <button>），
//        令左側圖示欄、hairline 分隔線、按壓回饋同全站其他列同源。
//      · ⚠ profileOpenExternal() 只接受 https:// 並以
//        window.open(url, '_blank', 'noopener,noreferrer') 開新分頁 ——
//        用 location.href 會令用戶一去不回（返回鍵返到一個已被導離嘅文件）。
//      · ⚠ 頁尾致敬標語重用 PROFILE_ABOUT_TRIBUTE ＋ .detail-tribute，
//        唔另開 PROFILE_DEVELOPER_TRIBUTE：同一句致敬語寫兩份，
//        日後改對象（例如改為對外開放）一定會走音。需求文件寫嘅
//        「用 ❤️ 為…」係同一句話嘅另一種排法（心形放中間），
//        呢度維持既有排法以保持兩頁一致；心形照舊用 icons.js 嘅 heart SVG，
//        唔用 ❤️ emoji（全站系統 UI 嚴禁 Emoji）。
//      · ⚠ 開發者模式入口維持 profileNavRowHtml('開發者模式', '',
//        'devRequestAccess()')：本專案從來冇 openDevAuthModal 呢個函式，
//        唔好照抄需求文件嘅名；而且佢係 .ios-row 而唔係 Modal ——
//        「全站禁止 Modal」。
//   4. profile.css：新增 .dev-member / __avatar / __id / __name / __tag。
//      ?v 3.34.0 → 3.35.0。
//      · ⚠ 刻意唔寫 background／border／border-radius：成員卡同社交列係
//        同一張 .ios-card 嘅上下兩半，外框一律由 .ios-card 提供，
//        否則就會變成「卡片裡面包一張卡」。
//      · ⚠ 分隔線用返 .ios-row 嘅同一條 --lg-line（0.5px hairline）＋
//        :not(:last-child) 寫法，令頭部同社交列之間嗰條線同列與列之間一致，
//        亦避免卡片底部多出一條。
//      · ⚠ 頭像漸變沿用 .auth-hero__badge 嘅同一組色，令品牌色只有一個源頭；
//        頭像屬「身份標記」，唔受「設定頁圖示必須單色、彩色底框已全面移除」
//        嗰條規則約束。
//   5. ?v 同步升：icons.js 2.13.0 → 2.14.0、profile-content.js 3.5.3 → 3.5.4、
//      profile.js 3.5.4 → 3.5.5、profile.css 3.34.0 → 3.35.0；
//      SW 註冊 service-worker.js?v=4.12.0，CACHE_NAME → timetable-v4.12.0。
//      ⚠ SW 對 JS／CSS 係快取優先，唔升 ?v ＋ CACHE_NAME 用戶只會見到舊頁。
//      ⚠ 本專案慣例：只要檔案「內容有改」（包括純註解）就要升 ?v。
//      ⚠ urlsToCache 用唔帶 query 嘅路徑，所以清單本身毋須改
//        （icons.js / profile-content.js / profile.js / profile.css 都已在清單內）。
//   6. ⚠ APP_VERSION 維持 3.5.1 不變（依既有政策，改 UI／加內容唔升介面版本號）。
//
// 版本號升級：4.10.0 → 4.11.0
// 本次變更（四篇法律條文改以對外條文文件為準，並將 Google Sheets 描述改寫為 Supabase 現況）：
//   1. profile-content.js：免責聲明／服務條款／私隱政策／條款與許可四篇內容更新，
//      來源為三份對外條文文件。⚠ 凡文件所載與本專案實況衝突者，一律以程式碼實況為準：
//      · 文件通篇描述「Google Sheets API 同步」＋「Google 帳戶授權試算表」，
//        但本專案自 v4.0.0 起已改用 Supabase（Auth + PostgreSQL + RLS），
//        且 profile.js 明載 Google 登入只屬「預留」尚未實作 —— 故全部改寫為 Supabase。
//      · 文件稱「查詢課表無需註冊帳號」「絕不上傳至第三方伺服器」，
//        惟啟用雲端同步時帳號設定確實會寫入 Supabase PostgreSQL —— 故改為
//        「本機使用無需註冊；啟用雲端同步才會上傳」。
//   2. ⚠ 授權立場由「保留所有權利」改為「CC BY-SA 4.0 ＋ 保留商標」：
//      · 「條款與許可」第一至五章重寫（授權範圍／你可自由做的事／須遵守條件／
//        不得封閉獨佔／商標）；舊「再散布與衍生作品」章（要求事前書面同意方可使用）
//        已刪除 —— 該章與 CC BY-SA 直接矛盾，留低會變成自我否定的條文。
//      · 姓名標示對象為 GitHub 專案 RayCheungCheung/pcmstimetable（使用者指定）。
//      · 新增 PROFILE_LICENSE_NAME／PROFILE_LICENSE_URL／PROFILE_LICENSE_REPO／
//        PROFILE_SITE_URL 常數，令全站授權文案有單一來源。
//      · ⚠ CC 授權**不包括商標權**，所以「我的課表」名稱與標誌仍須事前同意；
//        但呢點唔等於「禁止商業使用」—— CC BY-SA 明確容許商業用途，只要求
//        衍生作品維持相同開放授權。兩件事喺寫法上必須分開，唔可以混為一談。
//   3. ⚠ 修正原有失準描述：舊「條款與許可 §二」寫「刻意維持零外部相依：未使用任何
//      第三方 JavaScript 框架」，但 index.html 早已由 jsdelivr CDN 載入 Supabase SDK。
//      新版本如實揭露該 SDK，並註明佢屬「選用層」（載入失敗或離線時退回原生 fetch，
//      故不影響離線使用與本機功能）。
//   4. ⚠ 遵守既有「條款去識別化」政策（見 3.38.1）：法律條文一律用中性「學校」表述。
//      對外文件雖然寫明校名，但呢個係本專案已明文嘅刻意決定 —— 唔好因為對外文件
//      就將校名加返入條文。
//   5. 結構變動：免責聲明新增「二、非官方性質聲明」（對外文件所載、原條文缺漏）；
//      服務條款新增「雲端同步與帳號安全」四章（取代 Google Sheets 授權章）
//      及「開源授權」兩章；私隱政策一、二、五、六、九章按文件調整；
//      條款與許可由八章重整為九章。
//   6. PROFILE_LEGAL_UPDATED：2026-09-25 → 2026-09-26（跟三份對外文件所載日期）。
//   7. ?v 同步升：profile-content.js 3.5.2 → 3.5.3；
//      SW 註冊 service-worker.js?v=4.11.0，CACHE_NAME → timetable-v4.11.0。
//      ⚠ 本專案慣例：只要檔案「內容有改」（包括純註解）就要升 ?v；
//        今次只有 profile-content.js 一個檔有改，其餘檔案維持原值。
//      ⚠ urlsToCache 用唔帶 query 嘅路徑，所以清單本身毋須改。
//   8. ⚠ APP_VERSION 維持 3.5.1 不變（純條文內容更新，依既有政策不升介面版本號）。
//
// 版本號升級：4.9.0 → 4.10.0
// 本次變更（開發者模式入口搬遷：版本號連點 5 下 → 「開發者簡介」頁尾一列）：
//   1. 移除「連點頁尾／『關於我們』版本號 5 下」入口及佢附帶嘅事件委派監聽
//      （devHandleVersionClick / devBindVersionTrigger / DEV_CLICK_* 常數
//      ＋ script 載入時嘅綁定呼叫），整段邏輯由 devtools.js 刪除。
//      ⚠ 理由：開發者模式只可以有「一個」入口。版本號係使用者會隨手撳嘅
//        資訊欄位，留一個隱藏閘門喺度等於多一條唔應該存在嘅開啟路徑；
//        而舊做法仲要維護兩份監聽（頁尾靜態 DOM ＋「關於我們」頁每次重新渲染）。
//      ⚠ 呢個係「刻意移除」而唔係漏咗 —— 唔好日後又加返。
//   2. 唯一入口改為「關於我們 → 開發者簡介」最底新增嘅「開發者模式」列
//      （profile.js profileDetailDeveloperHtml，onclick="devRequestAccess()"）。
//      ⚠ 卡片仍舊 push 入原本嘅開發者簡介頁，簡介文案一行都冇改。
//      ⚠ 呢列刻意唔按角色或登入狀態隱藏：安全性嚟自伺服器端密碼驗證
//        （supabase/developer-mode.sql），唔係嚟自「冇人知道有呢一頁」——
//        前端隱藏從來唔算一道防線，隱藏只會令未解鎖嘅開發者永遠入唔到。
//   3. data-dev-version 標記全面清除：
//      · index.html 頁尾版本號還原為純文字（唔再帶任何屬性）；
//      · profile.js「關於我們」版本列唔再傳 attrs，並索性刪走
//        profileInfoRowHtml() 嘅第三個參數 attrs —— 佢已經冇任何呼叫者，
//        而且嗰個參數係「唔轉義直接拼進屬性」嘅設計，留一個冇人用嘅
//        未轉義屬性入口喺度，只會等日後有人誤用而變成 XSS 缺口；
//      · devtools.css 刪除 [data-dev-version] 嘅 pointer-events 防禦規則。
//      ⚠ 唔保留「冇元素符合」嘅死規則：日後若有人為其他用途重用呢個屬性名，
//        就會莫名其妙繼承該規則嘅 user-select: none，變成極難追查嘅怪 bug。
//   4. ⚠ 已知缺口（本次未處理，唔好當已修好）：devSubmitPassword() 驗證成功後
//      會呼叫 devOpenPanel()，但該函式喺全專案「從來冇存在過」，而且以
//      typeof 守衛包住 —— 即係驗證成功只會出一個 toast，唔會開任何面板。
//      「開發者控制面板」本身係一個尚未實作嘅功能，唔屬本次入口搬遷嘅範圍。
//   5. calendar.js：開頭嘅指引由「連點版本號 5 下進入開發者後台」
//      改為「個人中心 → 關於我們 → 開發者簡介 → 開發者模式」。
//      ⚠ 呢個係使用者／維護者會照住做嘅指示，指向一個已經唔存在嘅入口
//        比冇寫更差 —— 所以雖然只係註解，仍然當作實質變更處理。
//   6. ?v 同步升：devtools.js 1.0.0 → 1.1.0、devtools.css 1.0.0 → 1.1.0、
//      profile.js 3.5.3 → 3.5.4、calendar.js 2.7.0 → 2.8.0；
//      SW 註冊 service-worker.js?v=4.10.0，CACHE_NAME → timetable-v4.10.0。
//      ⚠ SW 對 JS／CSS 係快取優先，唔升 ?v ＋ CACHE_NAME 用戶只會見到舊入口。
//      ⚠ 本專案慣例：只要檔案「內容有改」（包括純註解）就要升 ?v；
//        完全冇改嘅檔案（profile-content.js、main.js、profile.css）維持原值。
//   7. ⚠ APP_VERSION 維持 3.5.1 不變（依既有政策，改 UI／加功能唔升介面版本號）。
//
// 版本號升級：4.8.0 → 4.9.0
// 本次變更（重新加入開發者模式：連點版本號 5 下 → 伺服器端密碼驗證）：
//   1. 🆕 scripts/modules/devtools/devtools.js（新檔，?v=1.0.0）：
//      · 密碼比對完全唔喺前端做 —— 本檔只係一條 RPC 通道：
//        送密碼上 Supabase、收返角色
//        （dev_verify_password / dev_my_role / dev_revoke_role）。
//        真正判斷喺 supabase/developer-mode.sql（bcrypt ＋ UUID 白名單）。
//      · 密碼彈窗由 JS 即場建立（舊版 .dev-pwd-overlay DOM 已隨 v3.16.0 刪除），
//        沿用 devtools.css 嘅 .dev-pwd-* 樣式。
//      · 連點入口用事件委派掛喺 document（capture 階段）：
//        「關於我們」頁由 profilePushDetail() 每次重新渲染，
//        直接綁元素嘅監聽會隨節點被換走而失效（第一次得、之後撳極都冇反應）。
//      · ⚠ 刻意唔喺本檔掛 DOMContentLoaded：main.js 都用同一事件觸發 initApp()，
//        而本檔排喺 main.js 之前 —— devBootstrap() 會跑喺 authInit() 之前，
//        嗰刻讀唔到帳號／session，角色永遠同步唔到。
//        改由 main.js 嘅 initAppShell() 明確呼叫。
//   2. 🆕 scripts/modules/devtools/devtools.css（新檔，?v=1.0.0）：
//      .dev-pwd-* 彈窗樣式 ＋ [data-dev-version] 嘅 pointer-events: auto
//      防禦規則（避免日後上游加 pointer-events: none 令入口靜靜失效）。
//   3. index.html：
//      · <head> 引入 devtools.css（排喺 liquidglass.css 之後 —— 彈窗要喺最上層）；
//      · body 引入 devtools.js（排喺 profile.js 之後、main.js 之前）；
//      · 頁尾版本號加 data-dev-version；
//      · 「開發者模式已徹底移除」嗰段註解改寫為「已改為伺服器端驗證重新加入」。
//   4. profile.js：profileInfoRowHtml() 新增可選第三參數 attrs，
//      「關於我們」頁版本列傳入 'data-dev-version' 作為入口標記。
//      ⚠ attrs 刻意唔轉義，只可以傳寫死嘅字串，唔可以傳使用者／網絡資料。
//   5. main.js：initAppShell() 於 purgeLegacyDevFlags() 之後呼叫 devBootstrap()。
//   6. ?v 同步升：devtools.js 1.0.0（新檔）、devtools.css 1.0.0（新檔）、
//      profile.js 3.5.2 → 3.5.3、main.js 3.5.1 → 3.5.2；
//      SW 註冊 service-worker.js?v=4.9.0，CACHE_NAME → timetable-v4.9.0。
//      ⚠ precache 一定要加埋兩個新檔，否則首次離線開 App 會冇彈窗樣式／邏輯。
//   7. ⚠ APP_VERSION 維持 3.5.1 不變（依既有政策，改 UI／加功能唔升介面版本號）。
//
// 版本號升級：4.7.0 → 4.8.0
// 本次變更（「關於我們」次頁面最底部新增致敬標語）：
//   1. icons.js：新增 heart（心形）圖示。
//      ⚠ 需求原文指定用 ❤️ emoji，但本專案明令「系統 UI 嚴禁 Emoji」
//        （見 icons.js 開頭「Emoji 使用邊界」、index.html 圖示系統註解）。
//        故改用 icons.js 嘅 SVG 心形，紅色由 CSS 嘅 --ios-red 提供 ——
//        觀感同 ❤️ 一致（紅心 ＋ 灰字），但深淺主題各自有正確嘅紅，
//        亦唔會被系統 emoji 字型改寫外觀。
//      ⚠ heart 刻意冇加入 APP_ICON_LEGACY：佢只由程式碼直接引用
//        （data-icon="heart"），並非由假期／活動資料嘅 emoji 欄位解析出嚟，
//        所以冇「舊資料要向後相容」嘅需要。
//   2. profile-content.js：新增 PROFILE_ABOUT_TRIBUTE（致敬標語，單一來源）。
//      ⚠ 心形刻意唔包含喺字串內，由 profile.js 另外拼 SVG ——
//        否則會變成「emoji ＋ SVG」兩套圖示語言並存。
//   3. profile.js：profileDetailAboutHtml() 頁尾加 <p class="detail-tribute">。
//      ⚠ 用 <p> 而唔用 profileListCardHtml()：呢句唔可撳、冇箭頭、冇分隔線，
//        唔屬於清單內容，依架構規則唔可以用 .ios-card 包裹。
//      ⚠ 心形照本專案慣例用 data-icon ＋ hydrateIcons()，唔硬寫 <i> 或 <svg>。
//   4. profile.css：新增 .detail-tribute / __icon / __text 三段 ＋ 頂部索引更新。
//      ⚠ 垂直間距刻意只寫 margin-top: 8px：#profile-detail-body 係 .ios-home
//        （gap: 16px），8 ＋ 16 ＝ 24px 先符合需求；直接寫 24px 會變成 40px，
//        因為 flex 嘅 gap 同子項 margin 係「相加」而唔係「取較大值」。
//      ⚠ 文字色用 --text-muted 而唔係需求文件寫嘅 #888888：硬編灰喺深色主題
//        （--text-muted = #94a3b8）對比不足，亦唔跟主題切換。
//      ⚠ 字級 0.85rem 係刻意用 rem：呢句屬頁尾註腳級別，跟隨瀏覽器字級設定
//        縮放對閱讀輔助功能較友善（模組內其餘文字仍然用 px）。
//   5. ?v 同步升：icons.js 2.12.0 → 2.13.0、profile.css 3.33.0 → 3.34.0、
//      profile-content.js 3.5.1 → 3.5.2、profile.js 3.5.1 → 3.5.2；
//      SW 註冊 service-worker.js?v=4.8.0，CACHE_NAME → timetable-v4.8.0。
//      ⚠ 呢啲標記只係「新舊檔案嘅指紋」，關鍵係必須變成未出現過嘅值，
//        否則 SW 嘅快取優先會令用戶永遠命中舊檔。
//      ⚠ 介面版本 APP_VERSION 維持 3.5.1 不變（依使用者明確指示，
//        改 UI／加內容唔升介面版本號，見 db.js 的版本政策）。
//
// 版本號升級：4.6.0 → 4.7.0
// 本次變更（「關於我們」頁尾新增第三個卡片分組「開發者簡介」）：
//   1. profile-content.js：新增 PROFILE_DEVELOPER_NAME / _TAGLINE / _FOCUS。
//      ⚠ 依該檔開頭嘅單一來源原則：文案一律放資料檔，profile.js 只負責渲染。
//      ⚠ 團隊名沿用法律條文已使用嘅「（App 名）開發團隊」講法，唔另創新名；
//        亦冇加未經確認嘅成員姓名或作品連結 —— 本專案明令唔可以造假資料
//        （見 profile.js profileDetailDevicesHtml 對「其他裝置」照實留空）。
//      ⚠ 「絕大多數資料只存放喺你嘅裝置」係對應私隱政策原文，刻意唔寫成
//        「所有資料都唔會上傳」：雲端同步係確實存在嘅功能，絕對句會變假陳述。
//   2. profile.js：profileNavRowHtml() 新增第 5 個（選用）參數 icon。
//      ⚠ 向後相容：現有 13 個呼叫點全部維持 4 個參數，只有新嘅開發者簡介列
//        會傳 icon。留空時輸出同舊版一致，所以唔會影響任何現有頁面。
//      ⚠ 圖示只拼入 data-icon 屬性值，再由 hydrateIcons() 水合成單色線條 SVG；
//        唔可以改成 <i class="icon-user">：硬寫 <i> 攞唔到 stroke: currentColor，
//        深淺主題會走音（見 profile.css 5-2 圖示欄註解）。
//   3. profile.js：PROFILE_DETAIL_PAGES 新增 developer 條目 ＋
//      profileDetailDeveloperHtml()。
//      ⚠ 刻意唔提供 openDeveloperModal()：本專案明令「全站禁止 Modal」，
//        所有子頁面一律經 profilePushDetail() 推入 #profile-detail-body ——
//        同上一版加「關於我們」嘅理由完全一致。需求文件寫嘅 openDeveloperModal()
//        唔可以照做，否則同一層會出現兩套導覽語言。
//      ⚠ 支援信箱唔放入 profileInfoRowHtml() 右側數值欄（max-width: 62% ＋
//        ellipsis 會截成「contact@pcmstimet…」），只經動作列處理。
//   4. profile.js：profileDetailAboutHtml() 頁尾加第三張卡（單列「開發者簡介」）。
//      ⚠ profile.css 一行都冇改，所以 profile.css?v 保持 3.33.0 ——
//        #profile-detail-body 本身就係 class="ios-home"，已有 gap: 16px，
//        第三張卡嘅垂直間距係自動嘅；加 margin-top 反而會變成兩層間距。
//      ⚠ 卡片上面刻意唔加 <p class="ios-group-title">「開發者簡介」，
//        否則同下面嗰列會連續出現兩次同樣嘅四隻字。
//      ⚠ icons.js 完全冇改：user 圖示（人形）係既有圖示，唔需要新增。
//        （icons.js 目前冇 code／terminal，要用嗰兩個就要先註冊 ＋ 同步升版。）
//   5. ?v 同步升：profile-content.js 1.4.0 → 3.5.1、profile.js 3.36.0 → 3.5.1；
//      SW 註冊 service-worker.js?v=4.7.0，CACHE_NAME → timetable-v4.7.0。
//      ⚠ 標記嘅取值用當前 App 版本號（3.5.1）只係一個「指紋」，
//        關鍵係佢必須變成一個未出現過嘅值，否則 SW 嘅快取優先會派舊檔。
//      ⚠ 呢度 4.6.0 → 4.7.0 只係 SW／快取嘅代際編號；介面版本 APP_VERSION
//        維持 3.5.1 不變（依使用者明確指示，改 UI／加功能唔升介面版本號）。
//
// 版本號升級：4.5.0 → 4.6.0
// 本次變更（NOW 卡「今日無課堂」空狀態的可讀性修正）：
//   1. cards.css：新增 .status-card.now.no-class 樣式區塊。舊版呢個空狀態由
//      main.js 用 inline style 硬寫（卡 #444／標頭 #666／卡身 #2c2c2e），
//      但卡身文字係繼承 .status-body 嘅 var(--text-dark) —— 深色主題下
//      --text-dark = #ffffff（睇得見），淺色主題下係 #1C1C1E（近黑），
//      疊喺 #2c2c2e 深灰底上對比只有約 1.05:1 → 「今日無課堂」完全隱形。
//      新樣式一律硬寫 #ffffff（on #2c2c2e ≈ 13.9:1，AAA），並補齊 flex 居中、
//      min-height 128px 與文字微光；標頭改中性灰 #48484a（≈ 9.1:1）。
//   2. main.js：no-class 分支改為輸出 class="status-card now no-class"，
//      移除全部 inline style，狀態樣式從此只有 cards.css 一個來源。
//      ⚠ 安全性：現有 needRebuild 邏輯會比對 .subject 文字同 .countdown-label，
//        「無課 ↔ 有課」切換時兩者必定不同 → 一定觸發整卡重建，
//        所以由 inline 改為 class 唔會出現「class 換唔到」嘅殘留。
//   3. ⚠ APP_VERSION（介面顯示版本，見 db.js）維持 3.5.1 不變 ——
//      依使用者明確指示，改 UI／執 CSS／修 bug 一律唔升介面版本號。
//      下面 4.5.0 → 4.6.0 只係 SW／快取嘅代際編號（CACHE_NAME），
//      同介面版本係兩條獨立嘅線，唔好混為一談。
//   4. ?v 同步升：cards.css 新增標記 3.5.1（原無標記）、main.js 3.9.1 → 3.5.1；
//      SW 註冊 service-worker.js?v=4.6.0，CACHE_NAME → timetable-v4.6.0。
//      ⚠ SW 對 CSS／JS 係快取優先，唔升 CACHE_NAME + ?v 用戶永遠見唔到新畫面。
//
// 版本號升級：4.4.0 → 4.5.0
// 本次變更（個人中心「社群與分享」卡片新增「關於我們」）：
//   1. index.html：卡片 5「社群與分享」由 1 行變 2 行 —— 喺「邀請朋友」下面
//      新增「關於我們」（data-icon="info"、onclick=profilePushDetail('about')）。
//      ⚠ 兩行之間嘅分隔線係自動嘅，profile.css 一行都冇改：現有
//        .ios-row:not(:last-child) { border-bottom: 0.5px solid var(--lg-line); }
//        已經會喺同一個 .ios-list 內嘅相鄰列之間出線，所以「兩個項目之間
//        保留與上面卡片相同的分隔線」唔需要任何新 CSS。
//   2. icons.js 亦冇改：info 圖標（圓圈 + i）早已經存在，唔需要為此加圖標。
//      ⚠ 刻意用 SVG 而唔用 ℹ️ emoji：全站嚴禁 emoji 圖示，而且 emoji 唔會跟
//        --text-muted 變色，深淺主題會走音。
//   3. profile-content.js：新增 PROFILE_ABOUT_DESC（關於我們嘅一句簡介）。
//      ⚠ 文案放資料檔而唔係寫死喺 profile.js，係依 profile-content.js 開頭
//        嘅單一來源原則（該檔明言「要改文案只需要改這一個檔案」）。
//   4. profile.js：PROFILE_DETAIL_PAGES 新增 about 條目，並新增
//      profileDetailAboutHtml()（放喺「社群與分享」區塊尾）。
//      ⚠ 刻意唔提供 openAboutUsModal()：本專案明令「全站禁止 Modal」，
//        所有子頁面一律經 profilePushDetail() 以 Push 動畫推入共用容器
//        #profile-detail-body。該容器本身就係 class="ios-home"，所以卡片
//        間距自動沿用主選單，同樣唔需要新 CSS。
//      ⚠ 入口只在已登入時見得到（openProfilePanel()：未登入會先去 auth／accounts），
//        所以關於頁照樣走 profilePushDetail() 嘅登入檢查，同隔離幾頁一致。
//   5. profile.js：支援信箱刻意冇放入 profileInfoRowHtml() 嘅右側數值欄 ——
//      嗰欄係 max-width: 62% + text-overflow: ellipsis，26 字嘅電郵會被截成
//      「contact@pcmstimet…」，睇唔到又複製唔到（該函式註解亦明令只傳短值）。
//      改為沿用既有動作列（以電郵聯絡我們 / 回報問題 / 複製版本資訊）＋
//      兩篇法律條文入口，全部轉去已有頁面，零新邏輯。
//   6. 版本號一律經 profileAppVersion() 取 APP_VERSION（db.js，全站唯一來源），
//      唔喺關於頁再硬編一次，避免升版本時兩份走音。
//   7. profile.css 完全冇改，所以 profile.css?v 保持 3.33.0
//      —— 依「冇改嘅檔案唔應該無故升版」嘅既有先例（見 3.28.0 一次）。
//   8. ?v 同步升：profile-content.js 1.3.0 → 1.4.0、profile.js 3.35.0 → 3.36.0；
//      SW 註冊 service-worker.js?v=4.5.0，CACHE_NAME → timetable-v4.5.0。
//      ⚠ SW 對 CSS／JS 係快取優先，唔升 CACHE_NAME + ?v 用戶永遠見唔到新畫面。
//
// 版本號升級：4.3.0 → 4.4.0
// 本次變更（老師全級總課表：直立卡片清單 → 傳統週課表網格）：
//   1. weekly.js：weeklyRenderTeacherGlobal() 由「按星期分組嘅直立卡片清單」
//      改為「橫軸＝星期 × 縱軸＝節次」嘅傳統週課表網格。
//   2. weekly.js：⚠ 網格索引值改用「陣列」，唔可以再 slots[key] = cls。
//      實測全級資料有 18 個「同老師、同日、同節、跨多班」嘅格
//      （例如余靜雯 週二第 1 節同時掛初二光／初二善／初二望），
//      用物件直接賦值會覆蓋掉同格其他班、靜靜漏資料。
//      單格多堂時按科目分組：同一科只寫一次科名，下面列出所有班級標籤。
//   3. weekly.js：新增 weeklyLessonsTimeMap()／weeklyGlobalPeriodCount()。
//      節次時間表改由「全級掃到嘅課堂」推導 —— 原本 weeklyPeriodTimeMap()
//      只讀 scheduleData（＝目前班級），跨班時會拎唔到某啲節次嘅時間。
//      縱軸節次數取 max(WEEKLY_PERIOD_COUNT, 資料最大節次)：實測 6 班皆為
//      1~7 節，故實際出 7 行；刻意唔寫死 8 行（會多一格永遠空白），
//      而日後真係加第 8 節時會自動延伸，唔會漏課。
//   4. weekly.js：⚠ 橫軸保留「週一～週六」（WEEKLY_DAYS），唔只週一～週五：
//      全級資料實測有 30 堂週六課，砍掉會直接漏課。
//   5. weekly.js：openWeeklyModal() 加第二個參數 extraClass（可選）。
//      ⚠ 唔傳 == 行為同以前完全一樣，原有「老師單班」「科目」彈窗不受影響。
//   6. weekly.css：彈窗 C 改用 .tg-grid／.tg-cell／.tg-cell-badge，並新增
//      .info-modal-content.is-wide（380px → 470px；否則 7 欄每欄僅約 47px，
//      「科目 + 班級標籤」會擠壓變形）＋ .week-modal-scroll 橫向滾動
//      （手機上網格保持最小可讀寬度，唔會變形）。
//      舊嘅 .tg-day-group／.tg-item／.tg-class-badge 等直立清單樣式已移除。
//      班級標籤用 var(--primary-color) 實心底 + 白字，深淺主題皆突出，
//      唔需要額外深色覆寫（沿用 .class-prompt__btn 嘅配色慣例）。
//   7. ?v 同步升：weekly.js 2.6.0 → 2.7.0、weekly.css 2.6.0 → 2.7.0；
//      SW 註冊 service-worker.js?v=4.4.0，CACHE_NAME → timetable-v4.4.0。
//
// 版本號升級：4.2.0 → 4.3.0
// 本次變更（「點老師姓名」由單班改為全級跨班級課表）：
//   1. weekly.js：新增 showTeacherGlobalSchedule(teacherName)。
//      舊版 openTeacherScheduleModal() 只掃 scheduleData（＝目前選中班級），
//      所以點老師名只見到「該班」嘅課。新版改為掃 DB 內「所有已註冊班級」
//      嘅課表集合（schedule:<classId>），逐堂標註授課班級。
//      ⚠ openTeacherScheduleModal 保留不刪：仍然係「單班檢視」同後備路徑
//        （全級掃唔到嘢時退回佢，避免彈出一個空白窗）。
//   2. weekly.js：課表格嘅老師名點擊加上 event.stopPropagation()，
//      避免同一個 click 冒泡到課堂卡片本身嘅處理器，令兩個彈窗互相蓋住。
//   3. weekly.js：⚠「schedule:default」刻意排除在全級掃描之外。
//      佢係「冇專屬檔案班級」嘅後備課表，內容同真實班級重疊，
//      一齊掃會令同一堂課被計兩次。只有連一個真實班級都冇時才用佢。
//   4. weekly.css：新增 .tg-* 樣式（授課班級標籤、星期分組）與
//      .info-modal-empty 空狀態。
//   5. ?v 同步升：weekly.js 2.5.1 → 2.6.0、weekly.css 2.5.0 → 2.6.0；
//      SW 註冊 service-worker.js?v=4.3.0，CACHE_NAME → timetable-v4.3.0。
//
// 版本號升級：4.1.0 → 4.2.0
// 本次變更（使用者主動登出的「零殘留」清理 + 欄位約束加固）：
//   1. auth.js：新增 authSignOutSecure()。舊版 profileConfirmLogout() 呼叫
//      authSignOut()，而後者是 fire-and-forget —— cloudSignOut() 冇 await，
//      造成「UI 已顯示已登出、但撤銷請求仲喺度跑」的窗口。公用電腦上使用者
//      一撳登出就閂頁，嗰個 POST /auth/v1/logout 有機會從未送出，
//      伺服器端 refresh token 於是繼續有效。現改為 await（內部 5 秒逾時）。
//   2. auth.js：新增 authSweepSensitiveKeys() 與 AUTH_SENSITIVE_KEYS 白名單。
//      ⚠ 刻意唔用 localStorage.clear()：那會連 theme 與 user_class 一齊殺，
//        令使用者登出後主題與班級偏好都跑掉（非預期的資料遺失）。
//      ⚠ 亦刻意唔清 appdb_v1_<課表集合>：那是使用者自己的內容，唔係憑證。
//        強制清除等同「一登出就冇咗課表」，尚未同步的離線編輯更會直接消失。
//        公用電腦情境請用 authSignOutSecure({ wipeLocalData: true })。
//   3. cloud.js：新增 cloudPurgeAccountData(accountId)，只清該帳號的待送佇列
//      （可能含姓名／班級／頭像 Base64）與同步時間戳，唔會誤刪其他帳號的佇列。
//   4. auth-config.js：新增 logoutRevokesCredential 開關（預設 true）。
//      設為 false 即保留續期權杖、帳號切換免密碼（= 舊版行為）。
//   5. cloud.js：SB_FIELD_LIMITS.name 60 → 50，配合 schema.sql 新的
//      profiles_field_guard（name ≤ 50）。兩者必須一致，否則會出現
//      「前端話送得出、伺服器話唔收」的落差。
//   6. 新增 _headers（CSP + 安全標頭）。⚠ CSP 暫時保留 'unsafe-inline'：
//      index.html 有 46 處 inline onclick、profile.js 另有 14 處以字串產生，
//      加上 7 處 style="" 屬性；移除 'unsafe-inline' 會令所有按鈕即時失效。
//      重構步驟寫在 _headers 第 3 節，未完成前唔好刪。
//   7. ?v 同步升：auth-config.js 3.0.0 → 3.1.0、cloud.js 2.2.0 → 2.3.0、
//      auth.js 3.0.0 → 3.1.0、profile.js 3.34.0 → 3.35.0；
//      SW 註冊 service-worker.js?v=4.2.0，CACHE_NAME → timetable-v4.2.0。
//
// 版本號升級：4.0.0 → 4.1.0
// 本次變更（雲端邊界的輸入淨化，以及一個真實 XSS 入口的修補）：
//   1. cloud.js：新增 sbCleanText() / sbCleanAvatar() / sbCleanField()，
//      在推送 Supabase 之前（sbToRow）與讀回本機之後（sbFromRow）各做一次淨化。
//      ⚠ 這不是防 SQL 注入 —— PostgREST 全程使用參數化查詢，注入本身不存在。
//        真正要擋的是三件事：超長字串撐爆資料列、控制字元（\u0000）令
//        PostgreSQL 直接拒收整筆寫入、以及頭像被塞入危險的 URL scheme。
//      ⚠ 刻意不在寫入階段做 HTML 轉義：那會永久污染儲存值
//        （真名 "A&B" 會存成 "A&amp;B"），轉義屬於輸出階段（escapeHtml）。
//   2. 修補一個真實的 XSS 入口：profile.js 有三處把頭像字串「未轉義」地
//      接進 innerHTML（header-user__avatar 與兩個 acc-item__avatar），
//      而該值來自雲端同步 —— 寫入者可以經同步把載荷派發到自己所有裝置。
//      修法：scheme 白名單（只准 data:image/ 與 https://）集中在 cloud.js 的
//      sbCleanAvatar()，profile.js 的 profileAvatarSrc() 一律先過它，
//      四個渲染點於是同時受保護（單一真相，唔重複一份規則）。
//   3. supabase/schema.sql：新增 profiles_field_guard CHECK 約束，把
//      「欄位長度上限 + 頭像 scheme 白名單」寫進資料庫本體。
//      前端淨化只擋得住正常使用路徑；任何人打開 DevTools 都可以直接對
//      PostgREST 發請求，只有寫在資料庫的約束係無法繞過嘅。
//   4. ?v 同步升：cloud.js 2.1.0 → 2.2.0、profile.js 3.33.0 → 3.34.0；
//      SW 註冊 service-worker.js?v=4.1.0，CACHE_NAME → timetable-v4.1.0。
//
// 版本號升級：3.40.0 → 4.0.0
// 本次變更（後端由 Google Sheets 全面遷移至 Supabase PostgreSQL）：
//   1. 徹底移除 Google Apps Script Web App 後端（含整個 google-apps-script/ 目錄）。
//      ⚠ 舊架構的安全隱患：GAS Web App 網址等同「萬能鑰匙」，
//        任何取得網址的人都可以讀寫全部帳號紀錄，無法做到最小權限。
//   2. 新增 supabase/schema.sql：profiles 資料表 + RLS 政策 + 自動建立個人檔案的 Trigger。
//      密碼改由 Supabase Auth（GoTrue）以 bcrypt 於伺服器端雜湊儲存，
//      前端唔再自行計算 salted SHA-256，亦唔再持有任何密碼雜湊。
//   3. scripts/config/auth-config.js：改為 Supabase 連線資訊
//      （url / publishableKey / table）。只使用可公開的 Publishable Key，
//      永不使用 Secret Key —— 前端程式碼任何人都可以睇到。
//   4. scripts/modules/auth/cloud.js：傳輸層由 GAS JSON 改為 Supabase REST
//      （Auth /auth/v1/* + PostgREST /rest/v1/profiles），統一用原生 fetch，
//      零 CDN、零建置工具、零 npm 依賴。所有 cloud* 公開函式簽名維持不變。
//   5. scripts/modules/auth/auth.js：移除前端加鹽雜湊與 salt / passwordHash 欄位，
//      登入改為「Supabase 為真實來源、本機快取只作離線後備」；
//      離線登入僅在該帳號存有有效 refresh token 時才允許。
//   6. 多帳號切換：Supabase 一個瀏覽器只有一條 Session，
//      故改為每帳號各自保存 refresh token（只存本機、唔會上傳雲端），
//      切換帳號時以 refresh token 換取該帳號的 access token。
//   7. 舊資料遷移：舊版 acc_xxx 本機帳號首次登入時，
//      會按 Email 認領並改寫為 Supabase UUID 紀錄，保留最早的 createdAt。
//   8. ?v 同步升：auth-config.js 3.0.0、cloud.js 2.0.0、auth.js 3.0.0、
//      profile-content.js 1.3.0、profile.js 3.33.0、main.js 3.9.1；
//      SW 註冊 service-worker.js?v=4.0.0，CACHE_NAME → timetable-v4.0.0。
//   9. index.html：<head> 加入 Supabase 官方 CDN SDK（@supabase/supabase-js UMD，
//      defer ＋ jsdelivr preconnect）。cloud.js 的 sbSdkClient() 惰性建立用戶端，
//      登入／註冊／續期優先走 SDK（取其穩定的 error.code），
//      PostgREST 資料端點維持原生 fetch。
//      ⚠ SDK 屬「選用強化層」：CDN 被封或首次離線開 App 時自動退回原生 fetch，
//        帳號功能完全唔會中斷，亦唔會令 Splash 多等一個第三方請求。
//      ⚠ cloud.js ?v 2.0.0 → 2.1.0（所以 CACHE_NAME 唔需要再升）。
//
// 版本號升級：3.39.0 → 3.40.0
// 本次變更（假期改為「動態節日問候語」）：
//   1. main.js：
//      · 新增 holidayGreeting()：由假期 name 推導「XX節快樂」。
//        先剝走尾部修飾詞（翌日／補假／假期…）再按結尾補字，
//        避免出現「中秋節翌日快樂」「國慶假期快樂」呢類怪句：
//        國慶假期 → 國慶節快樂；教師節假期 → 教師節快樂；
//        中秋節翌日 → 中秋節快樂；元旦假期 → 元旦快樂。
//      · 新增 holidayCapsuleHtml()：倒數區嘅「假期中 · XX節快樂」狀態膠囊。
//        ⚠ 系統 UI 禁用 Emoji，時鐘用 SVG icon('clock')，唔用 🕒。
//      · updateRealtimeStatus()：是日為假期 → 完全唔計任何倒數（NOW／下一節／放學），
//        倒數區改為出假期膠囊。用 realtimeHolidayKey 記住「而家顯示緊邊個假期」，
//        因為本函式每秒都跑，唔加呢個 key 就會每秒重寫 innerHTML、
//        令膠囊入場動畫不停重播。非假期自動清 key 並還原正常倒數。
//      · scheduleHolidayCardHtml()：假期卡標題由「是日為學校假期」
//        改為動態問候語（例：中秋節快樂），副標題保留「是日為學校假期，祝您假期愉快！」。
//   2. styles/pages/realtime.css：新增 .status-capsule 假期膠囊樣式
//      （沿用主題變數，深淺色模式自動適配）。
//   3. ⚠ 快取：main.js ?v 3.8.0→3.9.0 必須同步升；
//      realtime.css 本身無 ?v，靠本次 CACHE_NAME 升級更新。
//
// 版本號升級：3.38.1 → 3.39.0
// 本次變更（新增「學校假期覆蓋課表與倒數」邏輯）：
//   ⚠ 核心需求：只要「今日」命中假期清單（DB 集合 'holidays'），
//     就算課表資料當日照樣有排課，都一律唔顯示課表、唔計算任何倒數，
//     課表頁改為顯示一張簡潔嘅假期提示卡。
//   1. main.js：
//      · 新增假期判斷嘅唯一真相：scheduleDateKey() / getHolidaysOnDate() /
//        isHolidayDate()。支援單日假期（date）同連續假期（date ~ endDate），
//        一律以 YYYY-MM-DD 字串比較（唔理時分秒，避免時區誤判）。
//      · renderSchedule()：優先權最高 —— 所選日期命中假期就即刻 render
//        假期卡（新 scheduleHolidayCardHtml()）並 return，一張課堂卡都唔會出。
//        用詞跟課表頁規定：一律「是日」，非今日則寫成「X月X日為學校假期」。
//      · getScheduleNowSignature()：假期簽名固定為 `<dayKey>#holiday`，
//        令每秒 tick 唔會誤判成「高亮改變」而反覆重繪假期卡。
//      · updateRealtimeStatus()：是日為假期 → 清空並 display:none 收埋
//        #status-container，然後直接 return（暫停所有倒數運算）；非假期自動還原。
//      · initDbBridge()：DB.subscribe('holidays') 追加 renderSchedule() 同
//        updateRealtimeStatus()，假期一改（開發者面板 / 雲端同步）即刻跟住變。
//   2. styles/pages/schedule.css：新增 .schedule-holiday 假期卡樣式
//      （大圖示 + 標題 + 副標題 + 假期名稱/日期膠囊）。
//   3. ⚠ 快取：SW 對 JS／CSS 亦係快取優先，以下 ?v 必須同步升：
//      main.js 3.7.0→3.8.0、schedule.css 2.9.2→2.10.0。
//      urlsToCache 用不帶 query 嘅路徑，所以清單本身唔需要改。
//
// 版本號升級：3.38.0 → 3.38.1
// 本次變更（服務條款去識別化）：條文全文唔再出現具體校名，一律改用中性「學校」表述：
//     · lead：原本「（校名）課表查詢系統」→「課表查詢系統」；
//     · 「關於我們的服務」首項：「查看（校名）課表」→「查看學校課表」；
//     · 「第三方服務與數據來源 · 數據來源與官方通告優先」：
//       官方通告一句由「以（校名）官方發佈」改成「以學校官方發佈」。
//   ⚠ 快取：profile-content.js 1.2.0→1.2.1 必須同步升，否則用戶仍見舊文字。
//
// 版本號升級：3.37.0 → 3.38.0
// 本次變更（法律條文：使用者條約 → 服務條款，並換上官方版全文）：
//   1. profile-content.js：
//      · PROFILE_LEGAL_TERMS 由九條自擬條文，換成官方《服務條款》全文 ——
//        目錄、關於我們的服務、私隱與數據安全、接受使用我們的服務（條款與政策／
//        合法和可接受的使用方式／損害 pcmstimetable 或我們的用戶／保護帳戶安全）、
//        第三方服務與數據來源、免責和棄權聲明、責任限制、補償、
//        我們服務的可用性和終止、其他、聯絡我們。
//      · PROFILE_LEGAL_DOCS.terms 標題「使用者條約」→「服務條款」，
//        meta 改為「生效日期：2026 年 9 月 26 日 · 具法律拘束力」，
//        lead 換成官方開場段落；支援信箱沿用 PROFILE_SUPPORT_EMAIL 常數。
//   2. index.html：「法律與合規」清單入口文字「使用者條約」→「服務條款」
//      （開啟嘅 key 仍然係 doc-terms，只係顯示名同內文一齊換）。
//   3. ⚠ 快取：SW 對 JS／CSS 亦係快取優先，以下 ?v 必須同步升：
//      profile-content.js 1.1.0→1.2.0。
//      urlsToCache 用不帶 query 嘅路徑，所以清單本身唔需要改。
//
// 版本號升級：3.36.0 → 3.37.0
// 本次變更（iOS 18 Liquid Glass 還原：卡片／Header 恢復半透明毛玻璃 ＋ 清理灰色說明小字）：
//   ⚠ 核心問題：上一版為咗清「雙重灰底」，把次頁面嘅卡片壓成「實色 + 零毛玻璃」，
//     結果全站退化做 iOS 17 嘅純白實色卡（Flat White Card）——
//     冇半透明、冇折射、冇光澤，iOS 18 嘅 Liquid Glass 質感完全消失。
//   1. profile.css：
//      · 新增全域 Liquid Glass 色票 --lg-*（--lg-blur / --lg-card-bg /
//        --lg-card-border / --lg-card-shadow / --lg-nav-bg / --lg-line /
//        --lg-row-active），深淺兩色一律由 CSS 變數決定 ——
//        卡片、導覽列、分割線從此只有一組真相，唔會再有兩套玻璃、兩種灰。
//      · .ios-card 改回玻璃四件套：background rgba(255,255,255,0.65)（淺）／
//        rgba(30,30,30,0.65)（深）、backdrop-filter blur(25px) saturate(190%)、
//        1px 玻璃折射邊框（淺 rgba(255,255,255,0.5)／深 rgba(255,255,255,0.15)）、
//        box-shadow 0 8px 32px rgba(0,0,0,0.04)（淺）＋ 頂部 1px 鏡面高光、
//        border-radius 20px（iOS 18 大圓角）。
//      · 刪除 .sub-page .ios-card 同 :root[data-theme="light"] .sub-page .ios-card
//        兩條「實色變體」—— 變體一存在，主頁同次頁面就會各自演化成兩套玻璃。
//      · .sub-page / --sub-page-bg 由實色改回「半透明系統材質」
//        （深 rgba(0,0,0,0.62)／淺 rgba(242,242,247,0.62)）：
//        下面嘅極光透得上嚟，卡片嘅 backdrop-filter 才有真嘢可以折射。
//        .sub-page__body 底色改 transparent，避免同一隻半透明色疊兩層。
//      · .profile-topbar 同 .sub-page__nav 一併套用 --lg-nav-bg ＋ --lg-blur，
//        導覽列同樣係 Liquid Glass，並加 0.5px --lg-line Hairline。
//      · 全站分割線（.ios-row / .ios-choice / .detail-stat / .detail-action /
//        .detail-doc__meta / .detail-doc__caps）統一改成
//        0.5px solid var(--lg-line)，刪除所有寫死嘅 rgba 同淺色覆寫規則。
//   2. profile.js：徹底清理灰色說明小字（介面只留「一行一項」）——
//      · profileInfoRowHtml() 由「標題 + 灰色副標題兩行」改成
//        「左標題 + 右數值單行」（新類別 .ios-row__value）；
//      · 刪除「本版本只在本機保存登入狀態」、「於註冊時設定，本版本未支援在
//        個人中心更換」、「· 目前使用中」、「管理本機帳號密碼」等解釋句；
//      · 安全通知頁三列由「不適用 · 沒有帳號伺服器」收斂成純值「不適用 / 開啟中」。
//        ⚠ 「其他裝置」等分組小標題（.ios-group-title）屬必要分組，一律保留。
//   3. ⚠ 快取：SW 對 JS/CSS 亦係快取優先，以下 ?v 必須同步升：
//      profile.js 3.31.0→3.32.0、profile.css 3.32.0→3.33.0。
//      urlsToCache 用不帶 query 嘅路徑，所以清單本身唔需要改。
//
// 版本號升級：3.35.0 → 3.36.0
// 本次變更（全站次頁面架構重構：淘汰浮空 Pop-up 框，改為真全螢幕 iOS Push 頁面）：
//   ⚠ 核心問題：上一版雖然已刪走模態抽屜，但次頁面仍然係「浮在半空」——
//     佢哋住喺 .profile-scroll 入面，被 16px 內距 + .ios-home 嘅 16px gap +
//     margin-top 補丁三重重複推開，睇落似一張張飄住嘅卡；再加上半透明玻璃
//     面板之上再疊半透明卡片（backdrop-filter），就係用戶見到嘅「雙重灰底」。
//   1. index.html：新增全螢幕次頁面層 .sub-page（#profile-subpage）——
//      自己一條 .sub-page__nav（左 #subpage-back「‹」、中間 #subpage-title
//      絕對居中、右 #subpage-more「⋯」）＋ 自己嘅捲動容器 .sub-page__body。
//      #profile-view-account 同 #profile-view-detail 由 .profile-scroll 搬入呢層。
//      刪除面板頂部已被取代嘅 #profile-more（避免同一頁兩粒「⋯」/ 兩套導覽語言）。
//   2. profile.css：新增「3-5 全螢幕次頁面」整節 —— 100% 寬高實色容器、
//      translateX(100%) → 0 嘅 iOS Push 轉場、44px 導覽列（含 safe-area）、
//      標題絕對居中、頁面底色改用 iOS 系統背景（深 #000 / 淺 #F2F2F7）、
//      卡片改實色（深 #1C1C1E / 淺 #FFF）徹底消除 backdrop-filter 疊色。
//      ⚠ 刪除舊版「次頁面加 16px margin-top」補丁（雙重內距來源）。
//      ⚠ 保險索選擇器由 .profile-scroll 提升到 .profile-panel（視圖已搬出捲動區）。
//   3. 卡片使用規範：圓角卡片只保留畀「設定清單」（Toggle / Checkmark /
//      箭頭跳轉）；長文章（四篇法律條文）文字直接渲染在頁面 Body、
//      嚴禁卡片外框 —— .detail-doc__caps 由圓角灰底卡改成純文字 + 頂部分隔線，
//      .detail-callout 由圓角強調卡改成無底置中文字，
//      .detail-link 由半透明灰底改成實色欄位。
//   4. profile.js：profileShowView() 接駁 .sub-page 開關（.is-on + aria-hidden）、
//      次頁面標題／「⋯」／捲動重置；closeProfilePanel() 與 profileGoTab()
//      補上重設 .is-on（否則下次開主頁會見到上一頁子頁面滑走）。
//   5. ⚠ 快取：SW 對 JS/CSS 亦係快取優先，以下 ?v 必須同步升：
//      profile.js 3.30.0→3.31.0、profile.css 3.31.0→3.32.0。
//      urlsToCache 用不帶 query 嘅路徑，所以清單本身唔需要改。
//
// 版本號升級：3.34.0 → 3.35.0
// 本次變更（全站刪除模態抽屜：所有內容一律改為標準 Push 次頁面 ＋ 修正統計列溢出）：
//   1. index.html：刪除 #ios-sheet-overlay 整組 DOM（拖曳條、標題、右上 ❌、
//      #ios-sheet-body）。「帳戶」頁九個入口全部改用 profilePushDetail()：
//      privacy / storage / faq / feedback / contact / doc-*（四篇法律條文）/ invite；
//      「登出」亦改為 profilePushDetail('logout')（確認頁，唔再彈抽屜）。
//   2. profile.js：刪除抽屜引擎（profileOpenSheet / profileCloseSheet /
//      profileSheetNodes / profileSheetOpen 狀態、ESC 與點背景關閉、焦點管理），
//      九個原抽屜內容改寫成 profileDetail*Html() 並註冊落 PROFILE_DETAIL_PAGES。
//      新增頁面級 after 回呼：storage 非同步填數字、invite 按瀏覽器能力收列。
//      四篇法律條文改為由 PROFILE_LEGAL_DOCS 自動註冊為 doc-<key>（標題單一來源）。
//      ESC 行為改為「先彈最上層子頁面，冇得彈才收埋個人中心」。
//      ⚠ 介面唔再有任何解釋性灰字：.sheet-lead / .sheet-note / .detail-note
//        相關段落全部刪除（私隱、儲存空間、回報問題、聯絡支援、安全通知等）。
//   3. profile.css：刪除 5-6 節嘅抽屜樣式（.ios-sheet*）、說明文字樣式、
//      整塊填色大按鈕（.sheet-btn*）；新增 .detail-action（卡片內藍／紅字動作列）。
//      ⚠ 修正統計列數字被切斷：.detail-stat__k 加 min-width: 0 + ellipsis 讓位，
//        .detail-stat__v 用 flex: 0 0 auto + text-align: right + nowrap，
//        數值永遠完整靠右顯示（截圖「2.24 MB / 380.90 GB 貼出咭邊」嘅根因）。
//      sheet-* → detail-* 類別改名（stat / row / field / input / select / textarea /
//      faq / doc / link / callout），唔留低「sheet」呢個已經唔存在嘅概念。
//   4. profile-content.js：註解由 profileOpenContact 更正為 profileDetailContactHtml。
//   5. ⚠ 快取：SW 對 JS/CSS 亦係快取優先，以下 ?v 必須同步升：
//      profile.js 3.29.0→3.30.0、profile.css 3.30.0→3.31.0。
//      urlsToCache 用不帶 query 嘅路徑，所以清單本身唔需要改。
//
// 版本號升級：3.33.0 → 3.34.0
// 本次變更（主頁最頂卡片更正為「已連結裝置」＋新增裝置／Session 子頁面）：
//   ⚠ 前一版 3.33.0 已經係 clean 狀態，本版只做語意／文案與一條新子頁面。
//   1. index.html：主頁最頂卡片由「已連結裝置與 Session」（globe 圖示、
//      onclick = openProfileAccounts()）更正為「已連結裝置」
//      （devices 圖示、onclick = profilePushDetail('devices')）。
//      ⚠ 舊寫法名實不符：撳「裝置」實際彈出「切換帳號」清單。
//        帳號切換仍然存在，入口係「帳戶」頁右上「⋯」（profileAccountMore）。
//   2. icons.js：新增 devices（電腦＋手機，對應 SF Symbols
//      laptopcomputer.and.iphone）；globe 保留（其他位置仍可用）。
//   3. auth.js：新增 authSessionInfo() 唯讀快照（accountId / persistent /
//      expiresAt）—— 刻意唔回傳 token，只為裝置頁顯示 Session 狀態。
//   4. profile.js：新增 PROFILE_DETAIL_PAGES.devices 與
//      profileDetailDevicesHtml()（這部裝置 + 最後登入 + Session 有效期；
//      雲端同步有啟用才顯示同步行）。本 App 冇多裝置後端，所以「其他裝置」
//      照實顯示空狀態，唔造假裝置清單。
//   5. ⚠ 快取：SW 對 JS/CSS 亦係快取優先，以下 ?v 必須同步升：
//      icons.js 2.11.0→2.12.0、auth.js 2.9.0→2.10.0、profile.js 3.28.0→3.29.0；
//      profile.css 保持 3.30.0（本版冇改 CSS）。
//      urlsToCache 用不帶 query 嘅路徑，所以清單本身唔需要改。
//
// 版本號升級：3.32.0 → 3.33.0
// 本次變更（「帳戶」次頁面 UI 收窄：兩張分組卡 ＋ 一張獨立登出卡）：
//   ⚠ 前一版 3.32.0 已經係 clean 狀態，本版只做 UI 結構調整，冇新增／刪除檔案。
//   1. index.html：#profile-view-account 最頂「新增帳戶」卡已由 DOM 移除
//      （「帳戶」頁只保留 登入和安全／你的帳戶 兩張分組卡）。
//      ⚠ profileOpenAddAccount() 仍然有兩個入口，唔係死碼：
//        主頁「已連結裝置與 Session」、本頁右上「⋯」嘅「新增 / 切換帳號」。
//   2. index.html：「登出」由「你的帳戶」卡拆出，成為最底一張獨立單行卡，
//      文字置中（.ios-row__body--center）、無圖示、無箭頭，點擊照舊先彈二次確認。
//   3. profile.css：.ios-row.is-danger .ios-row__label 統一為 iOS 原生警告紅
//      #ff3b30（深色主題原本係 #ff453a，已一併改掉 —— 兩個主題同一個紅）。
//   4. ⚠ 快取：SW 對 CSS 亦係快取優先，index.html 嘅 profile.css?v= 3.29.0→3.30.0
//      必須同步升，否則已安裝嘅裝置照樣派舊樣式（尤其係登出字色）。
//   5. profile.js 完全冇改，所以 profile.js?v 保持 3.28.0。
//
// 版本號升級：3.31.0 → 3.32.0
// 本次變更（全站聯絡電郵統一為 contact@pcmstimetable.com）：
//   ⚠ 舊值 my-schedule-support@example.com（example.com 係保留域名，實際上寄唔到信）
//     已經全面更換；域名同 APP_CONFIG.siteUrl（https://pcmstimetable.com）一致。
//   ⚠ 全站掃描結果：真正嘅聯絡信箱只有 profile-content.js 嘅 PROFILE_SUPPORT_EMAIL
//     一個常數，以下五處全部由佢取值，所以只需要改一行：
//       1) 「聯絡支援」抽屜顯示文字 + mailto 連結（profileOpenContact）
//       2) 「回報問題 / 意見反饋」mailto 連結（profileSubmitFeedback）
//       3) 「複製支援信箱」按鈕（profileCopyContact）
//       4) 私隱政策「九、政策之變更與聯絡方式」
//       5) 授權條款「八、授權詢問」
//     兩條 mailto: 連結本身冇獨立硬編地址，href 會自動同步成
//     mailto:contact@pcmstimetable.com，所以冇「文字改了但連結未改」嘅風險。
//   ⚠ 刻意唔改嘅：profile.js / index.html 嘅 you@example.com（輸入框 placeholder，
//     只係示範格式）、service-worker.js 註解內嘅示意 gmail 地址（只係舉例說明）。
//   ⚠ 本 App 冇「關於我們」頁、頁尾亦冇放聯絡信箱（只有版本號），所以冇其他位置需要更新。
//   ⚠ 快取：SW 對 JS 亦係快取優先，profile-content.js?= 1.0.0→1.1.0 必須同步升。
//
// 版本號升級：3.30.0 → 3.31.0
// 本次變更（撤銷 3.30.0 嘅 Toggle Switch，改回 iOS 原生極簡藍色勾號）：
//   ⚠ 3.30.0 嘅 Toggle 已被本版完全取代（下面 3.30.0 段落只作歷史記錄，
//     當中提到嘅 --ios-switch-on / --ios-switch-off 兩個 token 已經刪除）。
//     原因：51×31 開關擺喺一張登入卡入面太大舊，搶走主按鈕嘅視覺重心。
//   ⚠ 定案（18px 方框 → Toggle → 勾號列，唔好再行回頭路）：
//     · index.html：#field-remember 由 .auth-field__row 改為 .auth-remember
//       （直向容器），卡片（.auth-check）右緣只有一粒剔號，「忘記密碼？」
//       讓位排喺卡片下方靠右，但仍然留喺 #field-remember 入面 ——
//       profileToggleField('field-remember', false) 切去註冊頁時要一併收埋佢。
//       <input type="checkbox" id="auth-remember"> 完整保留，只係 CSS 收埋。
//     · auth.css：.auth-check = 白色圓角卡片（flex、space-between、
//       padding 12px 16px、radius 14px；深色用微亮填充而唔用純白）；
//       真身 input 以 1px + opacity: 0 隱藏（唔用 display:none，
//       否則連鍵盤 focus 同無障礙報讀一齊殺死）；
//       右側剔號 = SVG data-icon="check"，顏色 --ios-blue（淺色 = #007AFF），
//       用 input:checked ~ .auth-check__mark 兄弟選擇器控制，
//       未選中完全透明（右側留空），但仍佔 20px 位避免文字跳動；
//       焦點光環畫喺剔號上（真身只有 1px 冇人睇得到）。
//       移除 .auth-field__row 及其 margin 規則（改版後已無任何地方使用）。
//   ⚠ 快取：SW 對 CSS 係快取優先，auth.css?= 2.6.0→2.7.0 必須同步升。
//
// 版本號升級：3.29.0 → 3.30.0
// 本次變更（「記住我」由網頁 Checkbox 改為 iOS 原生 Toggle Switch）：
//   ⚠ 問題：「記住我」用 18px 圓角方框 + 白色剔號，係網頁 Checkbox 語彙，
//     同 iOS / WhatsApp 原生質感唔一致。
//   ⚠ 改法（DOM 只改一處，JS 零改動）：
//     · index.html：<label class="auth-check"> 內部次序由「input → 文字」改為
//       「文字 → input」—— iOS 規範係標籤靠左、開關靠右，次序唔調就算換咗樣
//       個開關都會跌在左邊。<input type="checkbox" id="auth-remember"> 本身
//       完整保留（profile.js 靠 remember.checked 取值、label 點擊、鍵盤 Space、
//       螢幕閱讀器報讀全部依賴原生控件），冇換成自繪 <span> 假開關。
//     · auth.css：input 本體就係「軌道」——appearance: none 殺掉瀏覽器預設方框，
//       再自繪 51×31 膠囊（border-radius: 16px，關 = rgba(120,120,128,0.32)、
//       開 = #34C759 systemGreen）；圓形滑塊用 ::after（27px、四周 2px、
//       行程 20px），並用 transform 而唔係 left 做位移（走 GPU 合成層，唔觸發 layout）。
//       另加 :focus-visible 綠色光環取代瀏覽器方角 outline。
//       新增 token --ios-switch-on / --ios-switch-off（兩主題同色，只喺裸 :root 定義）。
//   ⚠ 已全站掃描：<input type="checkbox"> / type="radio" 全項目僅此一處，
//     冇其他殘留嘅網頁原生勾選控件。
//   ⚠ 快取：SW 對 CSS 係快取優先，auth.css?= 2.5.0→2.6.0 必須同步升。
//
// 版本號升級：3.28.0 → 3.29.0
// 本次變更（次頁面 Header 佈局修復：標題居中 + 邊距校正）：純 CSS，冇改 DOM／JS。
//   ⚠ 問題一：標題飛到最右邊。
//     .profile-topbar 用 justify-content: space-between，但三個掣（‹／⋯／×）係由
//     profileShowView() 輪流顯示嘅：子頁面只有「‹ 返回」（⋯ 冇動作時隱藏、× 讓位），
//     枱面剩「返回 + 標題」兩個 flex item，space-between 就將標題推去最右端。
//     → 標題改為 position: absolute + left: 50% + translateX(-50%)，對面板中線絕對
//       居中，無論出現一個、兩個抑或三個掣都唔會移位；
//       配 max-width: calc(100% - 104px) 令長標題自己出省略號，唔會疊住粒掣；
//       pointer-events: none 令標題唔會攔截到掣嘅點擊。
//   ⚠ 問題二（改動必須同步）：標題脫離 flex flow 之後，主頁／登入頁只剩一粒「×」，
//     而 space-between 對「單一 flex item」係推去最左邊 —— 個 × 會飛去左上角。
//     → 補 #profile-more, #profile-close { margin-left: auto }，由掣自己撐去右邊，
//       唔使為咗排版喺 DOM 塞一個空 spacer 節點。
//   ⚠ 問題三：卡片貼死導覽列（回報「內容卡片與返回按鈕距離頂部過近」）。
//     .profile-scroll 頂部只有 4px 內距。
//     → #profile-view-account / #profile-view-detail 嘅 .ios-home 加 margin-top: 16px；
//       唔改 .profile-scroll 本身，因為主頁（開頭係 .wa-head 大頭像區）同登入頁
//       節奏唔同，一律加會令佢哋無啦啦多一截空白。
//   ⚠ 導覽列高度：height: 56px + 上下 padding: 0（唔寫 height: 44px + padding ——
//     本檔案冇全域 box-sizing: border-box，content-box 下 44px 加 padding 會變 68px，
//     反之 border-box 下就只剩 32px 內容空間，兩粒 32px 圓掣會爆出嚟；明確 height
//     加 0 上下內距，兩種 box model 結果一致）。高度寫死係必須：唔靠內容撐，
//     切換視圖時條 bar 就唔會一高一低。
//     ⚠ 瀏海安全區仍然由 .profile-panel 統一負責（@media 內 padding-top:
//       env(safe-area-inset-top) + 10px），.profile-topbar 唔可以再加，否則頂兩層。
//   ⚠ 快取：SW 對 CSS 係快取優先，profile.css?= 3.28.0→3.29.0 必須同步升。
//
// 版本號升級：3.27.0 → 3.28.0
// 本次變更（「外觀與主題」由 Modal 抽屜改成標準次頁面，並清空解釋文字）：
//   ⚠ 核心問題：點「外觀與主題」彈出一個 Modal 抽屜，卡片上下各掛一段解釋文字
//     ——「選擇本 App 的外觀。此設定只儲存在這部裝置。」
//     同「選擇『跟隨系統』時，系統切換深色／淺色，本 App 會即時跟隨…」。
//     三個單選項嘅答案一眼睇得出，兩段小字純屬冗餘；而且全 App 其他設定
//     （密碼／電郵／安全通知／用戶名稱）都已經係「推入次頁面 + ‹ 返回」，
//     只有外觀仲係彈窗，導覽方式唔一致，完全唔似 WhatsApp／iOS 原生設定頁。
//   1. index.html：
//      · 「外觀與主題」行 onclick 由 profileOpenAppearance() 改為
//        profilePushDetail('appearance')（即係推入 #profile-view-detail，有 ‹ 返回）；
//      · 更新該行註解同「狀態 6」容器註解（子頁面 4 → 5 個）。
//   2. profile.js：
//      · 刪除 profileOpenAppearance()（Modal 版本，連上下兩段 sheet-lead／sheet-note）；
//      · 新增 profileDetailAppearanceHtml()：一張卡片、三個選項、零解釋文字，
//        註冊為 PROFILE_DETAIL_PAGES.appearance（標題「外觀」）；
//      · profileChoiceRowHtml() 改為 .ios-choice 標記並刪去 desc 參數
//        —— 三個選項唔再需要副標題；
//      · profileSetTheme() 改為 profileRerenderDetail()（原本係重開抽屜），
//        令剔號即時跳到新選項；
//      · 刪除 profileThemePreference()：佢同 theme.js 嘅 themePreference()
//        係同一支邏輯嘅兩份實作，外觀頁改為直接呼叫後者（單一真相）。
//   3. profile.css：
//      · .sheet-choice / __body / __desc / __mark 整組刪除；
//      · 新增 .ios-choice 樣式並移入「5. iOS 分組卡片」段 ——
//        尺寸同 .ios-row 完全一致（min-height 52px、padding 9px 2px、字級 14px、
//        同一條分割線同按壓回饋），否則佢會喺同一張卡片入面比隔離行矮一截。
//        右側圓形剔號沿用原本設計：未選中灰底透明剔、選中改 --ios-blue 藍底白剔。
//      · ⚠ 唔設 .ios-choice__desc：原生單選清單冇解釋小字。
//   4. ?v 同步升：profile.js 3.27.0→3.28.0、profile.css 3.27.0→3.28.0；
//      SW 註冊 service-worker.js?v=3.28.0。
//      SW 對 JS／CSS 係快取優先，唔升 CACHE_NAME + ?v 用戶會繼續見到舊彈窗。
//
// 版本號升級：3.26.0 → 3.27.0
// 本次變更（子頁面選單清理：刪除「通行密鑰」與「雙重認證」）：
//   ⚠ 核心問題：「登入和安全」分組原本有四行，但其中兩行係做唔到事嘅虛項：
//     · 通行密鑰 —— 純前端離線 App 冇伺服器保存公鑰同驗證簽章，功能永遠不可能
//       生效，子頁面只係一段「本版本未支援」嘅說明；
//     · 雙重認證 —— 只做到「裝置層級」再次輸入密碼，唔係伺服器端 2FA，
//       純前端專案本身冇安全邊界，屬不需要嘅項目。
//     用戶要求「登入和安全」只保留：密碼、安全通知。
//   1. index.html（#profile-view-account）：
//      · 刪除「通行密鑰」同「雙重認證」兩行 <button class="ios-row">（連註解）；
//        被刪嘅「雙重認證」行帶住 <span id="ios-sub-acc-2fa">，一併消失。
//      · 更新相關結構註解（狀態 5／狀態 6、「登入和安全」只剩 4→2 行）。
//   2. profile.js：
//      · PROFILE_DETAIL_PAGES 刪除 passkey 同 twofa 兩項；
//      · 刪除 profileDetailTwoFactorHtml()、profileDetailPasskeyHtml()、
//        profileToggleTwoFactor() 三個函式（最後一個係唯一寫入 2FA 開關嘅地方）；
//      · renderProfileAccount() 刪除 ios-sub-acc-2fa 嘅填入邏輯；
//      · profileDetailSecurityHtml()：尾卡原本有一行導覽去「雙重認證」，
//        改為指向「密碼」，並改寫「請開啟雙重認證」嘅建議文案；
//      · profileSwitchAccount()：刪除 2FA 閘門同 skipGuard 參數 ——
//        ⚠ 唔可以只刪 UI 而留住閘門：開關入口冇咗，舊帳號上嘅 twoFactor 旗標
//          就會永遠鎖住切換流程，而且用戶冇任何方法關閉佢；
//      · 連帶刪除「密碼確認閘門」（profileOpenGuard / profileConfirmGuard /
//        profilePendingGuard 及 profileOpenSheet/profileCloseSheet 嘅重置行）——
//        呢組工具本來只服務上述兩個 2FA 呼叫點，冇咗呼叫點就係死碼。
//   3. auth.js：刪除 authHasTwoFactor() / authSetTwoFactor()，
//      authNormalizeAccount() 由「寫入 twoFactor」改為 delete acc.twoFactor，
//      主動清走舊帳號上嘅殘留旗標（下一次 authPersistAccounts() 寫檔即生效）。
//      ⚠ authVerifyPassword() 保留：改密碼、登入流程仍然要用。
//   4. profile.css：只有註解更新，冇任何樣式規則改動（行結構冇變）。
//   5. ?v 同步升：profile.js 3.26.0→3.27.0、auth.js 2.8.0→2.9.0、
//      profile.css 3.25.0→3.27.0；SW 註冊 service-worker.js?v=3.27.0。
//      SW 對 JS／CSS 係快取優先，唔升 CACHE_NAME + ?v 用戶會繼續見到舊選單。
//
// 版本號升級：3.25.0 → 3.26.0
// 本次變更（帳戶次頁面：將「電話號碼」欄位徹底替換為「電郵地址」）：
//   ⚠ 核心問題：帳戶次頁面「你的帳戶」分組有一行「變更電話號碼」，
//     但本 App 從未收集、儲存或上傳任何電話號碼 —— 嗰一行推入嘅子頁面
//     只係一段「我哋冇你電話」嘅說明，冇任何可操作內容；
//     而本系統嘅帳號識別碼其實係電郵，主頁 Header 亦已經直接顯示電郵。
//     即係：一個有實際作用嘅識別碼（電郵）反而要入兩層才改到，
//     而一個根本唔存在嘅欄位（電話）就霸住最顯眼嘅位置。
//   1. index.html（#profile-view-account）：
//      · 「你的帳戶」分組：刪除「變更電話號碼」行，改為「電郵地址」行 ——
//        右側 <span id="ios-sub-acc-email"> 即時顯示目前電郵，
//        點擊 profilePushDetail('email') 以標準 Push 動畫推入電郵子頁面。
//      · 「登入和安全」分組：刪除原來的「電郵地址」行，避免同一頁出現兩行
//        一模一樣、連目標頁面都相同嘅項目（電郵只可以有一行）。
//      · 更新狀態 5／狀態 6 嘅結構註解（子頁面由 7 個減至 6 個）。
//   2. profile.js：
//      · PROFILE_DETAIL_PAGES 刪除 phone 項；profileDetailPhoneHtml() 整段刪除。
//      · profileDetailEmailHtml()：欄位標籤「帳號電郵」→「電郵地址」，
//        並補上說明 —— 呢一頁同時係「帳號識別碼」頁同「修改／驗證狀態」頁。
//      · renderProfileAccount() 不變：照樣填 #ios-sub-acc-email，
//        所以改完電郵之後，列表頁右側會即時顯示新電郵（profileRerenderDetail()）。
//   3. profile.css 本次無改動（純結構／資料變更，無新增類名），維持 3.25.0。
//   4. ?v 同步升：profile.js 3.25.0→3.26.0；SW 註冊 service-worker.js?v=3.26.0。
//      SW 對 JS 係快取優先，唔升 CACHE_NAME + ?v 用戶永遠見到「變更電話號碼」。
//
// 版本號升級：3.24.0 → 3.25.0
// 本次變更（UI 極簡化：主選單項目嘅灰色副標題徹底刪除）：
//   ⚠ 核心問題：主選單每一行都掛住一句灰色小字（「初二正」／
//     「已登入 · lampkengkking@gmail.com」／「雲端已同步」／「個人資料可見性、活動狀態、
//     數據收集」…），5 張卡片 15 行全部兩行高，畫面極度雜亂，亦偏離 WhatsApp／
//     iOS 原生設定頁「一行一項」嘅極簡風格。
//   1. index.html：刪除主選單全部 15 個 <span class="ios-row__sub">（卡片 1~5，
//      即班級與課表設定／帳戶／雲端同步狀態／已連結裝置與 Session／外觀與主題／
//      私隱／儲存空間及數據／常見問題／回報問題／聯絡支援／免責聲明／服務條款／
//      私隱政策／條款與許可／邀請朋友），每行只保留 .ios-row__label 主標題。
//   2. profile.js：刪除 renderProfileMenu()（唯一用途就係填呢批副標題）
//      及其呼叫點，並刪除隨之變成死代碼嘅 profileThemeLabel()；
//      renderCloudPill() 同步移除 #ios-sub-cloud 寫入，只保留頁尾
//      「雲端帳號系統 / 本機帳號系統」一句。
//      ⚠ profileSetSub() 保留：帳戶次頁面（#profile-view-account）仍然在用。
//   3. profile.css：更新 5-2 分區說明 —— 主選單項目一律單行，
//      高度由 .ios-row 原有嘅 min-height 52px ＋ align-items: center 保證
//      （單行後自動由 ~56px 收斂成 iOS 原生嘅 52px，圖示／文字／chevron 垂直居中），
//      唔需要（亦唔應該）另外改 padding 硬湊高度；
//      .ios-row__sub 加註說明只剩帳戶次頁面會用。
//   4. ?v 同步升：profile.js 3.24.0→3.25.0、profile.css 3.24.0→3.25.0；
//      SW 註冊 service-worker.js?v=3.25.0。
//      SW 對 CSS／JS 係快取優先，唔升 CACHE_NAME + ?v 用戶永遠見到舊畫面。
//
// 版本號升級：3.23.0 → 3.24.0
// 本次變更（個人中心 Header：Handle 顯示邏輯修復 ＋ 徹底移除 QR Code 按鈕）：
//   A. Handle 顯示邏輯（profileHandleText）
//   ⚠ 核心問題：舊版一律「取電郵 @ 前嘅本機部分再加 @」，
//     所以 lampkengkking@gmail.com 會被硬生生顯示成 @lampkengkking —— 呢個唔係
//     用戶設定過嘅 Handle，只係被截斷嘅電郵，對用戶嚟講係錯誤資料。
//   1. profile.js：profileHandleText() 改為三段式：
//      · 優先用戶自訂 Handle（account.handle / account.username）→ 顯示 @handle；
//      · 冇自訂 Handle 但有電郵 → 直接顯示「完整電郵」（唔加 @、唔截斷）；
//      · 兩者都冇 → 退回簡短狀態 PROFILE_HANDLE_FALLBACK
//        （'Hey there! I am using PCMS Timetable.'）。
//   B. Header 頂部 QR Code 按鈕徹底移除
//   ⚠ 核心問題：QR Code 功能已全面取消（qrcode.js 早前已刪），但右上角仍然留低
//     一粒「QR 圖示」掣，撳落去只係開「邀請朋友」面板 —— 圖示同實際行為不符，
//     對用戶係誤導，亦係一件死裝飾。
//   2. index.html：刪除 .wa-iconbtn-group 膠囊框及其中的 QR 按鈕（qrCode 圖示），
//      右上角改為單顆 .wa-iconbtn「編輯」圓掣（onclick=profileOpenAccount()）。
//      .wa-tools 靠本來嘅 space-between，左右各一顆 42px 圓掣自然對稱，
//      頂部導覽列左右留白與 WhatsApp 設定頁一致，唔需要額外補位。
//   3. profile.css：刪除整個 .wa-iconbtn-group 規則（含內層 40px 覆寫）
//      及「右＝QR＋編輯膠囊」註解，更新 5-1 分區說明。
//   4. icons.js：刪除已無引用嘅 qrCode 圖示，避免死代碼。
//      ⚠ profileOpenInvite() 保留：個人中心「邀請朋友」卡片（gift 圖示）仍在使用。
//   5. ?v 同步升：profile.js 3.23.0→3.24.0、profile.css 3.23.0→3.24.0、
//      icons.js 2.10.0→2.11.0；SW 註冊 service-worker.js?v=3.24.0。
//      SW 對 CSS／JS 係快取優先，唔升 CACHE_NAME + ?v 用戶永遠見唔到新畫面。
//
// 版本號升級：3.22.0 → 3.23.0
// 本次變更（「登入和安全」彈窗徹底重構為 WhatsApp 原生「帳戶」次頁面）：
//   ⚠ 核心問題：舊版將密碼、電郵、雙重認證三大組欄位一次過塞入同一個模態抽屜，
//     閂咗之後亦冇上下文可返；而且主頁同時有「新增帳戶／登入和安全／你的帳號」
//     三行，同抽屜內容完全重複。
//   1. index.html：
//      · 主頁三行收斂成單一「帳戶」行（onclick=profileOpenAccount()）。
//      · 新增狀態 5 #profile-view-account（帳戶列表頁，DOM 固定）：
//        單獨卡片「新增帳戶」→「登入和安全」分組（通行密鑰／密碼／電郵地址／
//        雙重認證／安全通知）→「你的帳戶」分組（用戶名稱／變更電話號碼／登出）。
//        登出加 .is-danger（紅字、依 iOS 慣例無箭頭）。
//      · 新增狀態 6 #profile-view-detail：一個共用容器服務全部子頁面，
//        內容由 JS 注入，DOM 只佔一份。
//      · 頂部導覽列新增 #profile-more（圓形「⋯」），與 #profile-close 互斥。
//      · Header 鉛筆掣由 profileOpenYourAccount() 改為 profileOpenAccount()。
//   2. profile.js：
//      · 🗑 刪除 profileOpenLoginSecurity() 同 profileOpenYourAccount() 兩個舊彈窗，
//        以及舊版無 title 參數嘅 profileShowView()（函式提升會覆蓋新版，必刪）。
//      · 新增次頁面導覽堆疊：profileViewStack / profileDetailKey / profileCurrentMore，
//        配合 profilePushView / profilePushDetail / profilePageSnapshot /
//        profileRerenderDetail；profileBackView() 改為逐層彈棧再回頂層。
//        堆疊存「整頁快照」，所以 detail 再推 detail（通行密鑰 → 雙重認證）
//        返回時仍會還原上一個子頁面連標題。
//      · 新增 PROFILE_DETAIL_PAGES 註冊表（7 個 key）＋ profileRenderDetail()：
//        新增／刪除子頁面只需改註冊表，唔需要再動 HTML。
//      · 新增共用產生器 profileNavRowHtml / profileInfoRowHtml / profileListCardHtml，
//        以及 7 個 profileDetail*Html 內容產生器（全部經 profileEscape()）。
//      · 「⋯」只喺有動作時才顯示（profileCurrentMore 為 null 一律隱藏），
//        唔會留低一個撳完冇反應嘅掣。
//      · 表單欄位 ID 由 sheet-* 改為 detail-*；雙重認證確認成功後會
//        主動收起密碼閘門抽屜（原本會殘留一個要再撳 × 先走得嘅彈窗）。
//      · ⚠ 通行密鑰同變更電話號碼如實交代「本版本未支援／本 App 不收集電話號碼」，
//        並指向真正生效嘅替代方案（密碼 + 裝置層級雙重認證），
//        而唔係開一個撳完冇反應嘅假表單。
//   3. profile.css：新增 .ios-group-title（卡片外嘅分組小標題，負 margin 抵消
//      .ios-home 嘅 16px gap）、.detail-form、.detail-note，
//      以及 .ios-list 內 .sheet-row／.sheet-stat 嘅水平內距對齊規則。
//   4. ?v 同步升：profile.css 3.21.0→3.23.0、profile.js 3.20.0→3.23.0、
//      icons.js 2.9.0→2.10.0；SW 註冊 service-worker.js?v=3.22.0→3.23.0。
//
// 上一版 3.21.0 → 3.22.0
// 本次變更（個人中心 Header 重構為 WhatsApp 設定頁 1:1 垂直居中佈局）：
//   1. index.html：移除「左頭像 + 右文字」橫向卡片（.ios-card--bare + .profile-hero
//      + .glow-avatar 彩虹流光光圈），改為 <header class="wa-head"> 四層垂直居中：
//      頂部工具列（左＝搜尋／右＝QR＋編輯膠囊）→ 狀態氣泡 → 96px 大圓頭像
//      → 顯示名稱＋向下箭頭 → @handle。整區背景透明、無卡片框、無邊框。
//   2. icons.js：新增 chevronDown（名稱右側下拉箭頭）同 qrCode（右上膠囊）圖示，
//      維持全站「零 Emoji、統一 SVG」嘅做法（參考圖嘅 🚴 一律以 SVG 圖示代替）。
//   3. profile.css：刪除整個 .glow-avatar*（含 @keyframes glowSpin）、.profile-hero*、
//      .profile-hero__tags、.ios-card--bare —— 全部隨舊結構變成死代碼；
//      新增 .wa-* 樣式（工具列／膠囊／搜尋列／狀態氣泡同尾巴／大圓頭像／名稱／handle）。
//      ⚠ .tag-pill 保留：帳號清單「使用中」同雲端同步狀態仍然在用。
//   4. profile.js：
//      · renderProfileHome() 改為填 @handle 同狀態氣泡；原本嘅 #profile-hero-meta
//        （供應商 · 電郵 · 加入日期）同 #profile-provider-pill 隨設計移除 ——
//        同一批資料喺「你的帳號」子頁面同帳號清單仍然睇得到，冇資料遺失。
//      · 新增 profileHandleText()：由帳號推導 @handle（電郵本機部分優先 → 名稱 → id）。
//      · 新增 profileStatusNow() / renderProfileStatus()：狀態氣泡內容依「現在時間 +
//        今日課表 + 假期」即時計算（假期中／上課中／下一節 N 分鐘後／今日已落堂／今日無課）。
//        ⚠ 唔寫死假狀態：App 未有「自訂狀態」後台，硬寫一句（例如參考圖嘅 Cycling）
//          就係用 UI 講一個唔存在嘅功能；亦因為咁氣泡係唯讀 <div>，唔係撳得嘅掣。
//      · 新增 profileUpcomingHoliday()：把「下個假期」Banner 原本內嵌嘅日期計算抽出，
//        同狀態氣泡共用同一套邏輯，兩處唔會再各計一套而講出唔同嘅嘢。
//      · 新增設定搜尋（放大鏡）：profileToggleSettingsSearch / profileFilterSettings /
//        profileClearSettingsSearch / profileResetSettingsSearch，純前端過濾現有選單
//        （零命中會顯示提示），離開主頁或關閉面板時自動還原。
//   5. ?v 同步升：profile.css 3.20.0→3.21.0、profile.js 3.19.0→3.20.0、
//      icons.js 2.8.0→2.9.0；SW 註冊 service-worker.js?v=3.21.0→3.22.0。
//   6. ⚠ QR 掣行為：App 未有內建 QR 編碼器（見舊版本記錄：刻意移除），故此掣
//      開啟「邀請朋友」分享面板，而唔係一個撳完冇反應嘅裝飾掣。
//
// 上一版 3.20.0 → 3.21.0
// 本次變更（邀請連結改用正式網域 pcmstimetable.com，修復分享出本機網址）：
//   1. 🆕 scripts/config/app-config.js：新增 window.APP_CONFIG.siteUrl
//      = 'https://pcmstimetable.com'，作為對外分享網址嘅唯一真實來源。
//   2. profile.js 嘅 profileInviteLink() 重寫：舊寫法直接取 location.href，
//      在本機開發（127.0.0.1:5500 / localhost）會產生對方開唔到嘅邀請連結。
//      而家一律以 APP_CONFIG.siteUrl 為根 → https://pcmstimetable.com/?invite=1；
//      結尾斜線自動正規化（siteUrl 寫有無「/」都得到同一結果）；inviteParam 可設定；
//      容錯：siteUrl 漏寫 protocol 會自動補 https://；
//      ⚠ 解析順序：APP_CONFIG.siteUrl → 全局 APP_SHARE_URL → location.href（最後防線，
//      確保最壞情況仍然複製到嘢，唔會變成死掣）。
//   3. 「邀請朋友」抽屜文案同步改為「連結一律指向官方網址，即使喺本機開啟都一樣」。
//      文字框（#sheet-invite-url）、「複製連結」與 navigator.share 三者同源，
//      都經 profileInviteLink() 取值，所以顯示同實際分享嘅網址必然一致。
//   4. index.html：新增 app-config.js?v=1.0.0（排在 auth-config.js 之後）、
//      profile.js ?v 3.18.0→3.19.0。
//   5. precache 加入 ./scripts/config/app-config.js：否則離線時拎唔到網域設定。
//   6. ?v 同步升：SW 註冊 3.20.0→3.21.0。
//   7. auth-config.js 標題註解更正（「唯一需要改的檔案」→ 指向同層 app-config.js），
//      純註解變更，?v 一併 2.7.0→2.7.1。
//
// 上一版 3.19.0 → 3.20.0
// 本次變更（刪除選單內所有「開發中」佔位項目，只保留真正可點擊的功能）：
//   1. 🗑 index.html 刪除兩個未完成項目（原本以 <div class="ios-row is-disabled">
//      ＋ .ios-row__badge「開發中」灰標籤呈現）：
//        · 我的功課 / 備忘事項（尚未提供資料來源，後端無對應資料集合）
//        · 通知與提醒設定（尚未提供設定模組）
//      兩者本身冇 onclick、撳落去零反應，屬誤導性 UI，故直接由 DOM 移除。
//   2. profile.css 刪除隨之失效的死代碼：.ios-row.is-disabled、.ios-row__badge
//      與其淺色主題覆寫（全專案已無任何使用者）。
//   3. profile.css 色票同步收窄：--ios-indigo / orange / pink / purple / teal / gray
//      六色已無任何引用，一併刪除；只留 --ios-blue（抽屜選中、輸入聚焦、主按鈕）、
//      --ios-green（開關開啟）、--ios-red（危險操作）三色。
//   4. 驗證：設定頁 18 列全部為 <button>；30 個 inline onclick 全部對應到已定義函式
//      （unresolved = 0）；<div class="ios-row"> 佔位列 = 0。
//   5. ?v 同步升：profile.css 3.19.0→3.20.0、SW 註冊 3.19.0→3.20.0。
//
// 上一版 3.18.0 → 3.19.0
// 本次變更（個人中心圖示改為 WhatsApp 原生「無底框」單色線條風格）：
//   1. 🗑 徹底移除彩色圓形／圓角底框：profile.css 嘅 .ios-row__icon 刪除
//      background-color、box-shadow 內高光同 border-radius，並刪除 9 個配色修飾類
//      （--blue / --green / --indigo / --orange / --pink / --purple / --red / --teal / --gray）。
//      底框改為完全透明（background: none），容器由 30×30 縮至 24×24，圖示本體 22px。
//   2. 單色線條：深色主題 #FFFFFF、淺色主題 #1C1C1E（由 :root[data-theme="light"] 覆寫）。
//      顏色一律跟隨 icons.js 嘅 stroke: currentColor，唔再逐項配色。
//   3. icons.js 新增 6 個設定頁圖示：key（你的帳號）、shield（登入和安全／條款與許可）、
//      lock（私隱／私隱政策）、arrowsUpDown（儲存空間及數據）、help（常見問題）、chat（聯絡支援）。
//   4. index.html 19 列同步更新：移除全部 --* 配色類、data-icon-size 17→22、對應圖示換新。
//   5. ?v 同步升：profile.css 3.18.0→3.19.0、icons.js 2.7.0→2.8.0、SW 註冊 3.18.0→3.19.0。
//
// 上一版 3.17.0 → 3.18.0
// 該版變更（個人中心改為嚴格 5 張分組卡片 ＋ 移除卡片小標題 ＋ 主題抽屜 ＋ 登出確認）：
//   1. 🗑 移除卡片全部分類小標題（.ios-card__title × 6）：卡片內部只保留選單項目，
//      區塊之間純靠卡片圓角同 .ios-home 嘅 16px 外距區隔（WhatsApp / iOS 18 風格）。
//      因冇咗標題撐住頂部，.ios-list 補上 padding: 6px 0，
//      否則第一／最後一列會貼死卡片圓角邊緣。
//   2. 6 張卡合併為嚴格 5 張：原「核心功能」卡（班級與課表設定 / 雲端同步狀態 /
//      已連結裝置與 Session / 我的功課）併入「帳戶」卡，其餘 4 張依序重編號。
//      ⚠ 班級與課表設定係帳號層資料（account.classId），併入帳戶卡語意一致。
//   3. 「外觀與主題」由「一撳即切換」改為開啟主題抽屜（淺色 / 深色 / 跟隨系統）：
//      新增 profileOpenAppearance() / profileSetTheme() / profileChoiceRowHtml()，
//      以及 .sheet-choice 單選列樣式（圓形剔號，非開關掣）。
//      ⚠ 刻意唔提供「iOS 18 Liquid Glass」選項 —— 該材質係固定套用喺底部導覽嘅
//        視覺層（window.LiquidGlass），並唔係一套可切換嘅 data-theme；
//        列出嚟只會係一個撳完冇反應嘅假選項。
//   4. theme.js 支援 'auto'：新增 themePreference() / themeResolve() /
//      setThemePreference()，並修正系統主題變更監聽 —— 只有偏好係 'auto'
//      先會被系統帶動，用戶明確揀咗深／淺色就唔可以被蓋過。
//      ⚠ applyTheme() 永遠唔會寫出 data-theme="auto"，否則
//        :root[data-theme="light"] 嗰批淺色覆寫規則會全部失效。
//   5. 「登出」加入二次確認：profileLogout() 改為彈確認抽屜，
//      真正登出邏輯移去 profileConfirmLogout()。因為該掣放喺卡片最底又係紅色，
//      好容易誤觸，而登出會清 Session 並跳返登入頁，復原成本高。
//   6. ?v 同步升：profile.css / profile.js 3.17.0→3.18.0、
//      theme.js 2.5.0→2.6.0、SW 註冊 3.17.0→3.18.0。
//
// 上一版 3.16.0 → 3.17.0（取消 QR Code，「邀請朋友」改用原生分享 ＋ 一鍵複製）：
//   1. 🗑 徹底移除 QR Code 產生器：刪除 scripts/utils/qrcode.js、index.html 嘅
//      <script> 引用、SW 預快取條目，以及 profile.css 全部 .sheet-qr* 樣式。
//      原因：分享場景用系統分享面板或直接貼連結已經足夠，唔值得長期揹住
//      一部近千行嘅編碼器（版本選擇、Reed-Solomon 糾錯、遮罩罰分擇優）。
//   2. 邀請朋友抽屜改為：連結以卡片顯示（word-break: break-all 防撐爆抽屜，
//      user-select: all 方便手動全選）＋「複製連結」＋「系統分享」兩顆掣。
//   3. 新增 profileSyncInviteShare()：瀏覽器無 navigator.share 時移除「系統分享」，
//      並把「複製連結」由 ghost 升為主按鈕 —— 唔留低撳完同標籤不符嘅死掣。
//   4. profileShareInvite() 保留回退：分享面板拋出非 AbortError 時改為複製連結。
//      AbortError ＝ 用戶主動取消，唔彈提示、亦唔當成失敗去複製。
//   5. ?v 同步升：profile.css / profile.js 3.16.0→3.17.0、SW 註冊 3.16.0→3.17.0。
//
// 上一版 3.15.0 → 3.16.0（個人中心全面重構 ＋ 徹底移除開發者模式）：
//   1. 🗑 開發者模式完全刪除，唔係隱藏。刪除 devtools.js / devtools.css、
//      index.html 整個開發面板 DOM（.dev-overlay / .dev-fab / .dev-toast /
//      .dev-pwd-overlay）、連點版本號入口、Ctrl+Shift+D 快捷鍵，
//      以及 db.js 唯讀閘門内的 devIsUnlocked() 後門。
//      main.js 新增 purgeLegacyDevFlags() 主動清走舊裝置遗留嘅
//      dev_mode_enabled / dev_auth_guard_v1，避免舊旗標繼續生效。
//      calendar.js 亦移除 calendarIsDevUnlocked()：官方假期改為「任何情況下」唯讀。
//   2. index.html 個人中心重寫為六張 iOS 分組卡片：核心功能 / 帳戶 /
//      系統偏好與私隱 / 意見和幫助 / 法律與合規 / 社群與分享。
//   3. ⚠ 版本號由卡片内部移去頁尾（<footer class="profile-footer"> 的
//      #app-version），低調灰字、置中，不再係任何功能的入口。
//   4. 新增單一子頁面抽屜容器（#ios-sheet-overlay / #ios-sheet / #ios-sheet-body），
//      個人中心十個子頁面全部共用：登入和安全、你的帳號、私隱、
//      儲存空間及數據、常見問題、回報問題、聯絡支援、四篇法律條文、邀請朋友。
//      profileOpenSheet() / profileCloseSheet() 統一處理焦點、ESC 與背景關閉。
//   5. 新增 scripts/modules/profile/profile-content.js（純資料檔）：
//      FAQ 8 條、反饋類型 7 類、私隱預設值，以及免責聲明 / 服務條款 /
//      私隱政策 / 條款與許可四篇長條文。
//   6. 新增 scripts/utils/qrcode.js：零依賴 QR Code 產生器（byte mode、EC M、
//      版本 1–10、八種遮罩罰分擇優）。「邀請朋友」嘅 QR 由本機即時繪製，
//      ⚠ 刻意唔用第三方 QR 圖片 API：一來離線會失效，二來等同將邀請連結外洩。
//   7. auth.js 新增帳號維護 API：authChangePassword / authUpdateEmail /
//      authUpdateName / authSetTwoFactor / authHasTwoFactor；
//      authNormalizeAccount() 加入 twoFactor 欄位。
//      ⚠ 私隱政策條文所寫嘅「隨機鹽值 ＋ SHA-256」係對應 authHashPassword()
//        嘅實際行為，兩者必須保持一致，改密碼邏輯時要一齊更新。
//   8. 雙重認證屬「裝置層級」：開啟後喺呢部裝置切換到該帳號必須重新輸入密碼
//      （見 profileSwitchAccount 的 skipGuard 參數 —— 冇呢個參數驗證成功後
//      會再次彈同一個閘門，形成無限迴圈）。
//   9. 「清除快取」只清 Cache Storage 與資料檔鏡像 appdb_mirror_v1_*，
//      刻意保留 appdb_v1_*（用戶自己改過嘅內容）、帳號與所有偏好設定。
//  10. ?v 同步升：profile.css / profile.js 3.0.0→3.16.0、
//      auth.js 2.7.0→2.8.0、qrcode.js 1.0.0（新增）、
//      profile-content.js 1.0.0（新增）、SW 註冊 3.15.0→3.16.0。
//
// ⚠ 已知限制：authSetTwoFactor() 嘅 2FA 只係本機裝置層級嘅再驗證，
//    唔係伺服器端 2FA。純前端專案冇安全邊界可言，呢個設計只防「他人接手
//    已解鎖裝置」，唔防有心人直接讀寫 localStorage。
//
// 上一版 3.14.0 → 3.15.0（個人中心 UI 重構：Bento Grid → iOS 18 分組卡片）
// 該版變更（漏洞修復：非開發者模式下仍可刪除官方假期）：
//   ⚠ 成因：calendar.js 事件清單（selectCalendarDate）無條件渲染刪除鈕，
//     任何人點一下就可以刪走 data/events.json 嘅官方假期。
//   1. 新增 calendarIsOfficialHoliday(e)：type === 'holiday' || isHoliday === true
//      即視為官方假期。注意 db.js 正規化時 type 缺省值本身就係 'holiday'，
//      所以連冇 type 嘅資料都會一併受保護。
//   2. 新增 calendarIsDevUnlocked()：用 devIsUnlocked()（devEnabled &&
//      本次 session 已通過密碼）。刻意唔用 devIsEnabled()，因為後者讀
//      localStorage 嘅 dev_mode_enabled，用戶改一下就當真。
//   3. 新增 calendarCanDeleteEvent(e)：官方假期只有已解鎖開發者模式先可刪，
//      其他類別（測驗／作業／活動）維持原本可自由刪除。
//   4. calendarDeleteButtonHtml(e)：唔准刪就回傳空字串 —— 係「完全唔渲染」，
//      唔係 CSS 隱藏；藏起嘅按鈕仍然留喺 DOM，開 DevTools 一樣撳得到。
//   5. deleteCalendarEvent() 加權限斷言（第二道防線）：呢個函式係 global，
//      即使繞過 UI 直接喺 console 叫用，一樣攔截並提示「官方假期無法刪除」。
//   6. 新增 calendarToast()：重用 app 層 #profile-toast（fixed 定位、喺所有
//      overlay 之外），唔需要為日曆另開一個提示條。
//   7. devtools.js 新增 devSyncCalendarPermissions()，喺 devEnable() /
//      devDisable() 後通知月曆重繪，令刪除鈕隨權限即時出現／消失；
//      以 typeof 守衛跨模組呼叫，calendar 模組唔存在時亦唔會拋錯。
//   8. ?v 同步升：calendar.js 2.6.0→2.7.0、devtools.js 2.8.0→2.9.0、
//      SW 註冊 service-worker.js?v=3.13.0→3.14.0。
//      calendar.css 未改動，維持 ?v=2.6.0。
//
// 上一版 3.12.0 → 3.13.0
// 該版變更（開發者模式密碼防暴力破解：連續 3 次失敗 → 凍結 5 分鐘）：
//   1. devtools.js：新增常數 DEV_MAX_ATTEMPTS = 3、DEV_LOCK_MS = 300000、
//      DEV_GUARD_KEY = 'dev_auth_guard_v1'。
//   2. 防護狀態存 localStorage 而唔係只存記憶體：否則用戶一按 F5 重整理頁面
//      就會被清零，封鎖形同虛設。重整理、甚至關分頁再開都一樣要繼續倒數。
//   3. devSubmitPassword()：輸錯即累加計數。未達 3 次 → 顯示「剩餘 N 次機會」；
//      第 3 次 → 即時關閉彈窗並凍結 300 秒，Toast 依規格顯示
//      「密碼嘗試次數過多，開發者模式已暫時鎖定，請於 X 分 X 秒後重試。」
//   4. devRequirePassword()：凍結期內連彈窗都唔開，直接倒數提示。
//      呢個函式係所有入口嘅唯一咽喉點（連點版本號 5 下 / 長按 0.8 秒 /
//      Ctrl+Shift+D / 點 FAB），所以喺呢度攔截就已經全面覆蓋全部入口。
//   5. 觸發凍結時同時將 fails 歸零：否則期滿後用戶再錯一次就會即時再被鎖死，
//      永遠達唔到規格要求嘅「凍結時間結束後恢復為可驗證狀態」。
//   6. 密碼正確 → devResetGuard() 清空計數與凍結狀態（提交時、session 解鎖時各一次）。
//   7. ?v 同步升：devtools.js 2.7.0→2.8.0；SW 註冊 3.12.0→3.13.0。
//
// 上一版 3.11.0 → 3.12.0
// 該版變更（開發者模式提示統一 + 假期資料唯讀鎖定）：
//   1. devtools.js：錯誤提示統一為「密碼錯誤，無法存取開發者模式」；
//      新增 devIsUnlocked()（＝ devEnabled && devUnlocked）對外匯出供 DB 層查詢。
//   2. db.js：新增 DB_READONLY_COLLECTIONS = ['holidays'] 唯讀閘門，
//      分別在 set / setMemory / clearOverride 三個寫入入口攔截。
//      ⚠ 閘門刻意設於資料層而非 UI 層：holidays.js 本來就只有渲染、完全無
//        編輯按鈕，單靠 UI 根本擋唔住「日後有人加返按鈕」或者喺 Console
//        直接呼叫 DB.set('holidays', [...]) 嘅情況。
//   3. 一般使用者寫入 holidays 時：Console 警告 + Toast 提示、回傳 false、
//      資料完全不變；開發者面板解鎖後（devIsUnlocked 為 true）一切照舊。
//   4. 順帶修復 db.js 既有 bug：clearOverride 有兩份重複定義，
//      後者覆蓋前者且缺少 this._source[name] 清理，令來源追蹤一直失效。已移除死碼。
//   5. ?v 同步升：db.js 3.1.0→3.2.0、devtools.js 2.6.0→2.7.0。
//
// ⚠ 已知限制：上述兩項保護都係純前端實作（密碼常數可讀、localStorage 可手改），
//    定位係「防誤觸／防手多多」，唔係安全邊界。要真正保護官方資料必須由後端把關
//    （現由 Supabase RLS 政策負責：只有 auth.uid() 相符的列才可讀寫）。
//
// 上一版 3.10.0 → 3.11.0
// 該版變更（開發者模式加入密碼驗證）：
//   1. devtools.js：所有開啟入口（連點版本號 5 下 / 長按 / Ctrl+Shift+D / 點 FAB）
//      統一收歸 devRequirePassword() 閘門，驗證通過前一律唔會進入開發者模式。
//      ⚠ devEnable() 雖然係唯一匯流點，但 devOpen() 亦要獨立把關：
//        已記住 dev_mode_enabled 的裝置可以直接由 FAB 開啟面板。
//   2. 密碼錯誤時保留原本的非開發者狀態，顯示「密碼錯誤，無法開啟開發者模式」，
//      並以輸入框轉紅 + 卡片抖動 + devToast 三重提示，然後清空輸入讓用戶重試。
//   3. 解鎖狀態只存在記憶體（devUnlocked）：重新載入頁面即重新上鎖，
//      關閉開發者模式亦會即時上鎖。
//   4. index.html：新增 #dev-pwd-overlay 彈窗；devtools.css 加入 .dev-pwd-* 樣式，
//      z-index 9500 高於 .dev-overlay 的 9000，並跟隨深/淺色主題。
//   5. ?v 同步升：devtools.js 2.5.0→2.6.0、devtools.css 2.6.0→2.7.0。
//
// ⚠ 已知限制：DEV_PASSWORD 係純前端常數，任何人開 DevTools 睇原始碼即可取得，
//    亦可直接改 localStorage 嘅 dev_mode_enabled。此機制只防誤觸，並非安全邊界。
//
// 上一版 3.9.1 → 3.10.0
// 該版變更（登入流程逾時防護：唔再卡在「登入中…」）：
//   1. cloud.js：新增 CLOUD_INTERACTIVE_BUDGET_MS（8 秒）整體時間預算。
//      ⚠ 原本 timeoutMs 係「逐個請求」計算，但登入要連續發 salt → login 兩個請求，
//        每個又 retry:1（即 2 次嘗試），最壞疊加成 ~33 秒：按鈕一直 disabled、
//        畫面顯示「登入中…」，用戶會以為當機。現在兩個請求共用同一份 8 秒預算。
//   2. cloud.js：AbortError 由籠統的 NETWORK 改為獨立 TIMEOUT 錯誤碼，
//      並新增 cloudIsOfflineCode() 統一判斷「離線類」錯誤。
//   3. auth.js：NO_ACCOUNT（雲端確認無此帳號）唔再穿過本地快取檢查，
//      直接回報「帳號不存在，請先切換至註冊」。原本會落到一句誤導的
//      「沒有這個帳號的快取…而且無法連線到雲端」，令用戶以為係網絡問題。
//   4. profile.js：加入對應 Toast 提示；finally 的按鈕文字改用提交當下捕獲的
//      isSignup，唔再讀即時 profileAuthMode（登入成功後流程可能已切換表單模式）。
//   5. ?v 同步升：cloud.js 1.0.0→1.1.0、auth.js 2.6.0→2.7.0、profile.js 2.6.0→2.7.0。
//
// 上一版 3.9.0 → 3.9.1
// 該版變更（填入 GAS Web App endpoint，正式開通雲端帳號庫）：
//   1. auth-config.js：cloud.endpoint 由空字串填入實際部署的 /exec 網址，
//      timeoutMs 12000 → 8000（cold start 下限）。endpoint 為空時整個雲端層會 no-op，
//      必須填入才會真正把帳號寫入 Google Sheets。
//   2. ⚠ auth-config.js 係「快取優先」靜態資源，而 caches.match() 以「完整 URL（含 ?v=）」為 key。
//      所以只改檔案內容而唔升 index.html 嘅 ?v=，已安裝嘅裝置會永遠讀到舊嘅空 endpoint，
//      而且唔會有任何錯誤提示（靜靜地繼續跑純本機模式，帳號只存在該裝置）。
//      → index.html：auth-config.js 的 ?v 由 2.6.0 升至 2.7.0。
//   3. ?v 同步升：SW 註冊 service-worker.js?v=3.9.1。
//
// 上一版 3.8.0 → 3.9.0
// 該版變更（帳號資料雲端永續保存：本機 localStorage → Google Sheets）：
//   1. 新增 scripts/modules/auth/cloud.js：雲端同步層（Google Apps Script Web App API）。
//      · 讀取＝本機快取優先（零網絡、零 await → 秒開），背景才向雲端校驗較新版本
//      · 寫入＝本機即時完成，雲端非阻塞推送；失敗入離線佇列，上線／下次啟動自動補送
//      · 佇列只記帳號 id，唔複製頭像 Base64，避免撐爆 localStorage
//      · ⚠ POST 用 Content-Type: text/plain —— 用 application/json 會觸發 preflight，
//        而 Apps Script 唔支援 OPTIONS，請求會直接失敗
//   2. auth.js：註冊改為「雲端同步等待」（即時擋 Email 重複），
//      登入改為「雲端為真實來源、本機為離線後備」；新增 authTouch / authUpsertAccount。
//      刪除帳號只清本機清單，雲端紀錄永續保留。
//   3. main.js：新增 syncAccountCloudSilently()，在課表背景更新之後以非阻塞方式執行。
//   4. profile：個人中心新增雲端狀態標籤（點擊可手動同步）。
//   5. 新增 google-apps-script/Code.gs（部署到 Google Apps Script 的後端，不會被 SW 快取）。
//   6. ?v 同步升：auth-config.js 2.6.0、auth.js 2.6.0、profile.js 2.6.0、
//      profile.css 2.7.0、main.js 3.7.0；SW 註冊 service-worker.js?v=3.9.0。
//
// 上一版 3.7.0 → 3.8.0
// 本次變更（修正「載入失敗被誤判為成功」→ Splash 嘅「重新連線中…」提示終於觸發得到）：
//   1. db.js 嘅 normalize() 會固定補齊「1~6」6 條星期 key，令「載入失敗 → 內建備援 {}」
//      同「載入成功但未有課」正規化後一模一樣。舊寫法用 Object.keys().length 判斷，
//      結果 scheduleLoadFailed 永遠係 false：斷網時會靜靜地顯示一張空課表，
//      而且 Splash 嘅 .splash-waiting／「重新連線中…」分支永遠唔會執行（真係斷網都當成功）。
//   2. main.js 新增 hasScheduleContent()：至少要有一日有課堂才算載入成功，
//      並套用到 applyLocalCache / applyClassSchedule（含預設課表後備）/ DB 訂閱 /
//      firstScreenReady / revalidateScheduleSilently。
//   3. 修正後真正斷網 → scheduleLoadFailed = true → Splash 保持循環動畫 ＋
//      底部「重新連線中…」，入 App 後由 #status-container 嘅錯誤卡接手（附重試指引）。
//   4. ?v 同步升：main.js 3.6.0；SW 註冊 service-worker.js?v=3.8.0。
//
// 上一版 3.6.0 → 3.7.0
// 該版變更（Loading 品牌動畫與體驗優化：< 100ms 觸發 ＋ 播放 2.5s ＋ 無數據持續動畫）：
//   1. 品牌動畫最少播 2.5s（規範 2.0~3.0s），淡出 200ms（舊值 0.1s）。
//      動畫拆成 4 步：logoSpin 0.8s 進場 → logoIdle 無限「呼吸」待機 → 轉場（白圓擴散＋Logo 放大
//      0.45s）→ 淡出 0.2s。轉場改由 main.js 加 .splash-leaving 觸發，唔再開機 0.8s 自動播
//      （舊版資料未到就會「白屏定住」，正係今次要杜絕嘅情況）。
//   2. 移除「暖啟動唔播 Splash」（html.boot-warm）：新規範要求每次啟動都播品牌動畫，
//      改為開機腳本只記錄 __BOOT_T0 時間戳，令動畫由第一幀準確計時。
//   3. 無數據／無網絡／載入失敗：Logo 保持循環動畫 ＋ 底部淡入微弱提示
//      （「正在獲取最新課表…」／「重新連線中…」，即 #splash-status），嚴禁黑屏。
//   4. .splash-logo 自帶 #131313 / 28% 圓角品牌色塊底：SVG 未下載完都有品牌感，唔會空白框。
//   5. ?v 同步升：main.js 3.5.0；SW 註冊 service-worker.js?v=3.7.0。
// 上一版 3.5.0 → 3.6.0（月曆唯讀化）：
//   1. 移除使用者自行新增事件嘅全部入口：index.html 嘅新增事件彈窗、
//      calendar.js 嘅 openAddCalendarEventModal()／saveCalendarEvent() 等 6 個函式，
//      以及 calendar.css 整個 .gcal-* 彈窗樣式（約 290 行）。
//   2. 事件改為完全由資料檔／開發者後台管理；點擊日期格子只檢視唔再彈新增視窗。
//   3. ?v 同步升：calendar.css 2.6.0、calendar.js 2.6.0。
// 上一版 3.4.0 → 3.5.0（首屏效能：秒開 ≤ 100ms ＋ 徹底防黑屏）：
//   1. 本機快取不再靠 SW：db.js 新增 localStorage「鏡像」（appdb_mirror_v1_*），
//      課表／假期／班級資料同步讀取（零網絡、零 await）→ 首屏即時有內容。
//      下方 .json 保持「網絡優先」不變，改為由 App 喺背景靜默更新（stale-while-revalidate），
//      所以 SW 呢邊唔需要（亦唔應該）改成快取優先；資料新舊同載入速度從此脫鈎。
//   2. index.html 新增「開機腳本」：首次繪製前就設好 data-theme 同 --boot-bg，
//      html / body / Splash 底色一律跟隨主題 → 唔會再出現黑屏、白屏或主題閃爍；
//      暖啟動（本機已有課表副本）時連品牌 Splash 都唔播。
//   3. Splash 淡出 320ms → 100ms，首屏資料預算 FIRST_PAINT_BUDGET_MS = 100ms。
//   4. ?v 同步升：main.css 2.7.0、db.js 3.1.0、main.js 3.4.0。
// 上一版 3.3.0 → 3.4.0（iPhone 16 Pro Max 適配 ＋ 底部安全區域）：
//   ⚠ 三條 CSS 內容有改，但 SW 對 CSS／JS 係「快取優先」（見下面 isStaticAsset），
//     所以除咗升 CACHE_NAME，index.html 嘅 ?v 亦一定要同步升，否則永遠派舊樣式。
//   1. index.html：styles/main.css、profile/profile.css、devtools/devtools.css 嘅 ?v → 2.6.0；
//      SW 註冊 service-worker.js?v=3.4.0。
//   2. 預設機型改為 iPhone 16 Pro Max（440 × 956 CSS px，DPR 3），
//      .phone-mockup 與 .profile-panel 同步放大，並加 max-height:100dvh 收口防溢出。
//   3. 手機斷點 html / body 底色由純黑改為 var(--bg-color)，修復 iOS
//      橡皮筋滾動時露出的底部黑邊（viewport-fit=cover 早已存在）。
//   4. 貼底浮層加 env(safe-area-inset-bottom)：.dev-fab、.profile-toast、.dev-toast。
// 上一版 3.2.0 → 3.3.0（移除澳門天氣卡）：
//   － 刪除 scripts/modules/weather/ 及 precache 條目，index.html／main.js／icons.js 同步清乾淨。
//   ⚠ 一樣要升 CACHE_NAME：就算 weather.js / weather.css 已經由專案刪除，舊快取仍然留住條目，
//     唔升版本號就會繼續派舊 index.html / main.js，天氣卡照樣出現喺已安裝嘅裝置。
//   1. 刪除 scripts/modules/weather/（weather.js + weather.css）及下面 precache 條目。
//   2. index.html：移除天氣卡容器 #weather-card、樣式與腳本引用、icons.js?v=2.7.0、
//      main.js?v=3.3.0（移除 initWeather / weatherMaybeRefresh 掛鈎）。
//   3. icons.js：移除只為天氣卡新增嘅天氣圖示（cloud / cloudSun / cloudMoon / cloudRain /
//      cloudDrizzle / cloudSnow / cloudLightning / cloudFog / wind / droplet / thermometer）。
const CACHE_NAME = 'timetable-v4.17.0';
const urlsToCache = [
    './',
    './index.html',
    './manifest.json',
    './styles/main.css',
    './styles/icons.css',
    // './styles/splash.css' 已內嵌到 index.html 的 #splash-critical-css，唔需要再 precache
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
    './scripts/config/app-config.js',
    './scripts/modules/auth/cloud.js',
    './scripts/modules/auth/auth.js',
    './scripts/modules/auth/auth.css',
    './scripts/modules/profile/profile-content.js',
    './scripts/modules/profile/profile.js',
    './scripts/modules/profile/profile.css',
    './scripts/modules/liquidglass/liquidglass.js',
    './scripts/modules/liquidglass/liquidglass.css',
    // 開發者模式：新檔必須入 precache，否則首次離線開 App 會冇彈窗樣式／邏輯
    './scripts/modules/devtools/devtools.js',
    './scripts/modules/devtools/devtools.css',
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

// 寫入快取（只快取本身同源、HTTP 200 嘅成功回應，避免把 error page 也存起來）
function putInCache(request, response) {
    if (!response || response.status !== 200 || response.type !== 'basic') return;
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
}

// 靜態資源判定：呢類檔案內容唔會中途變，而且用 ?v=<版本> 控制新舊，
// 所以最適合「快取優先」—— 開 App 即刻由本機快取渲染，零網絡等待。
// ⚠ 唔可以包含 .json：課表／假期資料要永遠盡量拎最新，必須維持網絡優先。
const STATIC_DESTINATIONS = ['style', 'script', 'image', 'font', 'manifest'];
const STATIC_EXT_RE = /\.(?:css|js|mjs|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf)(?:$|\?)/i;

function isStaticAsset(request) {
    if (STATIC_DESTINATIONS.indexOf(request.destination) !== -1) return true;
    try {
        return STATIC_EXT_RE.test(new URL(request.url).pathname);
    } catch (e) {
        return false;
    }
}

// 攔截請求：
//   ① 靜態資源（CSS / JS / 圖片 / 字型）→ 快取優先。
//      舊版一律「網絡優先」，即係每次開 App 都要等 CSS／JS 來回一輪先畫得出畫面，
//      弱網時就變成用戶見到嘅「黑屏 0.5~1 秒」。
//   ② 其餘（JSON 資料、HTML 導覽）→ 維持網絡優先，失敗回退快取（離線仍可用）。
self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    // 只處理本專案 scope 內嘅請求
    // GitHub Pages 同一個 username.github.io 之下可能有多個專案／其他 SW，唔可以撈過界。
    // ⚠ 呢個判斷同時保證 Supabase（https://xxx.supabase.co/*）嘅請求永遠唔會被攔截：
    //    Supabase 係跨來源網域，唔會以本專案 scope 開頭，所以 Auth / PostgREST 全部直達網絡。
    //    呢點好重要 —— 雲端帳號資料絕對唔可以入快取，否則會出現「登出後仍讀到舊帳號」。
    if (!request.url.startsWith(self.registration.scope)) return;

    // ① 靜態資源：快取優先
    if (isStaticAsset(request)) {
        event.respondWith(
            caches.match(request).then((cached) => {
                if (cached) return cached;

                // 快取無（例如第一次見到新嘅 ?v=）→ 抓網絡並存起來
                return fetch(request).then((response) => {
                    putInCache(request, response);
                    return response;
                }).catch(() => {
                    // 連網絡都無 → 用 precache 落嚟嘅「無 query 版本」頂上
                    return caches.match(request, { ignoreSearch: true }).then((fallback) => {
                        return fallback || Response.error();
                    });
                });
            })
        );
        return;
    }

    // ② 資料／導覽：網絡優先
    event.respondWith(
        fetch(request).then((response) => {
            putInCache(request, response);
            return response;
        }).catch(() => {
            // ignoreSearch：離線時 request 可能帶住 ?v=3.0.0 版本戳，
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