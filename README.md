# Story Canvas Layout 0.6.16

Mobile Enablement。

這是第一個允許 Obsidian Mobile 正式啟用的版本。

## 啟用 Mobile

manifest：

`isDesktopOnly: false`

因此 Android / iOS Obsidian 不再把插件開關鎖成灰色。

## 目前沒有 Desktop-only 依賴

插件沒有使用：
- Electron
- Node `fs`
- Node `path`
- `process`
- `window.require`

主要使用：
- Obsidian API
- Canvas runtime API
- DOM
- Pointer Events
- Vault API

這些都可以在 Obsidian Mobile 環境存在。

## 手機觸控調整

### Pointer drag threshold

Desktop：
4px

Touch / Pen：
12px

手機手指自然會微抖，所以提高門檻，
降低普通 Tap / Canvas Pan 被誤判成 Story Layout insertion drag 的機率。

## 手機建立 Frame

桌面：
- 點 Vertical / Horizontal：建立 Frame
- Drag 按鈕：把空 Frame 放到指定位置

手機：
- 不使用 HTML5 drag-and-drop
- 點 Vertical / Horizontal 即可

如果有選取 cards：
→ 把選取內容包進 Frame

沒有選取：
→ 在目前 Canvas 中央建立空 Frame

## 手機 UI

Mobile 下：
- 底部 Vertical / Horizontal 按鈕放大到 42px touch target
- icon 26px
- Popup Toolbar touch target 放大
- Version / Diagnostics modal 限制在手機 viewport
- Description textarea 使用 16px，降低手機瀏覽器自動 zoom

## 已保留功能

- Vertical / Horizontal Frame
- insertion / drag-out
- Detach from Story Frame
- Nested Frame
- Alignment
- Card Versions
- Note Versions
- Frame Versions
- Branch descriptions
- Settings
- restart persistence
- Canvas JSON identity
- folder move rebind
- Repair / Diagnostics
- Advanced Canvas coexistence

## Mobile 現況

0.6.16 的目標是：
「可以啟用、可以建立、核心 Canvas pointer 行為有基本 touch safety」。

手機上的長按選單、Canvas 原生 resize、複雜 Nested drag
仍建議實機測試。

Desktop 行為沒有改。
