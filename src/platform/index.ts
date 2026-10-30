import { browserPlatform } from "./browser.ts";
import type { Platform } from "./types.ts";

export type { KeyStore, Platform } from "./types.ts";

// 桌面版（Tauri）的實作在下一個 PR 加入
export const platform: Platform = browserPlatform;
