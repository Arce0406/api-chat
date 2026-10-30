// 桌面版（Tauri）：金鑰存使用者資料夾的檔案（和命令列工具共用）、匯出用「另存新檔」、連結用系統瀏覽器開。

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { KeyStore, Platform } from "./types.ts";

const keyFileStore: KeyStore = {
  description: "金鑰存在這台電腦的使用者資料夾，只有你的帳號能讀，不會上傳。命令列工具也用這把金鑰。",
  async get() {
    return (await invoke<string | null>("get_api_key")) ?? null;
  },
  async set(key) {
    await invoke("set_api_key", { key });
  },
  async remove() {
    await invoke("remove_api_key");
  },
  async location() {
    return invoke<string>("api_key_location");
  },
};

export const desktopPlatform: Platform = {
  kind: "desktop",
  keyStore: keyFileStore,
  async saveTextFile(fileName, content) {
    await invoke<boolean>("save_text_file", { fileName, content });
  },
  openExternal(url) {
    void openUrl(url);
  },
};
