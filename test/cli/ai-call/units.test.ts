import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CredentialError, loadApiKey, parseEnvFile } from "../../../cli/ai-call/credentials.ts";
import { buildPrompt, InputError, readDocuments } from "../../../cli/ai-call/input.ts";
import { costUsd, resolveModel } from "../../../src/core/models.ts";

test("模型別名與完整 ID 都認得，未知回傳 null", () => {
  assert.equal(resolveModel("haiku")?.id, "claude-haiku-4-5");
  assert.equal(resolveModel("claude-opus-5-5")?.serverFallback, true);
  assert.equal(resolveModel("haiku")?.effort, false);
  assert.equal(resolveModel("gpt-5"), null);
});

test("費用：依各段模型價格加總；未知模型回傳 null", () => {
  const cost = costUsd([
    { model: "claude-haiku-4-5", inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
  ]);
  // 1 + 0.5 + 0.1 + 1.25
  assert.ok(Math.abs(cost! - 2.85) < 1e-9, String(cost));
  // API 回傳的名稱可能帶日期（2026-10-30 實測 Haiku 回 claude-haiku-4-5-20251001）
  const dated = costUsd([{ model: "claude-haiku-4-5-20251001", inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }]);
  assert.equal(dated, 1);
  assert.equal(costUsd([{ model: "unknown", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }]), null);
});

test("parseEnvFile：註解、export、引號", () => {
  const parsed = parseEnvFile('# 註解\n\nexport A=1\nB="two words"\nC=\'x\'\n  D = spaced  \nbad line\n');
  assert.deepEqual(parsed, { A: "1", B: "two words", C: "x", D: "spaced" });
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ai-call-test-"));
}

test("loadApiKey：沒檔案、沒變數會說明怎麼補；權限太寬會提醒", () => {
  const dir = tempDir();
  const env = { API_CHAT_KEY_FILE: join(dir, "anthropic.env") };
  assert.throws(() => loadApiKey("anthropic", env), (e: unknown) => e instanceof CredentialError && /anthropic\.env/.test(e.message));

  const file = join(dir, "anthropic.env");
  writeFileSync(file, "OTHER=1\n");
  chmodSync(file, 0o600);
  assert.throws(() => loadApiKey("anthropic", env), (e: unknown) => e instanceof CredentialError && /ANTHROPIC_API_KEY/.test(e.message));

  writeFileSync(file, "ANTHROPIC_API_KEY=sk-x\n");
  assert.deepEqual(loadApiKey("anthropic", env), { apiKey: "sk-x" });

  chmodSync(file, 0o644);
  assert.match(loadApiKey("anthropic", env).warning ?? "", /chmod 600/);
});

test("readDocuments／buildPrompt：檔案在前、指示在後；stdin 用 -；二進位檔拒絕", () => {
  const dir = tempDir();
  const text = join(dir, "a.log");
  writeFileSync(text, "line1");
  const docs = readDocuments([text, "-"], () => "from stdin");
  assert.equal(
    buildPrompt(docs, "總結"),
    `<file path="${text}">\nline1\n</file>\n\n<stdin>\nfrom stdin\n</stdin>\n\n總結`,
  );

  const binary = join(dir, "b.bin");
  writeFileSync(binary, Buffer.from([0x41, 0x00, 0x42]));
  assert.throws(() => readDocuments([binary], () => ""), InputError);
  assert.throws(() => readDocuments([join(dir, "missing")], () => ""), InputError);
});
