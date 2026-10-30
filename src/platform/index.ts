import { isTauri } from "@tauri-apps/api/core";
import { browserPlatform } from "./browser.ts";
import { desktopPlatform } from "./desktop.ts";
import type { Platform } from "./types.ts";

export type { KeyStore, Platform } from "./types.ts";

export const platform: Platform = isTauri() ? desktopPlatform : browserPlatform;
