
<div align="center">

# 🏫 pcmstimetable

**Never miss a class.** Free iOS 18 Liquid Glass PWA for Pui Ching Middle School Macau: student-first design, seamless Google Sheets sync, real-time period & dismissal countdowns, smart holiday overrides, and offline storage.

[![License: CC BY-SA 4.0](https://img.shields.io/badge/License-CC%20BY--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-sa/4.0/)
[![Version](https://img.shields.io/badge/version-v3.5.0-blue.svg)](https://pcmstimetable.com)
[![PWA Ready](https://img.shields.io/badge/PWA-Ready-success.svg)](https://pcmstimetable.com)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/RayCheungCheung/pcmstimetable)

[Website](https://pcmstimetable.com) • [Terms of Service](https://pcmstimetable.com/terms) • [Report Bug](https://github.com/RayCheungCheung/pcmstimetable/issues) • [Request Feature](https://github.com/RayCheungCheung/pcmstimetable/issues)

</div>

---

## 📖 Table of Contents

- [Overview](#-overview)
- [Key Features](#-key-features)
- [System Architecture](#-system-architecture)
- [Quick Start](#-quick-start)
- [Google Sheets Integration Guide](#-google-sheets-integration-guide)
- [Holiday Logic & Data Format](#-holiday-logic--data-format)
- [Roadmap](#-roadmap)
- [Community & Support](#-community--support)
- [Contributing](#-contributing)
- [License & Terms](#-license--terms)

---

## 🌟 Overview

**pcmstimetable.com** 是一個專為澳門培正中學師生與家長打造的極簡、現代化 PWA 課表與校園日程管理平台。

平台以 **「以學生為本，為校園而生 (Built for students, by students)」** 為核心宗旨，採用 **iOS 18 Liquid Glass** 毛玻璃美學設計，整合 Google Sheets 雲端動態同步、課堂與放學即時倒數，以及智慧假期自動覆蓋機制，帶來零廣告、零卡片邊框冗餘的純粹校園體驗。

---

## ✨ Key Features

### 🔑 1. Google Sheets 雲端同步 (v3.5.0)
- 支援 Google 帳戶 OAuth 授權登入。
- 直接連結並解析個人或班級 Google 試算表，自動同步最新課表與臨時調課資訊。

### 🎉 2. 智慧動態假期模式
- 當天若為學校假期（如中秋節、國慶節等），自動置頂覆蓋課表與倒數。
- 頂部狀態欄動態顯示：「`假期中 · XX節快樂`」（如：*假期中 · 中秋節快樂*）。

### 🕒 3. 課堂與放學即時倒數
- 動態計算當前課節剩餘時間、下堂課教室與放學時間倒數。
- 支援校園鐘聲節奏匹配與彈性時間調整。

### 🎨 4. iOS 18 Liquid Glass 視覺設計
- 嚴格遵循 iOS 18 半透明毛玻璃 (`backdrop-filter`) 質感與微互動動效。
- 條款頁面對標 WhatsApp 官方長文章風格，支援無邊框目錄導覽與全域深色模式（Dark Mode）。

### 📱 5. PWA 離線秒開 (Progressive Web App)
- 支援「新增至主畫面」獨立執行。
- 具備 Cache First 離線快取機制，無網路環境下仍可秒開查詢歷史課表。

---

## 🏗️ System Architecture

```text
[ Client (Browser / PWA) ]
         │
         ├───► Service Worker (Cache / Offline Engine)
         │
         ├───► renderTodayUI() Cycle
         │        ├── 1. Check Holiday List (Priority 1) ──► Render Holiday Card & Banner
         │        └── 2. Parse Timetable Data (Priority 2) ──► Start Countdown & Schedule
         │
         └───► Google Sheets OAuth & API ──► Sync & Dynamic Local Storage

```

---

## 🚀 Quick Start

### Prerequisites

* [Node.js](https://www.google.com/search?q=https://nodejs.org/&utm_source=gemini) (v18.0.0 or higher)
* [npm](https://www.google.com/search?q=https://www.npmjs.com/&utm_source=gemini) / [pnpm](https://www.google.com/search?q=https://pnpm.io/&utm_source=gemini) / [yarn](https://www.google.com/search?q=https://yarnpkg.com/&utm_source=gemini)

### Installation Steps

1. **Clone the repository**
```bash
git clone [https://github.com/RayCheungCheung/pcmstimetable.git](https://github.com/RayCheungCheung/pcmstimetable.git)
cd pcmstimetable

```


2. **Install dependencies**
```bash
npm install

```


3. **Configure environment variables**
建立 `.env.local` 檔案並設定 Google API Key 與 OAuth Client ID：
```env
VITE_GOOGLE_CLIENT_ID=your_google_client_id
VITE_GOOGLE_API_KEY=your_google_api_key

```


4. **Start the local development server**
```bash
npm run dev

```


開啟瀏覽器造訪 `http://localhost:3000`。
5. **Build for production**
```bash
npm run build

```



---

## 🔐 Google Sheets Integration Guide

為了讓系統正確解析你的 Google Sheets 課表，請確保試算表具備以下欄位結構：

| Day | Period | Time | Subject | Room | Teacher |
| --- | --- | --- | --- | --- | --- |
| Mon | 1 | 08:30 - 09:10 | 中文 | 6A | 張老師 |
| Mon | 2 | 09:15 - 09:55 | 數學 | 6A | 李老師 |

---

## ⚙️ Holiday Logic & Data Format

假期資料在系統中擁有最高渲染優先權。只要日期匹配，系統將自動覆蓋日常課表。

### Data Structure (`data/holidays.json`)

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

## 🗺️ Roadmap

* [x] iOS 18 Liquid Glass 介面重構 (v3.0.0)
* [x] WhatsApp 風格《服務條款》頁面 (v3.4.0)
* [x] Google Sheets 登入授權與動態同步 (v3.5.0)
* [x] 動態假期提醒與祝賀模式 (v3.5.0)
* [ ] 跨裝置課表推播通知 (Push Notifications)
* [ ] 班級 / 社團活動行事曆整合

---

### ⭐ Star the repo if pcmstimetable helped you save time and make your school life easier.

---

### 💬 Join the community

👋 **Follow the project — get new features, releases & updates first:**

**Questions, feature requests, roadmap & support** → [Website Portal](https://www.google.com/url?sa=E&source=gmail&q=https://pcmstimetable.com) · [Terms](https://www.google.com/url?sa=E&source=gmail&q=https://pcmstimetable.com/terms) · [Report Issue](https://www.google.com/url?sa=E&source=gmail&q=https://github.com/RayCheungCheung/pcmstimetable/issues)

---

## 🤝 Contributing

歡迎任何形式的貢獻！如果你有好的想法或發現 Bug：

1. Fork 本專案。
2. 建立你的 Feature 分支 (`git checkout -b feature/AmazingFeature`)。
3. Commit 你的修改 (`git commit -m 'Add some AmazingFeature'`)。
4. Push 到分支 (`git push origin feature/AmazingFeature`)。
5. 開啟一個 Pull Request。

---

## 📄 License & Terms

* **License**: 本專案遵循 **[CC BY-SA 4.0](https://www.google.com/url?sa=E&source=gmail&q=https://creativecommons.org/licenses/by-sa/4.0/)** 授權協議。您可以自由修改與散佈，但必須標示原作者，且修改後的衍生版本必須以相同的免費方式公開。
* **Terms of Service**: 詳見 [服務條款與免責聲明](https://www.google.com/url?sa=E&source=gmail&q=https://pcmstimetable.com/terms)。本系統所有課表數據均以澳門培正中學官方發佈之最新通告為準。

---

⬆ [Back to top](https://www.google.com/search?q=%2523-pcmstimetable&utm_source=gemini) · Built with ❤️ for Pui Ching Middle School Students & Teachers.

**pcmstimetable v3.5.0** · Node ≥18.0.0 · [CC BY-SA 4.0 License](https://www.google.com/url?sa=E&source=gmail&q=https://creativecommons.org/licenses/by-sa/4.0/) · [pcmstimetable.com](https://www.google.com/url?sa=E&source=gmail&q=https://pcmstimetable.com)
