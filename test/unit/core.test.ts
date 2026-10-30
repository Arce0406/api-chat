import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyFile, decodeText, estimateRequestBytes, LIMITS, toBase64 } from "../../src/core/attachments.ts";
import { modelLabel, supportsEffort } from "../../src/core/catalog.ts";
import { costUsd } from "../../src/core/models.ts";
import {
  dateGroup,
  deriveTitle,
  exportFileName,
  exportMarkdown,
  formatUsd,
  matchesSearch,
  monthSummary,
  toApiMessages,
  totalTokens,
  type Attachment,
  type ChatMessage,
  type Conversation,
  type UsageRecord,
} from "../../src/core/chat.ts";

function msg(role: "user" | "assistant", text: string, attachments?: Attachment[]): ChatMessage {
  return { id: `${role}-${text}`, role, text, createdAt: 0, ...(attachments ? { attachments } : {}) };
}

const image: Attachment = { id: "a1", name: "照片.png", kind: "image", mediaType: "image/png", size: 10, data: "aW1n" };
const pdf: Attachment = { id: "a2", name: "報價.pdf", kind: "pdf", mediaType: "application/pdf", size: 10, data: "cGRm" };
const text: Attachment = { id: "a3", name: "notes.txt", kind: "text", mediaType: "text/plain", size: 10, data: "第一行\n第二行" };

describe("toApiMessages", () => {
  it("圖片、PDF 放在文字前面，文字檔包在 <file> 標籤、使用者的話放最後", () => {
    const [first] = toApiMessages([msg("user", "幫我整理", [text, image, pdf])]);
    assert.ok(first && Array.isArray(first.content));
    const content = first.content as Array<{ type: string; text?: string }>;
    assert.deepEqual(content.map((b) => b.type), ["image", "document", "text"]);
    assert.equal(content[2]?.text, '<file name="notes.txt">\n第一行\n第二行\n</file>\n\n幫我整理');
  });

  it("跳過空的助理回覆，並合併相鄰的使用者訊息，維持一問一答交錯", () => {
    const result = toApiMessages([msg("user", "一"), msg("assistant", ""), msg("user", "二"), msg("assistant", "答"), msg("user", "三")]);
    assert.deepEqual(result.map((m) => m.role), ["user", "assistant", "user"]);
    assert.deepEqual(result[0]?.content, [{ type: "text", text: "一" }, { type: "text", text: "二" }]);
  });

  it("檔名裡的引號會被跳脫，不會跑出標籤", () => {
    const [first] = toApiMessages([msg("user", "看", [{ ...text, name: 'a"b<c.txt' }])]);
    const block = (first?.content as Array<{ text?: string }>)[0];
    assert.match(block?.text ?? "", /^<file name="a&quot;b&lt;c.txt">/);
  });
});

describe("deriveTitle", () => {
  it("取第一行、太長截斷", () => {
    assert.equal(deriveTitle("  會議紀錄整理\n第二行"), "會議紀錄整理");
    assert.equal(deriveTitle("一二三四五六七八九十一二三四五六七八九十一二三四五六"), "一二三四五六七八九十一二三四五六七八九十一二三四…");
  });
  it("只有附檔時用檔名，什麼都沒有時叫新對話", () => {
    assert.equal(deriveTitle("", [pdf]), "報價.pdf");
    assert.equal(deriveTitle("   "), "新對話");
  });
});

