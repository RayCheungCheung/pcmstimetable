// ============================================================
// 認證設定 —— 只需改這個檔案就能開通雲端帳號同步
// （同層的 app-config.js 負責對外正式網域，兩者互不相干）
// ============================================================
//
// 本 App 提供「Email + 密碼」的註冊與登入，雲端後端為 Supabase。
//
// ⚠ 舊版的 Google Sheets / Google Apps Script 後端已徹底移除：
//    該方案只要拿到 Web App 網址就可以讀寫所有帳號（權限過寬），
//    而且並無資料列層級隔離，因此不再使用。
//
// ── 帳號資料流（兩層，缺一不可）────────────────────────
//   ① 登入憑證 → Supabase Auth（auth.users）
//        · 密碼以 bcrypt 儲存在伺服器，前端永遠唔會計算或保存雜湊值。
//        · 登入成功後取得 JWT，之後所有資料庫請求都帶著它。
//   ② 應用資料 → public.profiles（班級、頭像、課表綁定…）
//        · 已啟用 Row Level Security，每人只可以存取自己那一行。
//        · 第一次使用前請先在 Supabase SQL Editor 執行 supabase/schema.sql。
//
//   本機 localStorage 仍保留一份完整副本做「離線優先」快取：
//   讀取時本機優先（秒開），寫入時本機即時、雲端背景補送。
//
// ── 啟用雲端同步（3 步）─────────────────────────────
//   1. 開一個 Supabase 專案 → SQL Editor → 執行 supabase/schema.sql
//   2. Authentication → Providers → Email
//        · 想維持「註冊完即刻可以登入」→ 關閉 Confirm email
//        · 保持開啟亦可，前端會顯示「請到信箱點擊確認連結」
//   3. 到 Project Settings → API，把 Project URL 與 Publishable key 貼到下面
//
// ⚠ url / anonKey 留空（或仍是下面的佔位字串）＝ 純本機模式，
//   不會發出任何網絡請求，亦不會註冊／登入任何雲端帳號。
// ⚠ 絕對不要在這裡填 service_role / secret key：
//   本檔會原封不動送到瀏覽器，任何有權限的密鑰都會外洩。
// ============================================================

window.APP_AUTH_CONFIG = {
    // 「記住我」勾選時，Session 保留天數
    sessionDays: 30,

    // 允許建立 Email 帳號（關掉就完全不能註冊／登入）
    allowLocalAccounts: true,

    // 允許自訂班級（使用者自行輸入班別）
    allowCustomClass: true,

    // 密碼長度下限（字元）。
    // ⚠ 必須與 Supabase 專案「Authentication → Policies → Password」的設定一致，
    //   否則會出現「前端話可以、Supabase 話唔得」的落差。
    // ⚠ Supabase 後台才是真正把關者；這裡只是即時提示，改前端改不動後端規則。
    passwordMinLength: 6,

    // 離線時是否允許「用這部裝置既有的登入狀態」進入 App。
    //   true（預設）：該帳號曾在此裝置成功登入並持有有效 refresh token → 先放行本機資料，
    //                 恢復連線後 cloudActivateAccount() 會自動向 Supabase 重新校驗。
    //                 信任層級＝「信任這部裝置」，同舊版本機快取一致。
    //   false        ：連唔到線就一律不能登入。最嚴格，但在地鐵／飛行模式會開唔到 App。
    // ⚠ 無論此值為何，「未曾登入過」或「權杖已被撤銷」的帳號都一律不能離線登入。
    allowOfflineSignIn: true,

    // ── 登出時的憑證處置 ────────────────────────────────────
    // 按下「登出」時，是否連同「該帳號儲存在本機的續期權杖」一併銷毀。
    //   true （預設，最安全）：登出後本機不再持有任何可換取新權杖的憑證。
    //                          代價：想切換返該帳號時要重新輸入密碼。
    //   false                ：保留續期權杖，切換帳號免密碼（= 舊版本行為）。
    //                          代價：裝置遺失／被他人取用時，該權杖仍可能被用來
    //                                換取有效 session，直至伺服器端撤銷為止。
    // ⚠ 無論此值為何，雲端撤銷（POST /auth/v1/logout）都會執行；這裡只影響「本機副本」。
    logoutRevokesCredential: true,

    // ── Supabase 雲端儲存 ────────────────────────────────────
    supabase: {
        // 是否啟用雲端同步（false = 純本機，等同舊版）
        enabled: true,

        // Project URL（Project Settings → API → Project URL）
        url: 'https://ioiofueydpfkwjmyqejp.supabase.co',

        // ⚠ 貼上完整的 Publishable key（sb_publishable_…）或舊版 anon key（eyJ…）。
        //    下面這串係「未設定」的佔位值，cloudEnabled() 會視為純本機模式，
        //    所以未填之前 App 一樣開得正常，只係唔會同步。
        anonKey: 'sb_publishable_H1HHV96JQhHO_0SKOhLj3A_9cMfa6pd',

        // 應用資料表名（對應 supabase/schema.sql 的 public.profiles）
        table: 'profiles',

        // 單次請求逾時（毫秒）。Supabase 反應遠快於 Apps Script，8 秒已很寬鬆
        timeoutMs: 8000,

        // 網絡失敗自動重試次數
        retry: 2,

        // 存取權杖（JWT）提前多少毫秒續期，避免請求剛好撞上過期
        refreshSkewMs: 60000
    }
};
