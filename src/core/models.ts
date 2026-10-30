// 從 Arce0406/dev-tools 的 ai-call/src/models.ts 複製（2026-10-30）。命令列工具搬進本 repo 後改成共用這一份。

// 模型別名、所屬 provider 與價格。
// 價格是各家官方公布的 API 牌價（美元／每百萬 token），會變動，更新時改這裡並更新 PRICES_UPDATED_AT。

export type ProviderName = "anthropic";

export const PRICES_UPDATED_AT = "2026-10-30";

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** 5 分鐘快取的寫入價（基本輸入價 × 1.25） */
  cacheWrite: number;
}

interface ModelInfo {
  provider: ProviderName;
  price: ModelPrice;
  /** 是否支援 output_config.effort */
  effort: boolean;
  /** 是否開啟伺服器端的拒答備援（fallbacks: "default"） */
  serverFallback: boolean;
}

function anthropicPrice(input: number, output: number, cacheRead: number): ModelPrice {
  return { input, output, cacheRead, cacheWrite: input * 1.25 };
}

// 來源：Anthropic 官方價格表（claude-api skill 2026-09-25 快取）
const MODELS: Record<string, ModelInfo> = {
  "claude-haiku-4-5": { provider: "anthropic", price: anthropicPrice(1, 5, 0.1), effort: false, serverFallback: false },
  "claude-sonnet-5-5": { provider: "anthropic", price: anthropicPrice(2, 10, 0.2), effort: true, serverFallback: true },
  "claude-opus-5-5": { provider: "anthropic", price: anthropicPrice(4, 20, 0.2), effort: true, serverFallback: true },
  "claude-fable-5-1": { provider: "anthropic", price: anthropicPrice(10, 50, 0.25), effort: true, serverFallback: true },
  // 拒答備援可能改由以下模型回答，計費要認得（Sonnet 5.5 → Sonnet 5；Opus／Fable → Opus 5、Opus 4.8）
  "claude-sonnet-5": { provider: "anthropic", price: anthropicPrice(2, 10, 0.2), effort: true, serverFallback: false },
  "claude-opus-5": { provider: "anthropic", price: anthropicPrice(5, 25, 0.5), effort: true, serverFallback: true },
  "claude-opus-4-8": { provider: "anthropic", price: anthropicPrice(5, 25, 0.5), effort: true, serverFallback: false },
};

export const MODEL_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-1",
};

export const DEFAULT_MODEL = "haiku";

export interface ResolvedModel {
  id: string;
  provider: ProviderName;
  effort: boolean;
  serverFallback: boolean;
}

/** 別名或完整 ID 轉成模型資訊；不認得的回傳 null */
export function resolveModel(nameOrAlias: string): ResolvedModel | null {
  const id = MODEL_ALIASES[nameOrAlias] ?? nameOrAlias;
  const info = MODELS[id];
  if (!info) return null;
  return { id, provider: info.provider, effort: info.effort, serverFallback: info.serverFallback };
}

/** 給 --help 用：別名、ID、是否支援 effort、價格，直接由價格表產生，不會和實際行為不一致 */
export function describeModels(): string {
  const aliasOf = Object.fromEntries(Object.entries(MODEL_ALIASES).map(([alias, id]) => [id, alias]));
  return Object.entries(MODELS)
    .filter(([id]) => aliasOf[id])
    .map(([id, info]) => {
      const name = `${aliasOf[id]} (${id})`.padEnd(30);
      const effort = info.effort ? "可用 --effort" : "不支援 --effort";
      return `  ${name} US$${info.price.input}／${info.price.output} 每百萬 token（輸入／輸出），${effort}`;
    })
    .join("\n");
}

export function knownModelNames(): string[] {
  return [...Object.keys(MODEL_ALIASES), ...Object.keys(MODELS)];
}

export interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** API 回傳的模型名稱可能帶日期（claude-haiku-4-5-20251001），查不到就去掉日期再查 */
export function priceOf(model: string): ModelPrice | undefined {
  return (MODELS[model] ?? MODELS[model.replace(/-\d{8}$/, "")])?.price;
}

/** 依各段用量（含備援模型那一段）算美元費用；有任何一段的模型沒有價格就回傳 null */
export function costUsd(parts: TokenUsage[]): number | null {
  let total = 0;
  for (const part of parts) {
    const price = priceOf(part.model);
    if (!price) return null;
    total +=
      (part.inputTokens * price.input +
        part.outputTokens * price.output +
        part.cacheReadTokens * price.cacheRead +
        part.cacheWriteTokens * price.cacheWrite) /
      1_000_000;
  }
  return total;
}
