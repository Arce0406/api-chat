// 介面上可選的模型與思考深度。價格與能力以 models.ts 為準。

import type { Effort } from "./chat.ts";
import { resolveModel } from "./models.ts";

export interface ModelChoice {
  id: string;
  label: string;
  hint: string;
}

export const MODEL_CHOICES: ModelChoice[] = [
  { id: "claude-haiku-4-5", label: "Haiku 4.5", hint: "最便宜、最快，適合簡單問題" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", hint: "一般工作的預設" },
  { id: "claude-opus-5-5", label: "Opus 5.5", hint: "較難的問題" },
  { id: "claude-fable-5-1", label: "Fable 5.1", hint: "最強、最貴" },
];

export const DEFAULT_MODEL_ID = "claude-sonnet-5-5";

export const EFFORT_CHOICES: Array<{ id: Effort; label: string }> = [
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
  { id: "xhigh", label: "很高" },
  { id: "max", label: "最高" },
];

export const DEFAULT_EFFORT: Effort = "medium";

/** API 回傳的模型 ID 可能帶日期，也可能是備援模型 */
export function modelLabel(id: string): string {
  const base = id.replace(/-\d{8}$/, "");
  const known = MODEL_CHOICES.find((m) => m.id === base);
  if (known) return known.label;
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(base);
  if (!match) return id;
  const [, family = "", major, minor] = match;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${minor ? `${major}.${minor}` : major}`;
}

export function supportsEffort(modelId: string): boolean {
  return resolveModel(modelId)?.effort ?? false;
}
