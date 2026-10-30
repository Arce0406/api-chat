# API Chat

用自己的 Anthropic API 金鑰和 Claude 對話的桌面 App（Windows／macOS），對話存在自己的電腦。另附命令列工具，讓 Claude Code 等 AI 工具也能用同一把金鑰。

- 費用記在使用者自己的 Claude Console 帳號。App 不提供、也不內建任何金鑰。
- 本專案與 Anthropic 無關，非官方產品。

## 狀態

開發中。目前完成：桌面版（Windows、macOS）、命令列工具（Linux）。Windows／macOS 版的命令列工具在下一版加入。

## 安裝桌面版

到 [Releases](https://github.com/Arce0406/api-chat/releases) 下載最新版：

| 系統 | 檔案 |
|---|---|
| Windows 10／11 | `API.Chat_<版本>_x64-setup.exe` |
| macOS 11 以上（Apple 晶片與 Intel） | `API.Chat_<版本>_universal.dmg` |

安裝檔沒有付費簽章，第一次打開時系統會警告「無法確認開發者」，這是預期的。

**Windows**

1. 執行 `.exe`。出現藍色的「Windows 已保護您的電腦」時，按「其他資訊」→「仍要執行」。
2. 安裝在自己的使用者帳號底下，不需要系統管理員權限。安裝完會出現在開始功能表。

**macOS**

1. 打開 `.dmg`，把 API Chat 拖到「應用程式」資料夾。
2. 第一次打開會出現「無法打開」。按「完成」，然後到「系統設定 > 隱私權與安全性」，往下找到 API Chat，按「強制打開」（或「仍要打開」），再輸入電腦密碼。
3. 如果出現「API Chat 已損毀，無法打開」，在「終端機」執行下面這行，再打開一次：

   ```bash
   xattr -cr "/Applications/API Chat.app"
   ```

**資料存在哪裡**

- API 金鑰：使用者資料夾的 `.config/api-chat/anthropic.env`（Windows 是 `C:\Users\<你>\.config\api-chat\anthropic.env`），只有你的帳號能讀。命令列工具也讀這個檔，設定一次就好。在 App 的「設定 > API 金鑰」可以看到實際位置。App 只在啟動時讀一次金鑰，用命令列換了金鑰要重開 App。解除安裝**不會**刪除金鑰；要刪除請先在 App 裡按「刪除」。
- 建議在 Claude Console 幫這把金鑰設每月花費上限：萬一金鑰外洩，損失也有上限。
- 對話、角色範本、用量：存在 App 內建網頁畫面的資料夾，只在這台電腦。位置依系統而定（Windows 一般在 `%LOCALAPPDATA%\io.github.arce0406.apichat`）。解除安裝不一定會刪除。

## 功能（第一版）

- 多輪對話，回覆逐字顯示，可停止、重新產生
- 選模型（Haiku 4.5、Sonnet 5.5、Opus 5.5、Fable 5.1）與思考深度
- 附檔：文字檔、圖片（PNG／JPEG／GIF／WebP）、PDF；可貼上或拖進來
- 對話自動存在本機，可搜尋、改名、刪除、匯出 Markdown
- 角色範本（system prompt）
- 每則回覆顯示 token 數與估算費用，設定頁有本月每日花費
- 淺色／深色／跟系統

## 命令列工具

給 Claude Code 等 AI 工具在終端機呼叫，費用一樣記在你的 API 金鑰。兩個工具和桌面版共用同一把金鑰（`~/.config/api-chat/anthropic.env`）。

| 工具 | 用途 | 說明 |
|---|---|---|
| `ai-call` | 讓 AI 把簡單的工作派給便宜的模型（摘要、翻譯、審閱、寫草稿…） | [cli/ai-call](cli/ai-call/README.md) |
| `use-api` | Claude 訂閱額度用完時，改用 API 金鑰接續同一段 Claude Code 對話 | [cli/use-api](cli/use-api/README.md) |

安裝（目前只支援 Linux，需要 Node.js 22.18 以上）：

```bash
git clone https://github.com/Arce0406/api-chat.git && cd api-chat
npm ci --omit=dev                        # 只裝執行需要的套件；.npmrc 已設 ignore-scripts，套件不能在安裝時執行腳本
mkdir -p ~/.local/bin ~/.claude/skills
ln -s "$PWD/bin/ai-call" ~/.local/bin/ai-call
ln -s "$PWD/bin/use-api" ~/.local/bin/use-api
ln -s "$PWD/cli/ai-call/skill" ~/.claude/skills/ai-call   # 讓 Claude Code 知道何時、怎麼用 ai-call
use-api setup                            # 貼上金鑰，驗證後存起來
```

找不到 `ai-call`、`use-api` 指令時，確認 `~/.local/bin` 在 `PATH` 裡（例如在 `~/.bashrc` 加 `export PATH="$HOME/.local/bin:$PATH"`）。

## 安全設計

- 只連到 `https://api.anthropic.com`（網址寫死，畫面也用 CSP 限制連線對象）。
- AI 回覆不可信：回覆裡的 HTML 一律當文字顯示、不載入外部圖片（避免透過圖片網址把對話內容帶出去）、連結只允許 http(s)／mailto 並用系統瀏覽器開，最後再經 DOMPurify 過濾。
- 金鑰不存在對話資料庫裡。桌面版存在使用者資料夾的檔案（Linux／macOS 權限 600、資料夾 700；Windows 使用者資料夾預設只有自己能讀），和命令列工具共用；瀏覽器開發版只存在分頁的 sessionStorage。
  - 沒有用作業系統鑰匙圈：在 Windows 上，同一個帳號下的程式本來就讀得到認證管理員，保護和檔案差不多；在 macOS 上，未簽章的 App 每次更新都會再詢問一次。所以選擇不多加套件、和命令列工具共用一個檔。
- 桌面版的視窗只能顯示 App 自己的畫面，其他網址一律擋下；連結用系統瀏覽器開，只允許 http、https、mailto。

## 開發

需要 Node.js 22.18 以上。

```bash
npm ci
git config core.hooksPath .githooks   # 推送前自動跑 npm run check
npm run dev                            # http://127.0.0.1:5310
```

## 桌面版開發

- Rust 部分在 `src-tauri/`。開發機不用裝 Rust：`npm run test:rust` 會在 docker 裡編譯並跑 Rust 測試（第一次會建映像，要幾分鐘）。
- 有 Rust 與 Tauri 系統套件的電腦可以用 `npm run tauri dev` 開桌面版。
- 安裝檔由 GitHub Actions 建置（`.github/workflows/release.yml`），只在發佈時手動觸發：Actions 分頁 →「建置安裝檔」→ Run workflow。完成後 Releases 會出現草稿，確認後再發佈。
- 版本號在 `src-tauri/tauri.conf.json` 的 `version`（和 `package.json`、`src-tauri/Cargo.toml` 一起改）。

## 測試

| 指令 | 內容 |
|---|---|
| `npm run check` | 型別檢查、單元測試、建置 |
| `npm run e2e` | 端對端測試（Playwright 官方 docker 映像 `v1.56.1-noble`，API 用測試替身） |
| `REAL_API_KEY=… E2E_REAL=1 npm run e2e` | 用真的金鑰打真的 API（Haiku、Sonnet 各一次，花費不到 US$0.01） |
