// 讀各家 API 金鑰。執行時才讀金鑰檔，不設成全域環境變數。

import { readFileSync, statSync } from "node:fs";
import type { ProviderName } from "../../src/core/models.ts";
import { KEY_VARIABLE, keyFilePath, parseEnvFile } from "../shared/key-file.ts";

export { keyFilePath, parseEnvFile };

export class CredentialError extends Error {}

export interface LoadedKey {
  apiKey: string;
  /** 檔案權限太寬時的提醒 */
  warning?: string;
}

export function loadApiKey(provider: ProviderName, env: NodeJS.ProcessEnv): LoadedKey {
  const path = keyFilePath(provider, env);
  const variable = KEY_VARIABLE[provider];
  const hint = `請執行 use-api setup，或在這個檔案寫一行 ${variable}=<金鑰>`;

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    throw new CredentialError(`找不到 ${provider} 的金鑰檔 ${path}。${hint}`);
  }
  const apiKey = parseEnvFile(content)[variable];
  if (!apiKey) {
    throw new CredentialError(`${path} 裡的 ${variable} 是空的或不存在。${hint}`);
  }

  const loaded: LoadedKey = { apiKey };
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
    loaded.warning = `${path} 的權限讓其他使用者也讀得到，建議 chmod 600`;
  }
  return loaded;
}
