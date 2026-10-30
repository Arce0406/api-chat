// 桌面版（Tauri）：金鑰存系統鑰匙圈、匯出用「另存新檔」、連結用系統瀏覽器開。

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { KeyStore, Platform } from "./types.ts";

const keychainStore: KeyStore = {
  description: "金鑰存在這台電腦的系統鑰匙圈（Windows 認證管理員／macOS 鑰匙圈），不會上傳。",
  async get() {
    return (await invoke<string | null>("get_api_key")) ?? null;
  },
  async set(key) {
    await invoke("set_api_key", { key });
  },
  async remove() {
    await invoke("remove_api_key");
  },
};

export const desktopPlatform: Platform = {
  kind: "desktop",
  keyStore: keychainStore,
  async saveTextFile(fileName, content) {
    await invoke<boolean>("save_text_file", { fileName, content });
  },
  openExternal(url) {
    void openUrl(url);
  },
};
