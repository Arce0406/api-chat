# ai-call

把簡單的工作派給付費 AI API，用 **API 額度**計費，不吃 Claude 訂閱額度。設計給 Claude Code 對話當中控：對話只交出「檔案路徑＋指示」，由這個工具自己讀檔、呼叫 API，對話只收回精簡結果。

第一階段只支援 Claude（Anthropic）。架構預留多家 provider，之後再加 OpenAI、Gemini 等。

## 安裝

需要 Node.js 22.18 以上（直接執行 `.ts`，不需要編譯）。安裝方式見 [repo 首頁的 README](../../README.md#命令列工具)。

金鑰和 `use-api` 共用，用 `use-api setup` 設定，存在 `$XDG_CONFIG_HOME/api-chat/anthropic.env`（預設 `~/.config/api-chat/anthropic.env`，權限 600）。可以用 `API_CHAT_KEY_FILE` 指定別的金鑰檔（桌面 App 從 Finder／開始功能表打開時讀不到終端機設定的環境變數，兩邊會用不同的檔），內容一行（UTF-8）：

```
ANTHROPIC_API_KEY=sk-ant-...
```

建議在 Claude Console 為這把金鑰另開 Workspace、設每月花費上限。**不要把金鑰設成全域環境變數**，否則這台電腦上的 Claude Code 也可能改用 API 計費。

## 用法

```bash
ai-call -f app.log "列出錯誤原因，每項一行"
ai-call -m sonnet -f a.ts -f b.ts --json "這兩個檔案的差異"
git diff | ai-call -f - "用三句話摘要這次改動"
ai-call --dry-run -f big.log "摘要"      # 只看會送出什麼，不花錢
```

| 選項 | 說明 |
|---|---|
| `-m, --model` | `haiku`（預設）、`sonnet`、`opus`、`fable`，或完整模型 ID |
| `-f, --file` | 附上文字檔，可重複；`-` 讀 stdin（不會自動讀 stdin，避免卡住；stdin 是空的會報錯） |
| `-s, --system` | system prompt |
| `--max-tokens` | 回覆長度上限，預設 16000，最多 20000（目前用非串流呼叫） |
| `--effort` | `low`～`max`，Haiku 不支援 |
| `--json` | JSON 輸出（Claude Code 派工作時用這個） |
| `--tag` | 寫進用量紀錄，方便分類 |
| `--dry-run` | 不呼叫 API |

結束碼：`0` 成功、`1` API 錯誤或模型拒答、`2` 參數錯誤、`3` 金鑰問題。失敗時 `--json` 輸出 `{"ok": false, "error": {"kind": "...", "message": "..."}}`，`kind` 例如 `usage`、`credentials`、`auth`、`rate_limit`、`refusal`。

**從 Claude Code 的 Bash 工具呼叫時**：Bash 預設 2 分鐘逾時。Opus／Fable 或很長的輸入可能超過，被切斷時 API 照樣計費但不會留下用量紀錄。這類工作請把 Bash 的 `timeout` 設到 600000，或改用背景執行。

`--json` 的輸出：

```json
{
  "ok": true,
  "text": "…",
  "requestedModel": "claude-haiku-4-5",
  "servedModel": "claude-haiku-4-5",
  "stopReason": "end_turn",
  "truncated": false,
  "fallbackUsed": false,
  "usage": { "inputTokens": 1200, "outputTokens": 80, "cacheReadTokens": 0, "cacheWriteTokens": 0 },
  "costUsd": 0.0016,
  "durationMs": 2100,
  "notes": []
}
```

## 用量紀錄

每次呼叫寫一行到 `~/.local/state/ai-call/usage.jsonl`（`AI_CALL_LOG` 可改路徑）：模型、token、費用、耗時、工作目錄、檔案數、`--tag`。**不記錄送出的內容。**

```bash
# 各模型累計花費
jq -s 'group_by(.servedModel) | map({model: .[0].servedModel, calls: length, usd: (map(.costUsd // 0) | add)})' ~/.local/state/ai-call/usage.jsonl
```

費用依 `src/core/models.ts` 的價格表計算（和 App 共用），是估算值，以 Console 帳單為準。價格變動時更新那裡的數字與 `PRICES_UPDATED_AT`。

## 給 AI agent 的說明放哪

同一件事只寫在一個地方：

| 內容 | 位置 | 誰讀 |
|---|---|---|
| 選項、模型、價格、限制、結束碼 | `ai-call --help`（模型與價格直接從 `src/core/models.ts` 產生） | agent 每次使用前執行 |
| 什麼工作該派出去、怎麼選模型、結果怎麼處理 | [`skill/SKILL.md`](skill/SKILL.md)（Claude Code skill） | Claude Code 在相關任務時自動載入 |
| 安裝、設計、開發 | 這份 README | 人 |

改了選項或限制時，`--help` 和 `SKILL.md` 要一起看。

## 設計

- 只用各家官方 SDK，不用 LiteLLM 這類第三方整合層（資安考量）。版本用 `package-lock.json` 鎖死、`save-exact`、安裝時不執行套件腳本。
- 請求一律打官方 API 網址、明確帶入這把金鑰。建立 client 前會移除所有 `ANTHROPIC_` 開頭的環境變數，所以 `ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_PROFILE`、`ANTHROPIC_CUSTOM_HEADERS`（這個在 SDK 裡能蓋掉認證 header）都換不掉金鑰或網址，`ANTHROPIC_LOG` 也不會把回覆印進輸出。測試涵蓋前五個。
- Sonnet 5.5、Opus 5.5、Fable 5.1 開啟伺服器端拒答備援（`fallbacks: "default"`）：模型因安全分類拒答時，API 依拒答類別改用 Anthropic 建議的模型回答（例如 Sonnet 5.5 的 `cyber`、`frontier_llm` 類改由 Sonnet 5 回答；有些類別不會備援，直接回傳拒答）。備援那段依備援模型的價格計費，輸出會標 `fallbackUsed`。
- 新增 provider：在 `cli/ai-call/providers/` 實作 `Provider` 介面、在 `providers/index.ts` 登記、在 `src/core/models.ts` 加模型與價格、在 `cli/shared/key-file.ts` 加金鑰變數名稱。

## 開發

在 repo 根目錄執行 `npm run check`（型別檢查＋測試，測試不打真的 API）。測試在 `test/cli/ai-call/`。
