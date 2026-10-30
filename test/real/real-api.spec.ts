// 真的呼叫 Anthropic API（會花一點錢）。執行方式見 README「測試」。
import { expect, test } from "@playwright/test";

const key = process.env.REAL_API_KEY ?? "";

test.skip(!key, "沒有 REAL_API_KEY");

test("真實 API：驗證金鑰、Haiku 與 Sonnet（含思考深度）串流回覆", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.locator("#api-key-input").fill(key);
  await page.getByRole("button", { name: "驗證並儲存" }).click();
  await expect(page.getByRole("button", { name: "＋ 新對話" })).toBeVisible({ timeout: 20_000 });

  await page.locator("#model-select").selectOption({ label: "Haiku 4.5" });
  await page.locator("#composer-input").fill("只回覆這四個字：測試成功");
  await page.locator("#composer-input").press("Enter");
  const first = page.getByTestId("assistant-message").first();
  await expect(first).toContainText("測試成功", { timeout: 60_000 });
  await expect(first.getByTestId("reply-cost")).toHaveText(/US\$|< US\$/);
  console.log("Haiku:", await first.locator(".meta").innerText());

  await page.getByRole("button", { name: "＋ 新對話" }).click();
  await page.locator("#model-select").selectOption({ label: "Sonnet 5.5" });
  await page.locator("#effort-select").selectOption({ label: "低" });
  await page.locator("#composer-input").fill("只回覆這三個字：第二題");
  await page.locator("#composer-input").press("Enter");
  const second = page.getByTestId("assistant-message").first();
  await expect(second).toContainText("第二題", { timeout: 60_000 });
  console.log("Sonnet:", await second.locator(".meta").innerText());
});
