import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// CSP 裡的 ws:// 只給開發伺服器自動重新整理用，正式建置拿掉
const stripDevCsp: Plugin = {
  name: "strip-dev-csp",
  apply: "build",
  transformIndexHtml(html) {
    return html.replace(" ws://localhost:* ws://127.0.0.1:*", "");
  },
};

export default defineConfig({
  plugins: [react(), stripDevCsp],
  // Tauri 會用固定的 port 開開發畫面
  server: { port: 5310, strictPort: true, host: "127.0.0.1" },
  clearScreen: false,
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 1500 },
});
