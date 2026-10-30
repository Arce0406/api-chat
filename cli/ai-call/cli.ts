// ai-call：把簡單工作派給付費 AI API（第一階段只有 Claude）。用法見 README.md 或 --help。

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CredentialError, loadApiKey } from "./credentials.ts";
import { buildPrompt, InputError, readDocuments } from "./input.ts";
import { costUsd, DEFAULT_MODEL, describeModels, knownModelNames, PRICES_UPDATED_AT, resolveModel, type ProviderName } from "../../src/core/models.ts";
import { createProvider } from "./providers/index.ts";
import type { CompletionResult, Effort, Provider } from "./providers/types.ts";
import { appendUsageLog, usageLogPath } from "./usage-log.ts";

export const EXIT = { ok: 0, failed: 1, usage: 2, credentials: 3 } as const;

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const DEFAULT_MAX_TOKENS = 16000;
// 目前用非串流呼叫，SDK 會擋下預估超過 10 分鐘的請求（約 21000 tokens 以上）
const MAX_MAX_TOKENS = 20000;

const HELP = `用法：ai-call [選項] "<指示>"

把文字（檔案、stdin）連同指示送給付費 AI API，用 API 額度計費。

選項：
  -m, --model <名稱>      haiku（預設）、sonnet、opus、fable，或完整模型 ID
  -f, --file <路徑>       要附上的文字檔，可重複；"-" 表示讀 stdin
  -s, --system <文字>     system prompt
      --max-tokens <數字> 回覆長度上限（預設 ${DEFAULT_MAX_TOKENS}，最多 ${MAX_MAX_TOKENS}）
      --effort <等級>     low | medium | high | xhigh | max（Haiku 不支援）
      --json              以 JSON 輸出結果與用量（給程式或 Claude Code 讀）
      --tag <文字>        寫進用量紀錄，方便分類統計
      --dry-run           只顯示會送出什麼，不呼叫 API
  -h, --help              顯示說明

模型（價格 ${PRICES_UPDATED_AT} 更新）：
${describeModels()}

限制：
  - 只收文字檔（圖片、PDF、其他二進位檔會被拒絕）
  - 只回傳文字，不能產生圖片、語音、影片；SVG、HTML、mermaid、CSV 這類文字格式可以
  - 一次一問一答，不會讀檔、跑指令或上網；需要的內容都要用 -f 附上
  - --max-tokens 最多 ${MAX_MAX_TOKENS}
  - 從 Claude Code 的 Bash 工具呼叫時，Opus／Fable 或長輸入可能超過預設 2 分鐘逾時，請把 timeout 設到 600000

結束碼：0 成功、1 API 錯誤或模型拒答、2 參數錯誤、3 金鑰問題
金鑰：${"$"}XDG_CONFIG_HOME/api-chat/<provider>.env（預設 ~/.config/api-chat/<provider>.env），和 use-api 共用；用 use-api setup 設定（可用 API_CHAT_KEY_FILE 指定 Anthropic 金鑰檔）
用量紀錄：~/.local/state/ai-call/usage.jsonl（可用 AI_CALL_LOG 改路徑）`;

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => string;
  now: () => number;
  createProvider: (name: ProviderName, apiKey: string) => Provider;
}

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        model: { type: "string", short: "m", default: DEFAULT_MODEL },
        file: { type: "string", short: "f", multiple: true, default: [] },
        system: { type: "string", short: "s" },
        "max-tokens": { type: "string" },
        effort: { type: "string" },
        json: { type: "boolean", default: false },
        tag: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    if (argv.includes("--json")) {
      deps.stdout(JSON.stringify({ ok: false, error: { kind: "usage", message: (error as Error).message } }, null, 2) + "\n");
    }
    deps.stderr(`ai-call：${(error as Error).message}\n${HELP}\n`);
    return EXIT.usage;
  }
  const { values, positionals } = parsed;
  const asJson = values.json;

  const fail = (code: number, kind: string, message: string): number => {
    if (asJson) deps.stdout(JSON.stringify({ ok: false, error: { kind, message } }, null, 2) + "\n");
    deps.stderr(`ai-call：${message}\n`);
    return code;
  };

  if (values.help) {
    deps.stdout(HELP + "\n");
    return EXIT.ok;
  }

  const model = resolveModel(values.model);
  if (!model) {
    return fail(EXIT.usage, "usage", `不認得的模型「${values.model}」。可用：${knownModelNames().join("、")}`);
  }

  let maxTokens = DEFAULT_MAX_TOKENS;
  if (values["max-tokens"] !== undefined) {
    maxTokens = Number(values["max-tokens"]);
    if (!Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > MAX_MAX_TOKENS) {
      return fail(EXIT.usage, "usage", `--max-tokens 要是 1～${MAX_MAX_TOKENS} 的整數，收到「${values["max-tokens"]}」`);
    }
  }

  let effort: Effort | undefined;
  if (values.effort !== undefined) {
    if (!EFFORTS.includes(values.effort as Effort)) {
      return fail(EXIT.usage, "usage", `--effort 只能是 ${EFFORTS.join("、")}`);
    }
    if (!model.effort) {
      return fail(EXIT.usage, "usage", `${model.id} 不支援 --effort`);
    }
    effort = values.effort as Effort;
  }

  const instruction = positionals.join(" ").trim();
  if (!instruction && values.file.length === 0) {
    return fail(EXIT.usage, "usage", `沒有指示也沒有檔案\n${HELP}`);
  }

  let prompt: string;
  try {
    prompt = buildPrompt(readDocuments(values.file, deps.readStdin), instruction);
  } catch (error) {
    if (error instanceof InputError) return fail(EXIT.usage, "input", error.message);
    throw error;
  }

  if (values["dry-run"]) {
    const preview = {
      dryRun: true,
      provider: model.provider,
      model: model.id,
      maxTokens,
      effort: effort ?? null,
      serverFallback: model.serverFallback,
      files: values.file,
      promptChars: prompt.length,
      system: values.system ?? null,
    };
    deps.stdout((asJson ? JSON.stringify(preview, null, 2) : formatPreview(preview, prompt)) + "\n");
    return EXIT.ok;
  }

  let apiKey: string;
  try {
    const loaded = loadApiKey(model.provider, deps.env);
    if (loaded.warning) deps.stderr(`ai-call：${loaded.warning}\n`);
    apiKey = loaded.apiKey;
  } catch (error) {
    if (error instanceof CredentialError) return fail(EXIT.credentials, "credentials", error.message);
    throw error;
  }

  const provider = deps.createProvider(model.provider, apiKey);
  const logPath = usageLogPath(deps.env);
  const started = deps.now();
  const baseLog = {
    provider: model.provider,
    requestedModel: model.id,
    cwd: deps.cwd,
    fileCount: values.file.length,
    promptChars: prompt.length,
    tag: values.tag ?? null,
  };

  let result: CompletionResult;
  try {
    result = await provider.complete({
      model: model.id,
      prompt,
      maxTokens,
      serverFallback: model.serverFallback,
      ...(values.system ? { system: values.system } : {}),
      ...(effort ? { effort } : {}),
    });
  } catch (error) {
    const described = provider.describeError(error);
    writeLog(deps, logPath, {
      ...baseLog,
      ts: new Date(started).toISOString(),
      servedModel: null,
      ok: false,
      stopReason: null,
      fallbackUsed: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
      durationMs: deps.now() - started,
      error: `${described.kind}${described.status ? ` ${described.status}` : ""}: ${described.message}`,
    });
    return fail(EXIT.failed, described.kind, described.message);
  }

  const durationMs = deps.now() - started;
  const totals = sumUsage(result);
  const cost = costUsd(result.usage);
  const refused = result.stopReason === "refusal";

  writeLog(deps, logPath, {
    ...baseLog,
    ts: new Date(started).toISOString(),
    servedModel: result.servedModel,
    ok: !refused,
    stopReason: result.rawStopReason,
    fallbackUsed: result.fallbackUsed,
    ...totals,
    costUsd: cost,
    durationMs,
    error: refused ? "refusal" : null,
  });

  const notes: string[] = [];
  if (result.stopReason === "max_tokens") {
    notes.push(
      maxTokens < MAX_MAX_TOKENS
        ? `回覆被截斷（達到 max_tokens ${maxTokens}），可加大 --max-tokens（最多 ${MAX_MAX_TOKENS}）`
        : `回覆被截斷（已達上限 ${MAX_MAX_TOKENS}），請把工作拆小`,
    );
  }
  if (result.fallbackUsed && !refused) notes.push(`${model.id} 拒答，改由 ${result.servedModel} 回答`);
  if (cost === null) notes.push("有模型不在價格表，費用未計算（更新 src/models.ts）");

  if (asJson) {
    deps.stdout(
      JSON.stringify(
        {
          ok: !refused,
          text: result.text,
          requestedModel: model.id,
          servedModel: result.servedModel,
          stopReason: result.rawStopReason,
          truncated: result.stopReason === "max_tokens",
          fallbackUsed: result.fallbackUsed,
          ...(refused ? { error: { kind: "refusal", message: refusalMessage(result) }, refusal: result.refusal ?? null } : {}),
          usage: totals,
          costUsd: cost,
          durationMs,
          notes,
        },
        null,
        2,
      ) + "\n",
    );
  } else if (!refused) {
    deps.stdout(result.text.endsWith("\n") ? result.text : result.text + "\n");
  }

  for (const note of notes) deps.stderr(`ai-call：${note}\n`);
  if (refused) deps.stderr(`ai-call：${refusalMessage(result)}\n`);
  deps.stderr(
    `[ai-call] ${result.servedModel} · 輸入 ${totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens} / 輸出 ${totals.outputTokens} tokens · ${cost === null ? "費用未知" : `US$${cost.toFixed(4)}`} · ${(durationMs / 1000).toFixed(1)}s\n`,
  );
  return refused ? EXIT.failed : EXIT.ok;
}

