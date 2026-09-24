# 我的課表 App

一個專為初二正設計的課表應用程式，包含以下功能：

- 📅 明日課表預測
- ⏱️ 即時倒數（仲有幾耐上/落堂）
- 🔍 搜尋科目與老師
- 🌙 深色 / 淺色模式切換
- 📊 本週課表總覽
- 🎉 假期倒數（根據 2026 校曆）
- ✨ 動畫效果
- 📖 卡片點擊展開

## 使用方式

1. 將所有檔案放到同一個資料夾
2. 使用本機伺服器開啟（例如 VS Code Live Server）
3. 在手機或電腦瀏覽器開啟

## 注意

因為使用 `fetch` 載入 JSON，必須透過 HTTP 伺服器開啟，不能直接雙擊 `index.html`。

## 部署到 GitHub Pages

上傳到 GitHub 時最常見嘅三個問題：

1. **漏咗上傳資料夾**：`data/`、`scripts/`、`styles/`、`assets/` 要整個上傳，
   只上傳 `index.html` 就會出現「找不到 json 檔 / 版面走樣」。
2. **Jekyll 處理**：專案根目錄要有 `.nojekyll`（本專案已附）。
   如果 GitHub Pages 嘅來源係 repo 根目錄（即 app 放喺子資料夾），
   `.nojekyll` 亦要放喺 repo 根目錄。
3. **網址要帶結尾斜線**：`https://<user>.github.io/<repo>/`。
   冇結尾斜線會令相對路徑少算一層（`index.html` 已內建自動修正）。

更新後仍然見到舊版的話：DevTools → Application → Service Workers → Unregister，
再按 Ctrl + Shift + R 強制重新整理。