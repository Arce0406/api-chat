// 瀏覽器開發版：只用來開發與測試介面。桌面版的金鑰改存系統鑰匙圈（見 #20）。

import type { KeyStore, Platform } from "./types.ts";

const SESSION_KEY = "api-chat:dev-api-key";

// 存在 sessionStorage：關掉分頁就消失，重新整理還在（方便開發）
const sessionKeyStore: KeyStore = {
  description: "瀏覽器開發版：金鑰只存在這個分頁，關掉就會清除。",
  async get() {
    try {
      return sessionStorage.getItem(SESSION_KEY);
    } catch {
      return null;
    }
  },
  async set(key) {
    sessionStorage.setItem(SESSION_KEY, key);
  },
  async remove() {
    sessionStorage.removeItem(SESSION_KEY);
  },
};

export const browserPlatform: Platform = {
  kind: "browser",
  keyStore: sessionKeyStore,
  async saveTextFile(fileName, content) {
    const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  openExternal(url) {
    window.open(url, "_blank", "noopener,noreferrer");
  },
};
