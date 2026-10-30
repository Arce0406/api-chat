import { defineConfig } from "@playwright/test";

// 用 Playwright 官方 docker 映像 mcr.microsoft.com/playwright:v1.56.1-noble 執行（見 scripts/e2e.sh）
export default defineConfig({
  // E2E_REAL=1：用真的金鑰打真的 API（會花一點錢），只在手動驗證時跑
  testDir: process.env.E2E_REAL ? "test/real" : "test/e2e",
  timeout: 30_000,
  fullyParallel: true,
  // 開發機常同時跑很多東西，平行數太高時頁面載入會逾時
  workers: 4,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:5310",
    locale: "zh-TW",
    timezoneId: "Asia/Taipei",
  },
});
