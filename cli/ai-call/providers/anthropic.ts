// Anthropic（Claude）provider：用官方 SDK 呼叫 Messages API。

import Anthropic from "@anthropic-ai/sdk";
import type { TokenUsage } from "../../../src/core/models.ts";
import type { CompletionRequest, CompletionResult, DescribedError, Provider, StopReason } from "./types.ts";

// 明確指定，不吃 ANTHROPIC_BASE_URL：確保一定打到官方 API、用這把金鑰計費
const BASE_URL = "https://api.anthropic.com";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AnthropicProviderOptions {
  apiKey: string;
  /** 測試用：替換 HTTP 呼叫 */
  fetch?: typeof globalThis.fetch;
  maxRetries?: number;
}

/**
 * 移除所有 ANTHROPIC_ 開頭的環境變數。SDK 建立 client 時會讀其中幾個：
 * ANTHROPIC_CUSTOM_HEADERS 即使明確傳了 apiKey 也能蓋掉認證 header，
 * ANTHROPIC_LOG 會把回覆內容印到 stdout，OPEN_TELEMETRY 系列可能把內容送到別處。
 * 這個 CLI 自己的設定只用 AI_CALL_ 開頭的變數，所以全部移除不影響功能。
 */
export function scrubAnthropicEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of Object.keys(env)) {
    if (name.startsWith("ANTHROPIC_")) delete env[name];
  }
}

export function createAnthropicProvider(options: AnthropicProviderOptions): Provider {
  scrubAnthropicEnv();
  // 明確傳 apiKey：SDK 就不會去讀 ANTHROPIC_AUTH_TOKEN、ANTHROPIC_PROFILE 或 `ant` 的登入設定
  const client = new Anthropic({
    apiKey: options.apiKey,
    baseURL: BASE_URL,
    maxRetries: options.maxRetries ?? 2,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    name: "anthropic",

    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const response = await client.beta.messages.create({
        model: request.model,
        max_tokens: request.maxTokens,
        ...(request.system ? { system: request.system } : {}),
        ...(request.effort ? { output_config: { effort: request.effort } } : {}),
        ...(request.serverFallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
        messages: [{ role: "user", content: request.prompt }],
      });

      const text = response.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");

      const iterations = response.usage.iterations ?? [];
      const fallbackUsed = iterations.some((entry) => entry.type === "fallback_message");

      // 有分段就逐段計費（備援那段用備援模型的價格），否則用總用量
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
          model: response.model,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        });
      }

      const result: CompletionResult = {
        text,
        servedModel: response.model,
        stopReason: mapStopReason(response.stop_reason),
        rawStopReason: response.stop_reason,
        fallbackUsed,
        usage,
      };
      if (response.stop_reason === "refusal") {
        result.refusal = {
          category: response.stop_details?.category ?? null,
          explanation: response.stop_details?.explanation ?? null,
        };
      }
      return result;
    },

    describeError(error: unknown): DescribedError {
      // 由最具體到最籠統
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        return { kind: "auth", status: error.status, message: "API 金鑰無效或沒有權限，請確認金鑰檔內容" };
      }
      if (error instanceof Anthropic.RateLimitError) {
        return { kind: "rate_limit", status: error.status, message: "超過速率上限，稍後再試" };
      }
      if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError || error instanceof Anthropic.UnprocessableEntityError) {
        return { kind: "bad_request", status: error.status, message: error.message };
      }
      if (error instanceof Anthropic.APIConnectionError) {
        return { kind: "network", message: `連不上 API：${error.message}` };
      }
      if (error instanceof Anthropic.APIError) {
        const status = typeof error.status === "number" ? error.status : undefined;
        if (status === 529) return { kind: "overloaded", status, message: "API 目前過載，稍後再試" };
        if (status !== undefined && status >= 500) return { kind: "server", status, message: error.message };
        return { kind: "unknown", ...(status !== undefined ? { status } : {}), message: error.message };
      }
      return { kind: "unknown", message: error instanceof Error ? error.message : String(error) };
    },
  };
}

function mapStopReason(reason: string | null): StopReason {
  if (reason === "end_turn" || reason === "stop_sequence") return "end_turn";
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "refusal") return "refusal";
  return "other";
}
