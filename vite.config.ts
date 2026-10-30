import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Tauri 會用固定的 port 開開發畫面
  server: { port: 5310, strictPort: true, host: "127.0.0.1" },
  clearScreen: false,
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 1500 },
});
