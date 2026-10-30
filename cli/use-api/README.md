# use-api

Claude 訂閱額度用完時，用**自己的 Anthropic API 金鑰**接續同一段 Claude Code 對話，改扣 API 額度（例如 Max 方案每月附的 API 額度）。名稱就是字面意思：改用 API 計費接著做。

```bash
# 訂閱額度用完了：先在 Claude Code 裡 /exit，然後在同一個資料夾
use-api --continue        # 接續剛才的對話，改用 API 金鑰計費
# 額度重置後，照常用 claude --continue 回到訂閱計費
```

目前只支援 Linux。Windows／macOS 版會和桌面 App 的安裝檔一起提供。

## 安裝

需要 Node.js 22.18 以上；執行時不需要任何 npm 套件。安裝方式見 [repo 首頁的 README](../../README.md#命令列工具)。

第一次使用先執行 `use-api setup`，貼上金鑰（不會顯示在畫面），驗證有效後存到 `~/.config/api-chat/anthropic.env`（權限 600），`ai-call` 也讀這個檔。金鑰檔已經在別處（例如自己的機密資料夾）時，可以用連結指過去，`use-api setup` 不會覆寫連結的目標。

## 指令

| 指令 | 說明 |
|---|---|
| `use-api [claude 的參數…]` | 用 API 金鑰啟動 Claude Code，參數原樣轉給 `claude`，例如 `--continue`、`--resume`、`--model opus` |
| `use-api setup` | 輸入金鑰並驗證（呼叫官方「列出模型」API，不產生費用）後存起來；`--stdin` 從 stdin 讀，`--no-verify` 不驗證 |
| `use-api status` | 金鑰存在哪（遮蔽顯示）、有沒有設定衝突 |
| `use-api remove` | 刪除金鑰檔；是連結時只刪連結 |
| `use-api help` | 說明 |

結束碼：`0` 成功、`1` 失敗、`2` 參數錯誤、`3` 沒有金鑰。啟動 Claude Code 時回傳它的結束碼；被訊號結束時是 128＋訊號編號（例如 130）。

## 運作方式

- 用 Claude Code 的 `--settings` 參數帶入 `apiKeyHelper`，helper 就是 `use-api print-key`。**只影響這一次啟動**，不改 `~/.claude/settings.json`；直接用 `claude` 仍是訂閱計費。
- `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_CUSTOM_HEADERS`、`CLAUDE_CODE_USE_BEDROCK` 等變數會讓 Claude Code 不用這把金鑰，或把金鑰送到別的位址。use-api 兩層處理：
  - 從子程序環境移除。
  - 在 `--settings` 的 `env` 裡明確覆寫（網址固定 `https://api.anthropic.com`，其他清空）。`--settings` 的優先順序高於使用者、專案、local 設定檔，所以不管這些變數寫在哪一層設定檔（包含 repo 根目錄、worktree 主 checkout 的 local 設定），都會被蓋掉。2026-10-30 實測：專案設定寫了假網址、假 token、假 header 與 `CLAUDE_CODE_USE_BEDROCK=1`，use-api 仍以金鑰正常回覆。
- 公司統一派發的設定（managed settings）優先順序比 `--settings` 高，蓋不掉。`/etc/claude-code/managed-settings.json` 或 `managed-settings.d/*.json` 設了上述變數或 `apiKeyHelper` 時，拒絕啟動。從伺服器下載的 managed settings 無法檢查，公司管理的電腦請用 `/status` 確認。
- 對話紀錄存在本機，跟計費方式無關，所以換成金鑰後 `--continue`／`--resume` 能接續原本的對話，之後也能換回訂閱繼續。

## 限制（Claude Code 本身的限制）

- **用 API 金鑰時，手機遙控（Remote Control）和 claude.ai 連接器不能用。** 在外面時改開 claude.ai 的 usage credits。
- 不能在對話進行中切換，要先 `/exit` 再用 `use-api --continue` 接續。
- `--continue` 只會接續互動模式開的對話；`claude -p` 開的要用 `--resume <id>`（2026-10-30 實測觀察）。
- Claude Desktop App 的 Code 分頁不讀這個設定，只適用終端機的 `claude`。
- 接續長對話時，第一則訊息要重新寫入整段對話的快取，費用比平常高（實測短對話接續約 US$0.1，Haiku）。

## 開發

在 repo 根目錄執行 `npm run check`（型別檢查＋測試，不打真的 API、不啟動真的 Claude Code）。測試在 `test/cli/use-api/`。
