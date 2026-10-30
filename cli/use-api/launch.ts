// 啟動 Claude Code，這一次改用 API 金鑰計費。
// 做法：用 --settings 帶入 apiKeyHelper（只影響這次啟動，不改使用者的設定檔），
// helper 就是本程式的 print-key。

import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";

/**
 * 會讓 Claude Code 不用這把金鑰（認證順序排在 apiKeyHelper 前面、或改走其他雲端），
 * 或改變請求送去哪裡、帶什麼 header 的變數。從子程序環境移除。
 * ANTHROPIC_PROFILE 與 federation 變數排在 apiKeyHelper 後面，移除只是保險。
 */
export const CONFLICTING_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_MANTLE",
] as const;

/**
 * 設定檔（使用者、專案、worktree 主 checkout 的 local 設定…）的 env 區塊會蓋過環境變數，
 * 從外面移除不了；但 --settings 的優先順序高於這些檔案，所以在 --settings 裡明確指定。
 * 空字串視為沒有設定；網址直接指定官方位址。（2026-10-30 實測：專案設定檔寫了假網址與假 token，
 * 加上這段覆寫後仍以金鑰正常回覆。）
 */
export const ENV_OVERRIDES: Record<string, string> = {
  ANTHROPIC_BASE_URL: "https://api.anthropic.com",
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
  ANTHROPIC_CUSTOM_HEADERS: "",
  CLAUDE_CODE_USE_BEDROCK: "",
  CLAUDE_CODE_USE_VERTEX: "",
  CLAUDE_CODE_USE_FOUNDRY: "",
  CLAUDE_CODE_USE_ANTHROPIC_AWS: "",
  CLAUDE_CODE_USE_MANTLE: "",
};

export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const name of CONFLICTING_VARIABLES) delete result[name];
  return result;
}

export const DEFAULT_MANAGED_DIR = "/etc/claude-code";

/**
 * 公司統一派發的設定（managed settings）優先順序高於 --settings，蓋不掉，只能拒絕啟動。
 * 只看 Linux 的檔案位置；從伺服器下載的 managed settings 快取位置文件沒寫，無法檢查。
 */
export function findManagedConflicts(managedDir: string): string[] {
  const files = [join(managedDir, "managed-settings.json")];
  try {
    for (const name of readdirSync(join(managedDir, "managed-settings.d")).sort()) {
      if (name.endsWith(".json")) files.push(join(managedDir, "managed-settings.d", name));
    }
  } catch {
    // 沒有這個資料夾
  }
  const conflicts: string[] = [];
  for (const file of files) {
    let settings: { env?: unknown; apiKeyHelper?: unknown };
    try {
      settings = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (settings.apiKeyHelper !== undefined) conflicts.push(`${file} 設了 apiKeyHelper`);
    const block = settings.env;
    if (!block || typeof block !== "object") continue;
    for (const name of CONFLICTING_VARIABLES) {
      if (name in block) conflicts.push(`${file} 的 env 設了 ${name}`);
    }
  }
  return conflicts;
}

/** 單引號包起來給 shell 用 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function helperCommand(execPath: string, cliPath: string): string {
  return `${shellQuote(execPath)} --disable-warning=ExperimentalWarning ${shellQuote(cliPath)} print-key`;
}

export function buildClaudeArgs(forwarded: string[], helper: string): string[] {
  return ["--settings", JSON.stringify({ apiKeyHelper: helper, env: ENV_OVERRIDES }), ...forwarded];
}

/** 前景執行 claude，回傳它的結束碼 */
export function spawnClaude(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: "inherit", env });
    // Ctrl-C 交給 claude 自己處理，本程式不跟著結束
    const ignore = () => {};
    process.on("SIGINT", ignore);
    const forward = () => child.kill("SIGTERM");
    process.on("SIGTERM", forward);
    const cleanup = () => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", forward);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      cleanup();
      // 被訊號結束時依慣例回傳 128＋訊號編號（例如 Ctrl-C 是 130）
      resolve(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0));
    });
  });
}
