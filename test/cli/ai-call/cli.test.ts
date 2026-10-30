import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EXIT, run, type CliDeps } from "../../../cli/ai-call/cli.ts";
import type { CompletionRequest, CompletionResult, Provider } from "../../../cli/ai-call/providers/types.ts";

interface Harness {
  deps: CliDeps;
  out: () => string;
  err: () => string;
  requests: CompletionRequest[];
  logPath: string;
  dir: string;
}

function harness(options: { result?: Partial<CompletionResult>; error?: unknown; withKey?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "ai-call-cli-"));
  if (options.withKey !== false) {
    writeFileSync(join(dir, "anthropic.env"), "ANTHROPIC_API_KEY=sk-test\n");
    chmodSync(join(dir, "anthropic.env"), 0o600);
  }
  const logPath = join(dir, "usage.jsonl");
  let stdout = "";
  let stderr = "";
  let clock = 1_000;
  const requests: CompletionRequest[] = [];
  const provider: Provider = {
    name: "anthropic",
    async complete(request) {
      requests.push(request);
      if (options.error) throw options.error;
      return {
        text: "答案",
        servedModel: request.model,
        stopReason: "end_turn",
        rawStopReason: "end_turn",
        fallbackUsed: false,
        usage: [{ model: request.model, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }],
        ...options.result,
      };
    },
    describeError: () => ({ kind: "rate_limit", status: 429, message: "超過速率上限" }),
  };
  const deps: CliDeps = {
    env: { API_CHAT_KEY_FILE: join(dir, "anthropic.env"), AI_CALL_LOG: logPath },
    cwd: "/work",
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    readStdin: () => "stdin text",
    now: () => (clock += 500),
    createProvider: (_name, apiKey) => {
      assert.equal(apiKey, "sk-test");
      return provider;
    },
  };
  return { deps, out: () => stdout, err: () => stderr, requests, logPath, dir };
}