describe("exportMarkdown / exportFileName", () => {
  const conversation: Conversation = {
    id: "c", title: "報價/草稿?", model: "claude-sonnet-5-5", effort: "medium", system: "你是編輯", templateId: null, createdAt: 0, updatedAt: 0,
    messages: [msg("user", "改一下", [pdf]), { ...msg("assistant", "好的"), meta: { model: "claude-sonnet-5-5", servedModel: "claude-sonnet-5-5-20260901", usage: [], costUsd: 0 } }],
  };
  it("包含角色設定、附檔名與回答的模型", () => {
    const md = exportMarkdown(conversation, modelLabel);
    assert.match(md, /^# 報價\/草稿\?/);
    assert.match(md, /> 你是編輯/);
    assert.match(md, /附檔：報價\.pdf/);
    assert.match(md, /## Sonnet 5\.5\n\n好的/);
  });
  it("檔名去掉作業系統不允許的字元", () => {
    assert.equal(exportFileName(conversation.title), "報價草稿.md");
    assert.equal(exportFileName("///"), "對話.md");
  });
});

describe("搜尋與日期分組", () => {
  const conversation = { title: "Excel 公式", messages: [msg("user", "VLOOKUP 怎麼用")] } as Conversation;
  it("標題或內容符合就算，不分大小寫", () => {
    assert.ok(matchesSearch(conversation, "excel"));
    assert.ok(matchesSearch(conversation, "vlookup"));
    assert.ok(!matchesSearch(conversation, "報價"));
    assert.ok(matchesSearch(conversation, "  "));
  });
  it("依當地日期分組", () => {
    const now = new Date(2026, 9, 30, 10, 0);
    assert.equal(dateGroup(new Date(2026, 9, 30, 0, 1).getTime(), now), "今天");
    assert.equal(dateGroup(new Date(2026, 9, 29, 23, 59).getTime(), now), "昨天");
    assert.equal(dateGroup(new Date(2026, 9, 24, 0, 0).getTime(), now), "過去 7 天");
    assert.equal(dateGroup(new Date(2026, 9, 23, 23, 59).getTime(), now), "更早");
  });
});

describe("用量", () => {
  it("只算本月，無法計算的另外計數", () => {
    const now = new Date(2026, 9, 30);
    const records: UsageRecord[] = [
      { id: "1", at: new Date(2026, 9, 1, 9).getTime(), conversationId: "c", model: "m", usage: [], costUsd: 0.5 },
      { id: "2", at: new Date(2026, 9, 1, 20).getTime(), conversationId: "c", model: "m", usage: [], costUsd: 0.25 },
      { id: "3", at: new Date(2026, 9, 30).getTime(), conversationId: "c", model: "m", usage: [], costUsd: null },
      { id: "4", at: new Date(2026, 8, 30).getTime(), conversationId: "c", model: "m", usage: [], costUsd: 9 },
      { id: "5", at: new Date(2026, 10, 1).getTime(), conversationId: "c", model: "m", usage: [], costUsd: 9 },
    ];
    const summary = monthSummary(records, now);
    assert.equal(summary.totalUsd, 0.75);
    assert.equal(summary.unknown, 1);
    assert.equal(summary.byDay.get(1), 0.75);
  });
  it("token 數把快取讀寫算進輸入", () => {
    assert.deepEqual(totalTokens([{ model: "m", inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20 }]), { input: 130, output: 5 });
  });
  it("費用格式", () => {
    assert.equal(formatUsd(null), "費用無法計算");
    assert.equal(formatUsd(0.0004), "< US$0.001");
    assert.equal(formatUsd(0.0123), "US$0.012");
    assert.equal(formatUsd(3.456), "US$3.46");
  });
});

describe("附檔判斷", () => {
  it("圖片、PDF、文字檔各自分類", () => {
    assert.deepEqual(classifyFile("a.png", "image/png", 10), { ok: true, kind: "image", mediaType: "image/png" });
    assert.deepEqual(classifyFile("a.PDF", "", 10), { ok: true, kind: "pdf", mediaType: "application/pdf" });
    assert.deepEqual(classifyFile("main.py", "", 10), { ok: true, kind: "text", mediaType: "text/plain" });
  });
  it("不支援的格式與太大的檔案會拒絕，並說明原因", () => {
    const docx = classifyFile("a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 10);
    assert.equal(docx.ok, false);
    const big = classifyFile("a.png", "image/png", LIMITS.image + 1);
    assert.ok(!big.ok && /太大/.test(big.reason));
    assert.equal(classifyFile("a.bmp", "image/bmp", 10).ok, false);
  });
  it("文字檔要是 UTF-8，二進位內容拒絕", () => {
    assert.deepEqual(decodeText("a.txt", new TextEncoder().encode("中文")), { ok: true, text: "中文" });
    assert.equal(decodeText("a.txt", new Uint8Array([0xff, 0xfe, 0x00])).ok, false);
    assert.equal(decodeText("a.txt", new Uint8Array([0x61, 0x00, 0x62])).ok, false);
  });
  it("base64 與 Buffer 結果相同（含超過一個分段的大檔）", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"));
  });
});

describe("模型名稱", () => {
  it("帶日期與備援模型都顯示得出名稱", () => {
    assert.equal(modelLabel("claude-haiku-4-5-20251001"), "Haiku 4.5");
    assert.equal(modelLabel("claude-sonnet-5"), "Sonnet 5");
    assert.equal(modelLabel("claude-opus-4-8"), "Opus 4.8");
    assert.equal(modelLabel("something-else"), "something-else");
  });
  it("Haiku 不支援思考深度", () => {
    assert.equal(supportsEffort("claude-haiku-4-5"), false);
    assert.equal(supportsEffort("claude-sonnet-5-5"), true);
  });
});

describe("審查後補的情境", () => {
  it("拒答的那一問和回覆不會再送出", () => {
    const refused: ChatMessage = { ...msg("assistant", "半段"), meta: { model: "m", usage: [], costUsd: 0, stopReason: "refusal" } };
    const result = toApiMessages([msg("user", "一"), msg("assistant", "答一"), msg("user", "被拒的問題"), refused, msg("user", "換個問法")]);
    assert.deepEqual(result.map((m) => m.role), ["user", "assistant", "user"]);
    assert.deepEqual(result[2]?.content, [{ type: "text", text: "換個問法" }]);
  });

  it("請求大小：圖片與 PDF 以 base64 長度計，文字以 UTF-8 位元組計", () => {
    const bytes = estimateRequestBytes([msg("user", "中文", [image, pdf, text])]);
    // "中文"=6、image "aW1n"=4、pdf "cGRm"=4、"第一行\n第二行"=19
    assert.equal(bytes, 6 + 4 + 4 + 19);
  });

  it("拒答備援時逐段用各自模型的價格計費", () => {
    // Sonnet 5.5 段：1000×2 + 50×10；備援 Sonnet 5 段：1200×2 + 300×10（每百萬 token）
    const cost = costUsd([
      { model: "claude-sonnet-5-5", inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { model: "claude-sonnet-5-20260101", inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
    assert.ok(cost !== null && Math.abs(cost - (2500 + 5400) / 1e6) < 1e-12);
    assert.equal(costUsd([{ model: "claude-unknown-9", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }]), null);
  });
});
