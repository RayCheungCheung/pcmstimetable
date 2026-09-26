
<div align="center">

# 🏫 培正課表系統 (pcmstimetable)

**不再錯過任何一堂課。** 專為澳門培正中學師生打造的免費 iOS 18 毛玻璃風格課表系統：以學生為本、一鍵同步 Google 試算表、課堂與放學即時倒數、智慧假期自動覆蓋與離線儲存。

[![授權協議: CC BY-SA 4.0](https://img.shields.io/badge/授權協議-CC%20BY--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-sa/4.0/deed.zh-Hant)
[![版本](https://img.shields.io/badge/版本-v3.5.0-blue.svg)](https://pcmstimetable.com)
[![PWA 離線支援](https://img.shields.io/badge/PWA-已支援-success.svg)](https://pcmstimetable.com)
[![歡迎提交 PR](https://img.shields.io/badge/PRs-歡迎提交-brightgreen.svg)](https://github.com/RayCheungCheung/pcmstimetable)

[官方網站](https://pcmstimetable.com) • [服務條款](https://docs.google.com/document/d/1uZSE6z_BlPktYeTCYKMQ20om8wsiQ-AlTnQ0Je_1kSk/edit?usp=sharing) • [隱私權政策](https://docs.google.com/document/d/1FTYW23Sutq3zfIV0t6pFFlNf7IJhhPHKlQnizyI3Sog/edit?usp=sharing) • [回報問題](https://github.com/RayCheungCheung/pcmstimetable/issues) • [功能建議](https://github.com/RayCheungCheung/pcmstimetable/issues)

</div>

---

## 📖 文檔目錄

- [專案簡介](#-專案簡介)
- [核心功能](#-核心功能)
- [系統架構](#-系統架構)
- [快速上手](#-快速上手)
- [Google 試算表整合指南](#-google-試算表整合指南)
- [假期邏輯與資料格式](#-假期邏輯與資料格式)
- [開發路線圖](#-開發路線圖)
- [社群與支援](#-社群與支援)
- [參與貢獻](#-參與貢獻)
- [法律條款與開源授權](#-法律條款與開源授權)

---

## 🌟 專案簡介

**pcmstimetable.com** 是一個專為澳門培正中學師生與家長打造的極簡、現代化課表與校園日程管理平台。

平台以 **「以學生為本，為校園而生」** 為核心宗旨，採用 **iOS 18 液態玻璃** 毛玻璃視覺設計，整合 Google 試算表雲端動態同步、課堂與放學即時倒數，以及智慧假期自動覆蓋機制，帶來零廣告、零邊框冗餘的純粹校園體驗。

---

## ✨ 核心功能

### 🔑 1. Google 試算表雲端同步 (v3.5.0)
- 支援 Google 帳戶授權登入。
- 直接連結並解析個人或班級 Google 試算表，自動同步最新課表與臨時調課資訊。

### 🎉 2. 智慧動態假期模式
- 當天若為學校假期（如中秋節、國慶節等），自動置頂覆蓋課表與倒數。
- 頂部狀態欄動態顯示：「`假期中 · XX節快樂`」（例如：*假期中 · 中秋節快樂*）。

### 🕒 3. 課堂與放學即時倒數
- 動態計算當前課節剩餘時間、下一堂課教室與放學時間倒數。
- 支援校園鐘聲節奏匹配與彈性時間調整。

### 🎨 4. iOS 18 毛玻璃視覺設計
- 嚴格遵循 iOS 18 半透明毛玻璃 (`backdrop-filter`) 質感與微互動動效。
- 條款頁面對標 WhatsApp 官方長文章風格，支援無邊框目錄導覽與全域深色模式（Dark Mode）。

### 📱 5. PWA 離線秒開應用
- 支援「新增至主畫面」獨立執行。
- 具備離線快取機制，無網路環境下仍可秒開查詢歷史課表。

---

## 🏗️ 系統架構

```text
[ 客戶端 (瀏覽器 / PWA) ]
         │
         ├───► Service Worker (本機快取 / 離線引擎)
         │
         ├───► renderTodayUI() 渲染循環
         │        ├── 1. 檢查假期清單 (最高優先級) ──► 渲染假期卡片與橫幅
         │        └── 2. 解析課表資料 (次要優先級) ──► 啟動倒數與日程顯示
         │
         └───► Google Sheets API ──► 同步與本機儲存

```

---

## 🚀 快速上手

### 環境需求

* [Node.js](https://nodejs.org/?utm_source=gemini) (版本 18.0.0 或以上)
* [npm](https://www.npmjs.com/?utm_source=gemini) / [pnpm](https://pnpm.io/?utm_source=gemini) / [yarn](https://yarnpkg.com/?utm_source=gemini)

### 安裝步驟

1. **下載專案專案檔**
```bash
git clone [https://github.com/RayCheungCheung/pcmstimetable.git](https://github.com/RayCheungCheung/pcmstimetable.git)
cd pcmstimetable

```


2. **安裝專案依賴套件**
```bash
npm install

```


3. **設定環境變數**
建立 `.env.local` 檔案並設定 Google API 金鑰與 Client ID：
```env
VITE_GOOGLE_CLIENT_ID=你的_google_client_id
VITE_GOOGLE_API_KEY=你的_google_api_key

```


4. **啟動本機開發伺服器**
```bash
npm run dev

```


開啟瀏覽器造訪 `http://localhost:3000`。
5. **打包生產環境版本**
```bash
npm run build

```



---

## 🔐 Google 試算表整合指南

為了讓系統正確解析你的 Google 試算表課表，請確保試算表具備以下欄位結構：

| 星期 | 節次 | 時間 | 科目 | 教室 | 教師 |
| --- | --- | --- | --- | --- | --- |
| Mon | 1 | 08:30 - 09:10 | 中文 | 6A | 張老師 |
| Mon | 2 | 09:15 - 09:55 | 數學 | 6A | 李老師 |

---

## ⚙️ 假期邏輯與資料格式

假期資料在系統中擁有最高渲染優先權。只要日期匹配，系統將自動覆蓋日常課表。

### 資料結構 (`data/holidays.json`)

```json
[
  {
    "date": "2026-09-25",
    "name": "中秋節"
  },
  {
    "date": "2026-10-01",
    "name": "國慶節"
  }
]

```

---

## 🗺️ 開發路線圖

* [x] iOS 18 毛玻璃介面重構 (v3.0.0)
* [x] WhatsApp 風格《服務條款》頁面 (v3.4.0)
* [x] Google 試算表登入授權與動態同步 (v3.5.0)
* [x] 動態假期提醒與祝賀模式 (v3.5.0)
* [ ] 跨裝置課表推播通知
* [ ] 班級 / 社團活動行事曆整合

---

### ⭐ 如果這個專案節省了你的時間，歡迎在 GitHub 點個 Star 支援我們！

---

### 💬 加入社群

👋 **關注專案 — 第一時間獲取最新功能與更新：**

**常見問題、法律文件、路線圖與技術支援** → [服務條款與免責聲明](https://docs.google.com/document/d/1uZSE6z_BlPktYeTCYKMQ20om8wsiQ-AlTnQ0Je_1kSk/edit?usp=sharing&utm_source=gemini) · [隱私權政策](https://docs.google.com/document/d/1FTYW23Sutq3zfIV0t6pFFlNf7IJhhPHKlQnizyI3Sog/edit?usp=sharing&utm_source=gemini) · [完整授權條款](https://docs.google.com/document/d/1M8dI9gZLA96MseeIfQcL2jwPYADD89mLWk5-vA5iT8s/edit?usp=sharing&utm_source=gemini) · [回報問題](https://www.google.com/url?sa=E&source=gmail&q=https://github.com/RayCheungCheung/pcmstimetable/issues)

---

## 🤝 參與貢獻

歡迎任何形式的貢獻！如果你有好的想法或發現程式漏洞（Bug）：

1. Fork 本專案。
2. 建立你的分支 (`git checkout -b feature/AmazingFeature`)。
3. 提交你的修改 (`git commit -m 'Add some AmazingFeature'`)。
4. 推送到分支 (`git push origin feature/AmazingFeature`)。
5. 開啟一個 Pull Request。

---

## 📄 法律條款與開源授權

本專案遵循嚴謹的開源規範與法律條款，相關完整文件可直接點擊下方連結線上查閱：

* 📜 **服務條款與免責聲明：** [線上閱讀 Google Docs 文檔](https://docs.google.com/document/d/1uZSE6z_BlPktYeTCYKMQ20om8wsiQ-AlTnQ0Je_1kSk/edit?usp=sharing&utm_source=gemini)
* 🔒 **隱私權政策：** [線上閱讀 Google Docs 文檔](https://docs.google.com/document/d/1FTYW23Sutq3zfIV0t6pFFlNf7IJhhPHKlQnizyI3Sog/edit?usp=sharing&utm_source=gemini)
* 📜 **服務條款、免責聲明與開源許可整合版：** [線上閱讀 Google Docs 文檔](https://docs.google.com/document/d/1M8dI9gZLA96MseeIfQcL2jwPYADD89mLWk5-vA5iT8s/edit?usp=sharing&utm_source=gemini)

### 授權協議說明

本專案採用 **[CC BY-SA 4.0 (Creative Commons 姓名標示-相同方式分享 4.0 國際)](https://www.google.com/url?sa=E&source=gmail&q=https://creativecommons.org/licenses/by-sa/4.0/deed.zh-Hant)** 授權協議釋出。你可以自由複製、修改與散佈，但必須標註原作者 (`RayCheungCheung/pcmstimetable`)，且修改後的作品必須採用相同的免費方式公開共享。

---

⬆ [回到頂部](https://www.google.com/search?q=%2523-%25E5%259F%25B9%25E6%25AD%25A3%25E8%25AA%25B2%25E8%25A1%25A8%25E7%25B3%25BB%25E7%25B5%25B1-pcmstimetable&utm_source=gemini) · 用 ❤️ 為澳門培正中學師生打造

**pcmstimetable v3.5.0** · Node ≥18.0.0 · [CC BY-SA 4.0 授權協議](https://www.google.com/url?sa=E&source=gmail&q=https://creativecommons.org/licenses/by-sa/4.0/deed.zh-Hant) · [pcmstimetable.com](https://www.google.com/url?sa=E&source=gmail&q=https://pcmstimetable.com)