function logEntries(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("JSON 輸出：結果、用量、費用，並寫一筆不含內容的用量紀錄", async () => {
  const h = harness();
  const file = join(h.dir, "a.log");
  writeFileSync(file, "機密內容");
  const code = await run(["--json", "-f", file, "--tag", "t1", "列出錯誤"], h.deps);

  assert.equal(code, EXIT.ok);
  const out = JSON.parse(h.out());
  assert.equal(out.ok, true);
  assert.equal(out.text, "答案");
  assert.equal(out.requestedModel, "claude-haiku-4-5");
  assert.deepEqual(out.usage, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.ok(Math.abs(out.costUsd - 0.0015) < 1e-12);

  assert.match(h.requests[0]!.prompt, /機密內容[\s\S]*列出錯誤$/);
  assert.equal(h.requests[0]!.serverFallback, false);

  const [entry] = logEntries(h.logPath);
  assert.equal(entry!["ok"], true);
  assert.equal(entry!["tag"], "t1");
  assert.equal(entry!["fileCount"], 1);
  assert.equal(entry!["cwd"], "/work");
  assert.ok(!readFileSync(h.logPath, "utf8").includes("機密內容"), "紀錄不能含送出的內容");
});

test("純文字輸出：stdout 只有答案，用量摘要在 stderr", async () => {
  const h = harness();
  const code = await run(["-m", "opus", "--effort", "high", "問題"], h.deps);
  assert.equal(code, EXIT.ok);
  assert.equal(h.out(), "答案\n");
  assert.match(h.err(), /\[ai-call\] claude-opus-5-5 · 輸入 1000 \/ 輸出 100 tokens · US\$0\.0060/);
  assert.equal(h.requests[0]!.effort, "high");
  assert.equal(h.requests[0]!.serverFallback, true);
});

test("-f - 讀 stdin", async () => {
  const h = harness();
  await run(["-f", "-", "總結"], h.deps);
  assert.match(h.requests[0]!.prompt, /<stdin>\nstdin text\n<\/stdin>/);
});

test("拒答（JSON）：error.kind 為 refusal；備援後仍拒答不顯示「改由…回答」", async () => {
  const h = harness({
    result: { text: "", stopReason: "refusal", rawStopReason: "refusal", fallbackUsed: true, refusal: { category: "bio", explanation: null } },
  });
  const code = await run(["--json", "-m", "sonnet", "問題"], h.deps);
  assert.equal(code, EXIT.failed);
  const out = JSON.parse(h.out());
  assert.equal(out.ok, false);
  assert.equal(out.error.kind, "refusal");
  assert.doesNotMatch(h.err(), /改由/);
});

test("--json 搭配不認得的參數：stdout 仍是 JSON", async () => {
  const h = harness();
  assert.equal(await run(["--json", "--bogus", "問題"], h.deps), EXIT.usage);
  assert.equal(JSON.parse(h.out()).error.kind, "usage");
});

test("-f - 讀到空的 stdin：exit 2、不呼叫 API", async () => {
  const h = harness();
  h.deps.readStdin = () => "";
  assert.equal(await run(["-f", "-", "總結"], h.deps), EXIT.usage);
  assert.equal(h.requests.length, 0);
});

test("拒答：exit 1、紀錄 ok=false、文字模式不輸出答案", async () => {
  const h = harness({ result: { text: "", stopReason: "refusal", rawStopReason: "refusal", refusal: { category: "cyber", explanation: null } } });
  const code = await run(["問題"], h.deps);
  assert.equal(code, EXIT.failed);
  assert.equal(h.out(), "");
  assert.match(h.err(), /拒絕回答（類別：cyber）/);
  assert.equal(logEntries(h.logPath)[0]!["ok"], false);
});

test("被截斷：仍輸出結果，標示 truncated 並提醒", async () => {
  const h = harness({ result: { stopReason: "max_tokens", rawStopReason: "max_tokens" } });
  const code = await run(["--json", "--max-tokens", "50", "問題"], h.deps);
  assert.equal(code, EXIT.ok);
  assert.equal(JSON.parse(h.out()).truncated, true);
  assert.match(h.err(), /被截斷/);
  assert.equal(h.requests[0]!.maxTokens, 50);
});

test("API 錯誤：exit 1、JSON 帶錯誤類型、紀錄 ok=false", async () => {
  const h = harness({ error: new Error("boom") });
  const code = await run(["--json", "問題"], h.deps);
  assert.equal(code, EXIT.failed);
  assert.deepEqual(JSON.parse(h.out()), { ok: false, error: { kind: "rate_limit", message: "超過速率上限" } });
  const [entry] = logEntries(h.logPath);
  assert.equal(entry!["ok"], false);
  assert.match(String(entry!["error"]), /rate_limit 429/);
});

test("沒有金鑰檔：exit 3，說明檔案位置", async () => {
  const h = harness({ withKey: false });
  const code = await run(["問題"], h.deps);
  assert.equal(code, EXIT.credentials);
  assert.match(h.err(), /anthropic\.env/);
  assert.equal(h.requests.length, 0);
});

test("--dry-run 不需要金鑰、不呼叫 API、不寫紀錄", async () => {
  const h = harness({ withKey: false });
  const code = await run(["--dry-run", "--json", "-m", "sonnet", "問題"], h.deps);
  assert.equal(code, EXIT.ok);
  const out = JSON.parse(h.out());
  assert.equal(out.model, "claude-sonnet-5-5");
  assert.equal(out.serverFallback, true);
  assert.equal(h.requests.length, 0);
  assert.equal(existsSync(h.logPath), false);
});

test("參數錯誤：exit 2", async () => {
  const cases = [
    ["-m", "gpt-5", "問題"],
    ["--effort", "low", "問題"], // Haiku 不支援
    ["-m", "opus", "--effort", "huge", "問題"],
    ["--max-tokens", "0", "問題"],
    ["--max-tokens", "abc", "問題"],
    ["--max-tokens", "20001", "問題"],
    [],
    ["--unknown"],
  ];
  for (const argv of cases) {
    const h = harness();
    assert.equal(await run(argv, h.deps), EXIT.usage, argv.join(" "));
    assert.equal(h.requests.length, 0);
  }
});
