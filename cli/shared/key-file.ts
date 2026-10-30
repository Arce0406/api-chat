// 命令列工具共用的金鑰檔位置與格式。ai-call、use-api 讀同一個檔，use-api setup 負責寫入。
// 桌面 App 也讀寫同一個檔（src-tauri/src/keystore.rs），兩邊的位置與格式要一致。

import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderName } from "../../src/core/models.ts";

export const KEY_VARIABLE: Record<ProviderName, string> = {
  anthropic: "ANTHROPIC_API_KEY",
};

/** 預設 ~/.config/api-chat/<provider>.env；API_CHAT_KEY_FILE 可指定 Anthropic 金鑰檔的完整路徑 */
export function keyFilePath(provider: ProviderName, env: NodeJS.ProcessEnv): string {
  if (provider === "anthropic" && env["API_CHAT_KEY_FILE"]) return env["API_CHAT_KEY_FILE"];
  const configHome = env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(configHome, "api-chat", `${provider}.env`);
}

/** 解析 KEY=VALUE 格式（忽略空行、# 註解、export 前綴、成對引號） */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    result[match[1]!] = value;
  }
  return result;
}
