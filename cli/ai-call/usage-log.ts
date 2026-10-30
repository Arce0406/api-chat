// 每次呼叫的用量與費用寫進 JSONL，用來比較派出去省了多少。不記錄送出的內容。

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface UsageLogEntry {
  ts: string;
  provider: string;
  requestedModel: string;
  servedModel: string | null;
  ok: boolean;
  stopReason: string | null;
  fallbackUsed: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  durationMs: number;
  cwd: string;
  fileCount: number;
  promptChars: number;
  tag: string | null;
  error: string | null;
}

export function usageLogPath(env: NodeJS.ProcessEnv): string {
  if (env["AI_CALL_LOG"]) return env["AI_CALL_LOG"];
  const stateHome = env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
  return join(stateHome, "ai-call", "usage.jsonl");
}

export function appendUsageLog(path: string, entry: UsageLogEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n");
}
