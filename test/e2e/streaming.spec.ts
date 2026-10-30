// 回覆進行中的各種操作。用可控的串流：測試決定什麼時候送出下一段、什麼時候結束或斷線。
import { expect, test, type Page } from "@playwright/test";
import { sseEvents } from "../helpers/sse.ts";

const KEY = "sk-ant-api03-e2e-test-key-0000000000000000AAAA";

interface Window {
  __streams: Array<{ push: (text: string) => void; close: () => void; fail: () => void; body: string }>;
}

/** 換掉頁面的 fetch：/v1/messages 回傳由測試控制的串流；/v1/models 直接回 200 */
async function controlledApi(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Window;
    w.__streams = [];
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://api.anthropic.com/v1/models")) return new Response("{}", { status: 200 });
      if (!url.startsWith("https://api.anthropic.com/v1/messages")) return original(input, init);
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
      const encoder = new TextEncoder();
      init?.signal?.addEventListener("abort", () => {
        try {
          controller.error(new DOMException("aborted", "AbortError"));
        } catch {}
      });
      w.__streams.push({
        push: (text) => controller.enqueue(encoder.encode(text)),
        close: () => controller.close(),
        fail: () => controller.error(new TypeError("network error")),
        body: String(init?.body ?? ""),
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
  });
}

const reply = (chunks: string[]) => sseEvents({ chunks, usage: { input_tokens: 1000, output_tokens: 100 } });

/** 送出事件：前三個是 message_start、content_block_start、第一段文字 */
async function push(page: Page, index: number, events: string[]) {
  await page.evaluate(([i, text]) => (window as unknown as Window).__streams[i as number]!.push(text as string), [index, events.join("")] as const);
}
async function close(page: Page, index: number) {
  await page.evaluate((i) => (window as unknown as Window).__streams[i]!.close(), index);
}
async function fail(page: Page, index: number) {
  await page.evaluate((i) => (window as unknown as Window).__streams[i]!.fail(), index);
}
async function streamCount(page: Page) {
  return page.evaluate(() => (window as unknown as Window).__streams.length);
}

async function start(page: Page, text: string) {
  await controlledApi(page);
  await page.goto("/");
  await page.locator("#api-key-input").fill(KEY);
  await page.getByRole("button", { name: "驗證並儲存" }).click();
  await page.locator("#composer-input").fill(text);
  await page.locator("#composer-input").press("Enter");
  await expect.poll(() => streamCount(page)).toBe(1);
}

test("停止時已收到的文字會保留，標示已停止，重新整理後還在", async ({ page }) => {
  await start(page, "寫一篇長文");
  const events = reply(["第一段。", "第二段。"]);
  await push(page, 0, events.slice(0, 3));
  await expect(page.getByTestId("streaming-message")).toContainText("第一段。");
  await page.getByRole("button", { name: "停止" }).click();
  const saved = page.getByTestId("assistant-message");
  await expect(saved).toContainText("第一段。");
  await expect(saved).toContainText("已停止");
  await expect(page.getByTestId("month-cost")).toContainText("另有 1 次無法計算");
  await page.reload();
  await page.getByRole("button", { name: "寫一篇長文" }).click();
  await expect(page.getByTestId("assistant-message")).toContainText("已停止");
});

test("回覆中改名、換模型，回覆完成後不會被改回去", async ({ page }) => {
  await start(page, "原本的標題");
  const events = reply(["好的"]);
  await push(page, 0, events.slice(0, 3));
  await page.getByRole("button", { name: "更多動作" }).click();
  await page.getByRole("menuitem", { name: "改名" }).click();
  await page.locator("#rename-input").fill("新標題");
  await page.locator("#rename-input").press("Enter");
  await page.locator("#model-select").selectOption({ label: "Haiku 4.5" });
  await push(page, 0, events.slice(3));
  await close(page, 0);
  await expect(page.getByTestId("assistant-message")).toContainText("好的");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("新標題");
  await expect(page.locator("#model-select")).toHaveValue("claude-haiku-4-5");
  await page.reload();
  await expect(page.locator(".conv-item")).toHaveText(["新標題"]);
});

test("回覆中刪除對話：會停止回覆，對話不會再出現，可以馬上開新對話", async ({ page }) => {
  await start(page, "要刪掉的對話");
  await push(page, 0, reply(["一些內容"]).slice(0, 3));
  await page.getByRole("button", { name: "更多動作" }).click();
  await page.getByRole("menuitem", { name: "刪除" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "刪除" }).click();
  await expect(page.locator(".conv-item")).toHaveCount(0);
  await page.locator("#composer-input").fill("新的問題");
  await expect(page.getByRole("button", { name: "送出" })).toBeEnabled();
  await page.locator("#composer-input").press("Enter");
  await expect.poll(() => streamCount(page)).toBe(2);
  await expect(page.locator(".conv-item")).toHaveText(["新的問題"]);
  await page.reload();
  await expect(page.locator(".conv-item")).toHaveText(["新的問題"]);
});

test("重新產生失敗或停止時，保留原本的回覆", async ({ page }) => {
  await start(page, "取個名字");
  const first = reply(["原本的回覆"]);
  await push(page, 0, first);
  await close(page, 0);
  await expect(page.getByTestId("assistant-message")).toContainText("原本的回覆");

  // 重新產生到一半斷線
  await page.getByRole("button", { name: "重新產生" }).click();
  await expect.poll(() => streamCount(page)).toBe(2);
  await expect(page.getByTestId("assistant-message")).toHaveCount(0);
  await push(page, 1, reply(["新的半段"]).slice(0, 3));
  await fail(page, 1);
  await expect(page.getByTestId("assistant-message")).toHaveText(/原本的回覆/);
  await expect(page.getByRole("alert")).toBeVisible();

  // 重新產生後按停止
  await page.getByRole("button", { name: "重新產生" }).click();
  await expect.poll(() => streamCount(page)).toBe(3);
  await page.getByRole("button", { name: "停止" }).click();
  await expect(page.getByTestId("assistant-message")).toHaveCount(1);
  await expect(page.getByTestId("assistant-message")).toContainText("原本的回覆");

  // 成功才取代
  await page.getByRole("button", { name: "重新產生" }).click();
  await expect.poll(() => streamCount(page)).toBe(4);
  await push(page, 3, reply(["新的回覆"]));
  await close(page, 3);
  await expect(page.getByTestId("assistant-message")).toHaveCount(1);
  await expect(page.getByTestId("assistant-message")).toContainText("新的回覆");
});

test("回覆到一半斷線：保留收到的部分並標示中斷，顯示錯誤", async ({ page }) => {
  await start(page, "說個故事");
  await push(page, 0, reply(["從前從前"]).slice(0, 3));
  await expect(page.getByTestId("streaming-message")).toContainText("從前從前");
  await fail(page, 0);
  const saved = page.getByTestId("assistant-message");
  await expect(saved).toContainText("從前從前");
  await expect(saved).toContainText("回覆中斷");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByTestId("month-cost")).toContainText("另有 1 次無法計算");
});
