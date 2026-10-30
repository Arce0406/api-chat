import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeError, isAbort, normalizeKey, streamReply, verifyKey } from "../../src/api/claude.ts";
import { sseBody, sseEvents, type FakeReply } from "../helpers/sse.ts";

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function fakeFetch(reply: FakeReply | { status: number; error: { type: string; message: string } }, captured: Captured[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    captured.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) });
    if ("status" in reply) {
      return new Response(JSON.stringify({ type: "error", error: reply.error }), { status: reply.status, headers: { "content-type": "application/json" } });
    }
    return new Response(sseBody(reply), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

const base = { apiKey: "sk-ant-test", system: "", effort: "high" as const, messages: [{ role: "user" as const, content: "嗨" }] };

describe("streamReply", () => {
  it("逐段回傳文字，並依用量回報模型與 token", async () => {
    const captured: Captured[] = [];
    const deltas: string[] = [];
    const result = await streamReply({
      ...base,
      model: "claude-sonnet-5-5",
      signal: new AbortController().signal,
      onText: (d) => deltas.push(d),
      fetch: fakeFetch({ chunks: ["你", "好"], model: "claude-sonnet-5-5", usage: { input_tokens: 1200, output_tokens: 30, cache_read_input_tokens: 800 } }, captured),
    });
    assert.deepEqual(deltas, ["你", "好"]);
    assert.equal(result.text, "你好");
    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(result.usage, [{ model: "claude-sonnet-5-5", inputTokens: 1200, outputTokens: 30, cacheReadTokens: 800, cacheWriteTokens: 0 }]);

    const request = captured[0]!;
    assert.equal(new URL(request.url).origin, "https://api.anthropic.com");
    // SDK 1.x 把 apiKey 放在 Authorization: Bearer
    assert.equal(request.headers.get("authorization"), "Bearer sk-ant-test");
    assert.deepEqual(request.body.cache_control, { type: "ephemeral" });
    assert.deepEqual(request.body.thinking, { type: "adaptive" });
    assert.deepEqual(request.body.output_config, { effort: "high" });
    assert.equal(request.body.fallbacks, "default");
    assert.match(request.headers.get("anthropic-beta") ?? "", /server-side-fallback/);
    assert.equal("system" in request.body, false);
  });

  it("Haiku 不送思考深度與備援；有角色設定時送 system", async () => {
    const captured: Captured[] = [];
    await streamReply({ ...base, system: "你是編輯", model: "claude-haiku-4-5", signal: new AbortController().signal, onText: () => {}, fetch: fakeFetch({ chunks: ["ok"] }, captured) });
    const body = captured[0]!.body;
    assert.equal("thinking" in body, false);
    assert.equal("output_config" in body, false);
    assert.equal("fallbacks" in body, false);
    assert.equal(body.system, "你是編輯");
  });

  it("按停止會丟出可辨識的中止錯誤", async () => {
    const controller = new AbortController();
    const slowFetch = (async (_input: unknown, init?: RequestInit) => {
      const events = sseEvents({ chunks: ["一", "二"] });
      const stream = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(new TextEncoder().encode(events.slice(0, 3).join("")));
          await new Promise((r) => setTimeout(r, 50));
          if (!init?.signal?.aborted) c.enqueue(new TextEncoder().encode(events.slice(3).join("")));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const promise = streamReply({ ...base, model: "claude-sonnet-5-5", signal: controller.signal, onText: () => controller.abort(), fetch: slowFetch });
    await assert.rejects(promise, (error) => isAbort(error));
  });

  it("金鑰無效、額度不足會轉成白話說明", async () => {
    const run = (reply: Parameters<typeof fakeFetch>[0]) =>
      streamReply({ ...base, model: "claude-haiku-4-5", signal: new AbortController().signal, onText: () => {}, fetch: fakeFetch(reply) }).catch((e: unknown) => describeError(e));
    assert.match(await run({ status: 401, error: { type: "authentication_error", message: "invalid x-api-key" } }) as string, /金鑰無效/);
    assert.match(await run({ status: 400, error: { type: "invalid_request_error", message: "Your credit balance is too low" } }) as string, /額度不足/);
    assert.match(await run({ status: 413, error: { type: "request_too_large", message: "Request exceeds the maximum allowed number of bytes" } }) as string, /內容太大/);
    assert.match(await run({ status: 400, error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } }) as string, /對話太長/);
  });
});

describe("verifyKey", () => {
  it("200 有效、401 無效、網路錯誤分開說明", async () => {
    const respond = (status: number) => (async () => new Response("{}", { status })) as typeof fetch;
    assert.deepEqual(await verifyKey("k", respond(200)), { ok: true });
    const bad = await verifyKey("k", respond(401));
    assert.ok(!bad.ok && /無效/.test(bad.reason));
    const down = await verifyKey("k", (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    assert.ok(!down.ok && /連不上/.test(down.reason));
  });

  it("送到官方網址，帶金鑰與瀏覽器直連的 header", async () => {
    const captured: Captured[] = [];
    await verifyKey("sk-ant-x", fakeFetch({ chunks: [] }, captured));
    assert.equal(captured[0]!.url, "https://api.anthropic.com/v1/models?limit=1");
    assert.equal(captured[0]!.headers.get("x-api-key"), "sk-ant-x");
    assert.equal(captured[0]!.headers.get("anthropic-dangerous-direct-browser-access"), "true");
  });
});

describe("normalizeKey", () => {
  it("去掉前後空白；中間有空白或全形字就拒絕", () => {
    assert.deepEqual(normalizeKey("  sk-ant-abc\n"), { ok: true, key: "sk-ant-abc" });
    assert.equal(normalizeKey("sk-ant a").ok, false);
    assert.equal(normalizeKey("sk-ant-ａ").ok, false);
    assert.equal(normalizeKey("").ok, false);
  });
});
