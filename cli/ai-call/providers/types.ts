// 各家 AI provider 共用的介面。新增一家時實作 Provider，並在 providers/index.ts 登記。

import type { ProviderName, TokenUsage } from "../../../src/core/models.ts";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface CompletionRequest {
  model: string;
  prompt: string;
  system?: string;
  maxTokens: number;
  effort?: Effort;
  /** 開啟伺服器端拒答備援（由 models.ts 決定哪些模型開） */
  serverFallback: boolean;
}

export type StopReason = "end_turn" | "max_tokens" | "refusal" | "other";

export interface CompletionResult {
  text: string;
  /** 實際回答的模型（拒答備援時可能和要求的不同） */
  servedModel: string;
  stopReason: StopReason;
  /** API 回傳的原始 stop_reason */
  rawStopReason: string | null;
  refusal?: { category: string | null; explanation: string | null };
  fallbackUsed: boolean;
  /** 每一段的用量；有備援時會有多段 */
  usage: TokenUsage[];
}

export type ErrorKind = "auth" | "bad_request" | "rate_limit" | "overloaded" | "server" | "network" | "unknown";

export interface DescribedError {
  kind: ErrorKind;
  message: string;
  status?: number;
}

export interface Provider {
  readonly name: ProviderName;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  /** 把 SDK 丟出的錯誤轉成共用格式 */
  describeError(error: unknown): DescribedError;
}
