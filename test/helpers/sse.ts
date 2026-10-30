// 產生 Messages API 串流回應（SSE）的測試資料，單元測試與端對端測試共用。

export interface FakeReply {
  chunks: string[];
  model?: string;
  stopReason?: string;
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

function event(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function sseEvents(reply: FakeReply): string[] {
  const model = reply.model ?? "claude-sonnet-5-5";
  const usage = reply.usage ?? { input_tokens: 1000, output_tokens: 200 };
  const events = [
    event("message_start", {
      type: "message_start",
      message: { id: "msg_test", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1, cache_read_input_tokens: usage.cache_read_input_tokens ?? 0, cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0 } },
    }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ];
  for (const chunk of reply.chunks) {
    events.push(event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } }));
  }
  events.push(
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: reply.stopReason ?? "end_turn", stop_sequence: null },
      usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_read_input_tokens: usage.cache_read_input_tokens ?? 0, cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0 },
    }),
    event("message_stop", { type: "message_stop" }),
  );
  return events;
}

export function sseBody(reply: FakeReply): string {
  return sseEvents(reply).join("");
}
