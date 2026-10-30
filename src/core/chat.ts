// 對話的資料結構，以及和畫面、API 無關的純函式（可在 Node 直接測試）。

import type { TokenUsage } from "./models.ts";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type AttachmentKind = "image" | "pdf" | "text";

export interface Attachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  mediaType: string;
  size: number;
  /** image／pdf：base64；text：原文 */
  data: string;
}

export interface ReplyMeta {
  /** 要求的模型 */
  model: string;
  /** 實際回答的模型（拒答備援時可能不同） */
  servedModel?: string;
  usage: TokenUsage[];
  /** null：有模型沒有價格，或中途停止而拿不到用量 */
  costUsd: number | null;
  stopReason?: string | null;
  /** 使用者按了停止 */
  stopped?: boolean;
  /** 回覆到一半斷線或出錯，只收到部分內容 */
  interrupted?: boolean;
  fallbackUsed?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachments?: Attachment[];
  createdAt: number;
  meta?: ReplyMeta;
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  effort: Effort;
  /** 角色（system prompt）。選範本時複製一份進來，之後改範本不影響舊對話 */
  system: string;
  templateId: string | null;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface RoleTemplate {
  id: string;
  name: string;
  prompt: string;
}

export interface UsageRecord {
  id: string;
  at: number;
  conversationId: string;
  model: string;
  usage: TokenUsage[];
  costUsd: number | null;
}

export function newId(): string {
  return crypto.randomUUID();
}

const TITLE_MAX = 24;

/** 用第一則訊息當標題，不另外呼叫 API（省錢） */
export function deriveTitle(text: string, attachments: Attachment[] = []): string {
  const firstLine = text.trim().split(/\r?\n/)[0]?.trim() ?? "";
  const base = firstLine || attachments[0]?.name || "新對話";
  const chars = [...base];
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join("")}…` : base;
}

/** 附檔放在 <file> 標籤裡、使用者的話放最後（和 ai-call 相同的組法） */
export function userTextWithFiles(text: string, attachments: Attachment[] = []): string {
  const files = attachments
    .filter((a) => a.kind === "text")
    .map((a) => `<file name="${escapeAttr(a.name)}">\n${a.data}\n</file>`);
  if (files.length === 0) return text;
  return `${files.join("\n\n")}\n\n${text}`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export type ApiContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string }; title?: string };

export interface ApiMessage {
  role: "user" | "assistant";
  content: string | ApiContentBlock[];
}

/**
 * 把對話紀錄轉成 Messages API 的 messages。
 * - 圖片、PDF 放在文字前面（官方建議的順序）。
 * - 空的助理回覆（例如還沒開始就停止）不送，並把前後的使用者訊息合併，維持一問一答交錯。
 */
export function toApiMessages(messages: ChatMessage[]): ApiMessage[] {
  const result: ApiMessage[] = [];
  for (const message of withoutRefusals(messages)) {
    if (message.role === "assistant") {
      if (!message.text.trim()) continue;
      result.push({ role: "assistant", content: message.text });
      continue;
    }
    const blocks: ApiContentBlock[] = [];
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind === "image") {
        blocks.push({ type: "image", source: { type: "base64", media_type: attachment.mediaType, data: attachment.data } });
      } else if (attachment.kind === "pdf") {
        blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: attachment.data }, title: attachment.name });
      }
    }
    const text = userTextWithFiles(message.text, message.attachments);
    if (text.trim()) blocks.push({ type: "text", text });
    const last = result[result.length - 1];
    if (last && last.role === "user") {
      last.content = [...asBlocks(last.content), ...blocks];
    } else {
      result.push({ role: "user", content: blocks });
    }
  }
  return result;
}

/** 拒答的那一問和回覆不再送出（官方建議丟掉拒答時的部分輸出；留著那一問也可能讓之後每輪都被拒） */
function withoutRefusals(messages: ChatMessage[]): ChatMessage[] {
  const kept: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.meta?.stopReason === "refusal") {
      if (kept[kept.length - 1]?.role === "user") kept.pop();
      continue;
    }
    kept.push(message);
  }
  return kept;
}

function asBlocks(content: string | ApiContentBlock[]): ApiContentBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

export function totalTokens(usage: TokenUsage[]): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const part of usage) {
    input += part.inputTokens + part.cacheReadTokens + part.cacheWriteTokens;
    output += part.outputTokens;
  }
  return { input, output };
}

export function exportMarkdown(conversation: Conversation, labelOf: (model: string) => string = (m) => m): string {
  const lines: string[] = [`# ${conversation.title}`, ""];
  if (conversation.system.trim()) {
    lines.push("> 角色設定：", ...conversation.system.trim().split("\n").map((l) => `> ${l}`), "");
  }
  for (const message of conversation.messages) {
    if (message.role === "user") {
      lines.push("## 你", "");
      const names = (message.attachments ?? []).map((a) => a.name);
      if (names.length) lines.push(`附檔：${names.join("、")}`, "");
    } else {
      const model = message.meta ? labelOf(message.meta.servedModel ?? message.meta.model) : "Claude";
      lines.push(`## ${model}`, "");
    }
    lines.push(message.text, "");
  }
  return lines.join("\n");
}

/** 匯出檔名：去掉 Windows／macOS 不允許的字元 */
export function exportFileName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\x00-\x1f]/g, "").trim().slice(0, 60);
  return `${cleaned || "對話"}.md`;
}

export function matchesSearch(conversation: Conversation, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (conversation.title.toLowerCase().includes(q)) return true;
  return conversation.messages.some((m) => m.text.toLowerCase().includes(q));
}

export type DateGroup = "今天" | "昨天" | "過去 7 天" | "更早";

export function dateGroup(timestamp: number, now: Date = new Date()): DateGroup {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  if (timestamp >= startOfToday) return "今天";
  if (timestamp >= startOfToday - day) return "昨天";
  if (timestamp >= startOfToday - 6 * day) return "過去 7 天";
  return "更早";
}

export function groupConversations(conversations: Conversation[], now: Date = new Date()): Array<{ group: DateGroup; items: Conversation[] }> {
  const order: DateGroup[] = ["今天", "昨天", "過去 7 天", "更早"];
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  return order
    .map((group) => ({ group, items: sorted.filter((c) => dateGroup(c.updatedAt, now) === group) }))
    .filter((entry) => entry.items.length > 0);
}

/** 本月（當地時間）的花費。costUsd 為 null 的紀錄另外計數，畫面上註明「有 N 筆無法計算」 */
export function monthSummary(records: UsageRecord[], now: Date = new Date()): { totalUsd: number; unknown: number; byDay: Map<number, number> } {
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  let totalUsd = 0;
  let unknown = 0;
  const byDay = new Map<number, number>();
  for (const record of records) {
    if (record.at < start || record.at >= end) continue;
    if (record.costUsd === null) {
      unknown += 1;
      continue;
    }
    totalUsd += record.costUsd;
    const day = new Date(record.at).getDate();
    byDay.set(day, (byDay.get(day) ?? 0) + record.costUsd);
  }
  return { totalUsd, unknown, byDay };
}

export function formatUsd(value: number | null): string {
  if (value === null) return "費用無法計算";
  if (value > 0 && value < 0.001) return "< US$0.001";
  return `US$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;
}
