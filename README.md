# API Chat

用自己的 Anthropic API 金鑰和 Claude 對話的桌面 App（Windows／macOS），對話存在自己的電腦。另附命令列工具，讓 Claude Code 等 AI 工具也能用同一把金鑰。

- 費用記在使用者自己的 Claude Console 帳號。App 不提供、也不內建任何金鑰。
- 本專案與 Anthropic 無關，非官方產品。

## 狀態

開發中。目前完成：對話介面（瀏覽器開發版）、命令列工具（Linux）。桌面外殼（Tauri）、金鑰存系統鑰匙圈、Windows／macOS 安裝檔在後續版本加入。

## 功能（第一版）

- 多輪對話，回覆逐字顯示，可停止、重新產生
- 選模型（Haiku 4.5、Sonnet 5.5、Opus 5.5、Fable 5.1）與思考深度
- 附檔：文字檔、圖片（PNG／JPEG／GIF／WebP）、PDF；可貼上或拖進來
- 對話自動存在本機，可搜尋、改名、刪除、匯出 Markdown
- 角色範本（system prompt）
- 每則回覆顯示 token 數與估算費用，設定頁有本月每日花費
- 淺色／深色／跟系統

## 命令列工具

給 Claude Code 等 AI 工具在終端機呼叫，費用一樣記在你的 API 金鑰。兩個工具共用同一把金鑰（`~/.config/api-chat/anthropic.env`）。

| 工具 | 用途 | 說明 |
|---|---|---|
| `ai-call` | 讓 AI 把簡單的工作派給便宜的模型（摘要、翻譯、審閱、寫草稿…） | [cli/ai-call](cli/ai-call/README.md) |
| `use-api` | Claude 訂閱額度用完時，改用 API 金鑰接續同一段 Claude Code 對話 | [cli/use-api](cli/use-api/README.md) |

安裝（目前只支援 Linux，需要 Node.js 22.18 以上）：

```bash
git clone https://github.com/Arce0406/api-chat.git && cd api-chat
npm ci                                   # .npmrc 已設 ignore-scripts，套件不能在安裝時執行腳本
ln -s "$PWD/bin/ai-call" ~/.local/bin/ai-call
ln -s "$PWD/bin/use-api" ~/.local/bin/use-api
ln -s "$PWD/cli/ai-call/skill" ~/.claude/skills/ai-call   # 讓 Claude Code 知道何時、怎麼用 ai-call
use-api setup                            # 貼上金鑰，驗證後存起來
```

## 安全設計

- 只連到 `https://api.anthropic.com`（網址寫死，畫面也用 CSP 限制連線對象）。
- AI 回覆不可信：回覆裡的 HTML 一律當文字顯示、不載入外部圖片（避免透過圖片網址把對話內容帶出去）、連結只允許 http(s)／mailto 並用系統瀏覽器開，最後再經 DOMPurify 過濾。
- 金鑰不存在對話資料庫裡。瀏覽器開發版只存在分頁的 sessionStorage，桌面版改存作業系統鑰匙圈。

## 開發

需要 Node.js 22.18 以上。

```bash
npm ci
git config core.hooksPath .githooks   # 推送前自動跑 npm run check
npm run dev                            # http://127.0.0.1:5310
```

## 測試

| 指令 | 內容 |
|---|---|
| `npm run check` | 型別檢查、單元測試、建置 |
| `npm run e2e` | 端對端測試（Playwright 官方 docker 映像 `v1.56.1-noble`，API 用測試替身） |
| `REAL_API_KEY=… E2E_REAL=1 npm run e2e` | 用真的金鑰打真的 API（Haiku、Sonnet 各一次，花費不到 US$0.01） |
