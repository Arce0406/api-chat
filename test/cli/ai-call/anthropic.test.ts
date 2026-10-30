import assert from "node:assert/strict";
import { test } from "node:test";
import { createAnthropicProvider } from "../../../cli/ai-call/providers/anthropic.ts";

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function fakeFetch(status: number, payload: unknown, captured: Captured[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    captured.push({ url: request.url, headers: request.headers, body: JSON.parse(await request.text()) });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text: "結果" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...overrides,
  };
}

const baseRequest = { prompt: "hi", maxTokens: 1000 };

test("Haiku：打官方網址、帶金鑰、不帶 fallbacks 與 effort", async () => {
  const captured: Captured[] = [];
  const provider = createAnthropicProvider({ apiKey: "sk-test", fetch: fakeFetch(200, message(), captured), maxRetries: 0 });
  const result = await provider.complete({ ...baseRequest, model: "claude-haiku-4-5", serverFallback: false });

  assert.equal(captured.length, 1);
  const call = captured[0]!;
  assert.ok(call.url.startsWith("https://api.anthropic.com/v1/messages"), call.url);
  const auth = call.headers.get("x-api-key") ?? call.headers.get("authorization");
  assert.ok(auth?.includes("sk-test"), "要帶上指定的金鑰");
  assert.equal(call.body["model"], "claude-haiku-4-5");
  assert.equal(call.body["max_tokens"], 1000);
  assert.equal(call.body["fallbacks"], undefined);
  assert.equal(call.body["output_config"], undefined);
  assert.equal(call.headers.get("anthropic-beta"), null);

  assert.equal(result.text, "結果");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.fallbackUsed, false);
  assert.deepEqual(result.usage, [
    { model: "claude-haiku-4-5-20251001", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ]);
});

test("環境變數 ANTHROPIC_BASE_URL 不會讓請求改打別的位址", async () => {
  const previous = process.env["ANTHROPIC_BASE_URL"];
  process.env["ANTHROPIC_BASE_URL"] = "https://proxy.example.com";
  try {
    const captured: Captured[] = [];
    const provider = createAnthropicProvider({ apiKey: "sk-test", fetch: fakeFetch(200, message(), captured), maxRetries: 0 });
    await provider.complete({ ...baseRequest, model: "claude-haiku-4-5", serverFallback: false });
    assert.ok(captured[0]!.url.startsWith("https://api.anthropic.com/"));
  } finally {
    if (previous === undefined) delete process.env["ANTHROPIC_BASE_URL"];
    else process.env["ANTHROPIC_BASE_URL"] = previous;
  }
});

test("其他 ANTHROPIC_ 環境變數換不掉金鑰（CUSTOM_HEADERS、API_KEY、AUTH_TOKEN、PROFILE）", async () => {
  const injected: Record<string, string> = {
    ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer sk-OTHER\nx-api-key: sk-OTHER2",
    ANTHROPIC_API_KEY: "sk-OTHER3",
    ANTHROPIC_AUTH_TOKEN: "sk-OTHER4",
    ANTHROPIC_PROFILE: "nonexistent-profile",
  };
  const previous = Object.fromEntries(Object.keys(injected).map((k) => [k, process.env[k]]));
  Object.assign(process.env, injected);
  try {
    const captured: Captured[] = [];
    const provider = createAnthropicProvider({ apiKey: "sk-test", fetch: fakeFetch(200, message(), captured), maxRetries: 0 });
    await provider.complete({ ...baseRequest, model: "claude-haiku-4-5", serverFallback: false });
    const headers = [...captured[0]!.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    assert.ok(!headers.includes("sk-OTHER"), headers);
    assert.ok(headers.includes("sk-test"), headers);
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("Sonnet：帶 fallbacks default、beta header 與 effort，備援那段用備援模型計", async () => {
  const captured: Captured[] = [];
  const payload = message({
    model: "claude-sonnet-5",
    content: [
      { type: "fallback", from: { model: "claude-sonnet-5-5" }, to: { model: "claude-sonnet-5" } },
      { type: "text", text: "備援答案" },
    ],
    usage: {
      input_tokens: 300,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      iterations: [
        { type: "message", model: "claude-sonnet-5-5", input_tokens: 150, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
        { type: "fallback_message", model: "claude-sonnet-5", input_tokens: 150, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
      ],
    },
  });
  const provider = createAnthropicProvider({ apiKey: "sk-test", fetch: fakeFetch(200, payload, captured), maxRetries: 0 });
  const result = await provider.complete({ ...baseRequest, model: "claude-sonnet-5-5", serverFallback: true, effort: "low" });

  const call = captured[0]!;
  assert.equal(call.body["fallbacks"], "default");
  assert.deepEqual(call.body["output_config"], { effort: "low" });
  assert.equal(call.body["betas"], undefined, "betas 要變成 header，不在 body");
  assert.ok(call.headers.get("anthropic-beta")?.includes("server-side-fallback-2026-07-01"));

  assert.equal(result.text, "備援答案");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.servedModel, "claude-sonnet-5");
  assert.deepEqual(
    result.usage.map((u) => [u.model, u.inputTokens, u.outputTokens]),
    [
      ["claude-sonnet-5-5", 150, 0],
      ["claude-sonnet-5", 150, 50],
    ],
  );
});

test("拒答：回傳 refusal 與類別", async () => {
  const captured: Captured[] = [];
  const payload = message({
    content: [],
    stop_reason: "refusal",
    stop_details: { type: "refusal", category: "cyber", explanation: "說明" },
  });
  const provider = createAnthropicProvider({ apiKey: "sk-test", fetch: fakeFetch(200, payload, captured), maxRetries: 0 });
  const result = await provider.complete({ ...baseRequest, model: "claude-haiku-4-5", serverFallback: false });
  assert.equal(result.stopReason, "refusal");
  assert.deepEqual(result.refusal, { category: "cyber", explanation: "說明" });
});

test("錯誤分類：401 → auth、429 → rate_limit、400 → bad_request", async () => {
  const cases: Array<[number, string]> = [
    [401, "auth"],
    [429, "rate_limit"],
    [400, "bad_request"],
    [529, "overloaded"],
    [500, "server"],
  ];
  for (const [status, kind] of cases) {
    const provider = createAnthropicProvider({
      apiKey: "sk-test",
      fetch: fakeFetch(status, { type: "error", error: { type: "x", message: "m" } }, []),
      maxRetries: 0,
    });
    const error = await provider
      .complete({ ...baseRequest, model: "claude-haiku-4-5", serverFallback: false })
      .then(() => assert.fail("應該要丟錯"), (e: unknown) => e);
    assert.equal(provider.describeError(error).kind, kind, `status ${status}`);
  }
});