function refusalMessage(result: CompletionResult): string {
  const category = result.refusal?.category ? `（類別：${result.refusal.category}）` : "";
  return `模型拒絕回答${category}`;
}

function sumUsage(result: CompletionResult) {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const part of result.usage) {
    totals.inputTokens += part.inputTokens;
    totals.outputTokens += part.outputTokens;
    totals.cacheReadTokens += part.cacheReadTokens;
    totals.cacheWriteTokens += part.cacheWriteTokens;
  }
  return totals;
}

function writeLog(deps: CliDeps, path: string, entry: Parameters<typeof appendUsageLog>[1]): void {
  try {
    appendUsageLog(path, entry);
  } catch (error) {
    deps.stderr(`ai-call：用量紀錄寫入失敗（${(error as Error).message}），結果不受影響\n`);
  }
}

function formatPreview(preview: { model: string; maxTokens: number; files: string[]; promptChars: number }, prompt: string): string {
  const head = prompt.length > 500 ? prompt.slice(0, 500) + "…" : prompt;
  return [
    `模型：${preview.model}（max_tokens ${preview.maxTokens}）`,
    `檔案：${preview.files.length ? preview.files.join("、") : "無"}`,
    `內容長度：${preview.promptChars} 字元`,
    "--- 開頭 ---",
    head,
  ].join("\n");
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const code = await run(argv, {
    env: process.env,
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readStdin: () => readFileSync(0, "utf8"),
    now: () => Date.now(),
    createProvider,
  }).catch((error: unknown) => {
    // 非預期錯誤也維持輸出格式，讓呼叫端好判讀
    const message = error instanceof Error ? error.message : String(error);
    if (argv.includes("--json")) {
      process.stdout.write(JSON.stringify({ ok: false, error: { kind: "internal", message } }, null, 2) + "\n");
    }
    process.stderr.write(`ai-call：非預期錯誤：${message}\n`);
    return EXIT.failed;
  });
  process.exitCode = code;
}
