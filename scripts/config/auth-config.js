// ============================================================
// 認證設定 —— 只需改這個檔案就能開通雲端同步
// （同層的 app-config.js 負責對外正式網域，兩者互不相干）
// ============================================================
//
// 本 App 提供「Email + 密碼」的註冊與登入。
// 帳號預設會同步到 Google Sheets（雲端永續保存），
// 本機 localStorage 同時保留一份完整副本做「離線優先」快取。
//
// ── 啟用雲端同步（3 步）─────────────────────────────
//   1. 開一個 Google 試算表 → 擴充功能 → Apps Script
//   2. 貼上本專案 google-apps-script/Code.gs 全部內容 → 部署為網頁應用程式
//        · 執行身分：我      · 可存取權：任何人
//   3. 把部署得到的 /exec 網址貼到下面 cloud.endpoint
//
// ⚠ endpoint 留空 = 純本機模式（同舊版行為完全一樣，不會有任何網絡請求）
// ============================================================

window.APP_AUTH_CONFIG = {
    // 「記住我」勾選時，Session 保留天數
    sessionDays: 30,

    // 允許建立 Email 帳號（關掉就完全不能註冊／登入）
    allowLocalAccounts: true,

    // 允許自訂班級（使用者自行輸入班別）
    allowCustomClass: true,

    // ── Google Sheets 雲端儲存（via Google Apps Script）──────────────
    cloud: {
        // 是否啟用雲端同步（false = 純本機，等同舊版）
        enabled: true,

        // ⚠ 貼上你自己部署的 GAS Web App 網址（必須以 /exec 結尾）
        //    例：https://script.google.com/macros/s/AKfycb....../exec
        endpoint: 'https://script.google.com/macros/s/AKfycbxFMyOP-hu33ATlMAg5havG-5eNqcqnZRsqTREBgQR6Rx1YDXcQ0UP5VaebJtTltrklpA/exec',

        // 單次請求逾時（毫秒）。Apps Script 冷啟動較慢，建議不要低於 8000
        timeoutMs: 8000,

        // 網絡失敗自動重試次數
        retry: 2
    }
};
