// 呼叫 Claude（官方 @anthropic-ai/sdk）。金鑰是使用者自己電腦上的自己的金鑰，直接從 App 呼叫官方 API。

import Anthropic from "@anthropic-ai/sdk";
import type { ApiMessage, Effort } from "../core/chat.ts";
import { resolveModel, type TokenUsage } from "../core/models.ts";

// 寫死官方網址：一定打到 Anthropic、用這把金鑰計費
export const API_BASE_URL = "https://api.anthropic.com";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_TOKENS = 32000;

export interface ReplyRequest {
  apiKey: string;
  model: string;
  effort: Effort;
  system: string;
  messages: ApiMessage[];
  signal: AbortSignal;
  onText: (delta: string) => void;
  /** 測試用 */
  fetch?: typeof globalThis.fetch;
}

export interface ReplyResult {
  text: string;
  servedModel: string;
  stopReason: string | null;
  fallbackUsed: boolean;
  usage: TokenUsage[];
  refusal?: { category: string | null; explanation: string | null };
}

function client(apiKey: string, fetchImpl?: typeof globalThis.fetch): Anthropic {
  return new Anthropic({
    apiKey,
    baseURL: API_BASE_URL,
    // 在 App 的網頁畫面裡呼叫；金鑰屬於使用這台電腦的人，不是分享出去的金鑰
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

export async function streamReply(request: ReplyRequest): Promise<ReplyResult> {
  const info = resolveModel(request.model);
  const stream = client(request.apiKey, request.fetch).beta.messages.stream(
    {
      model: request.model,
      max_tokens: MAX_TOKENS,
      // 多輪對話自動快取前面的內容，接續時較便宜
      cache_control: { type: "ephemeral" },
      ...(request.system.trim() ? { system: request.system } : {}),
      ...(info?.effort ? { thinking: { type: "adaptive" as const }, output_config: { effort: request.effort } } : {}),
      ...(info?.serverFallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      messages: request.messages as Anthropic.Beta.Messages.BetaMessageParam[],
    },
    { signal: request.signal },
  );
  stream.on("text", (delta) => request.onText(delta));
  const message = await stream.finalMessage();

  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  const iterations = message.usage.iterations ?? [];
  const usage: TokenUsage[] = [];
  for (const entry of iterations) {
    if (entry.type !== "message" && entry.type !== "fallback_message") continue;
    usage.push({
      model: entry.model ?? request.model,
      inputTokens: entry.input_tokens,
      outputTokens: entry.output_tokens,
      cacheReadTokens: entry.cache_read_input_tokens ?? 0,
      cacheWriteTokens: entry.cache_creation_input_tokens ?? 0,
    });
  }
  if (usage.length === 0) {
    usage.push({
      model: message.model,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    });
  }
  const result: ReplyResult = {
    text,
    servedModel: message.model,
    stopReason: message.stop_reason,
    fallbackUsed: iterations.some((entry) => entry.type === "fallback_message"),
    usage,
  };
  if (message.stop_reason === "refusal") {
    result.refusal = {
      category: message.stop_details?.category ?? null,
      explanation: message.stop_details?.explanation ?? null,
    };
  }
  return result;
}

export function isAbort(error: unknown): boolean {
  return error instanceof Anthropic.APIUserAbortError || (error instanceof DOMException && error.name === "AbortError");
}

/** 把錯誤轉成給使用者看的一句話 */
export function describeError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return "API 金鑰無效或已被刪除。請到「設定 > API 金鑰」更換。";
  if (error instanceof Anthropic.PermissionDeniedError) return "這把金鑰沒有權限使用這個模型。";
  if (error instanceof Anthropic.RateLimitError) return "超過速率上限，請稍後再試。";
  if (error instanceof Anthropic.APIConnectionError) return "連不上 Anthropic，請確認網路。";
  if (error instanceof Anthropic.APIError && error.status === 413) {
    return "這次要送的內容太大（通常是附檔太多）。請開新對話，或減少附檔。";
  }
  if (error instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(error.message)) return "API 額度不足。請到 Claude Console 的 Billing 儲值。";
    if (/prompt is too long|too many tokens|context window/i.test(error.message)) {
      return "這段對話太長，超過模型一次能讀的長度。請開新對話（可以先從「⋯」匯出保存）。";
    }
    return `請求被拒絕：${error.message}`;
  }
  if (error instanceof Anthropic.APIError) {
    if (error.status === 529) return "Anthropic 目前過載，請稍後再試。";
    return `Anthropic 回傳錯誤（${error.status ?? "未知"}）：${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export type KeyCheck = { ok: true } | { ok: false; reason: string };

/** 用列出模型的 API 確認金鑰有效（不花錢） */
export async function verifyKey(apiKey: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)): Promise<KeyCheck> {
  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE_URL}/v1/models?limit=1`, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
  } catch {
    return { ok: false, reason: "連不上 Anthropic，請確認網路後再試。" };
  }
  if (response.ok) return { ok: true };
  if (response.status === 401) return { ok: false, reason: "金鑰無效。請確認複製完整，或到 Console 重新建立一把。" };
  if (response.status === 403) return { ok: false, reason: "這把金鑰沒有權限。" };
  return { ok: false, reason: `暫時無法驗證（Anthropic 回傳 ${response.status}），請稍後再試。` };
}

/** 金鑰格式的基本檢查：只允許可見的 ASCII 字元（避免貼到換行或全形字） */
export function normalizeKey(raw: string): { ok: true; key: string } | { ok: false; reason: string } {
  const key = raw.trim();
  if (!key) return { ok: false, reason: "請貼上金鑰。" };
  if (!/^[\x21-\x7e]+$/.test(key)) return { ok: false, reason: "金鑰裡有空白或特殊字元，請重新複製。" };
  return { ok: true, key };
}
