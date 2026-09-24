// ============================================================
// 認證設定 —— 這是唯一需要你動手改的檔案
// ============================================================
//
// 【啟用「使用 Google 帳號登入」三步曲】
//
//  1. 到 https://console.cloud.google.com/apis/credentials
//     建立「OAuth 用戶端 ID」→ 應用程式類型選「網頁應用程式」。
//
//  2. 在該 Client ID 的設定頁填上兩個欄位：
//     · 已授權的 JavaScript 來源：https://你的網域
//       （本機測試要另外加 http://localhost:端口 與 http://127.0.0.1:端口）
//     · 已授權的重新導向 URI：跟上面一樣即可（GIS 彈窗模式其實不需要，但填了較保險）
//
//  3. 把拿到的 Client ID（長得像 1234567890-xxxxxxxx.apps.googleusercontent.com）
//     填到下面 googleClientId 的引號內。存檔、重新整理，Google 按鈕就會出現。
//
//  ※ 未填的情況下 App 依然完全可用：
//     · Email + 密碼註冊 / 登入照常運作
//     · Google 按鈕會顯示「未設定」，並提供一個小面板讓你之後直接貼上 Client ID
//       （貼上後存進 localStorage，不用再改檔案）
//
// ============================================================

window.APP_AUTH_CONFIG = {
    // ← 把 Google OAuth Client ID 貼在這裡
    googleClientId: '',

    // 進到登入頁時，自動嘗試顯示 Google 一鍵登入提示（One Tap）；如覺得騷擾可設 false
    googleAutoSelect: false,

    // 「記住我」勾選時，Session 保留天數
    sessionDays: 30,

    // 允許建立本機 Email 帳號（純前端示範用；關掉就只剩 Google 登入）
    allowLocalAccounts: true,

    // 允許自訂班級（使用者自行輸入班別）
    allowCustomClass: true
};
