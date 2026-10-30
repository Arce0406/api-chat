import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// index.html 的 CSP 只給瀏覽器開發版用（含開發伺服器自動重新整理的 ws://）。
// 正式建置給桌面版，CSP 改由 src-tauri/tauri.conf.json 設定，這裡整段拿掉，避免兩份規則互相打架。
const stripDevCsp: Plugin = {
  name: "strip-dev-csp",
  apply: "build",
  transformIndexHtml(html) {
    const stripped = html.replace(/\s*<!--[^>]*-->\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
    if (stripped === html) throw new Error("index.html 找不到 CSP meta，請同步更新 vite.config.ts");
    return stripped;
  },
};

export default defineConfig({
  plugins: [react(), stripDevCsp],
  // Tauri 會用固定的 port 開開發畫面
  server: { port: 5310, strictPort: true, host: "127.0.0.1" },
  clearScreen: false,
  // 開發伺服器啟動時就先處理好這些套件，避免第一次載入時才發現、整頁重新載入（會打斷端對端測試）
  optimizeDeps: {
    include: ["react", "react-dom/client", "@anthropic-ai/sdk", "marked", "dompurify", "highlight.js/lib/common", "@tauri-apps/api/core", "@tauri-apps/plugin-opener"],
  },
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 1500 },
});
