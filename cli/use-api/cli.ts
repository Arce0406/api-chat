// use-api：訂閱額度用完時，用自己的 Anthropic API 金鑰接續 Claude Code 對話。用法見 README.md 或 use-api help。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildClaudeArgs, DEFAULT_MANAGED_DIR, findManagedConflicts, helperCommand, scrubEnv, spawnClaude } from "./launch.ts";
import { defaultKeyPath, fileStore, maskKey, StoreError, type KeyStore } from "./store.ts";
import { validateKey, type Validation } from "./validate.ts";

export const EXIT = { ok: 0, failed: 1, usage: 2, noKey: 3 } as const;

const SUBCOMMANDS = new Set(["setup", "status", "remove", "print-key", "help", "-h"]);

const HELP = `用法：
  use-api [claude 的參數…]   用自己的 API 金鑰啟動 Claude Code（這次改用 API 額度計費）
                             例：use-api --continue   接續這個資料夾最近的對話
                                 use-api --resume     選一段對話接續
  use-api setup              輸入金鑰並驗證後存起來（輸入時不顯示）
          setup --stdin      從 stdin 讀金鑰（給腳本用）
          setup --no-verify  不驗證直接存
  use-api status             看金鑰存在哪、有沒有設定衝突
  use-api remove             刪除存起來的金鑰
  use-api help               顯示這份說明

說明：
  - 只影響這一次啟動的對話，不改 Claude Code 的設定；直接用 claude 仍是訂閱計費。
  - 用 API 金鑰時，手機遙控（Remote Control）和 claude.ai 的連接器不能用，這是 Claude Code 的限制。
  - 啟動後畫面開頭會顯示「API Usage Billing」；也可以用 /status 確認。
  - 公司統一管理的電腦（managed settings）可能強制用別的憑證，請用 /status 確認。
  - 金鑰檔：${"$"}XDG_CONFIG_HOME/api-chat/anthropic.env（預設 ~/.config/api-chat/anthropic.env；可用 API_CHAT_KEY_FILE 改），和 ai-call 共用`;

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => string;
  promptHidden: (question: string) => Promise<string>;
  validate: (key: string) => Promise<Validation>;
  launch: (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
  execPath: string;
  cliPath: string;
}

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const command = argv[0] && SUBCOMMANDS.has(argv[0]) ? argv[0] : null;
  if (command === "help" || command === "-h") {
    deps.stdout(HELP + "\n");
    return EXIT.ok;
  }

  if (deps.platform !== "linux") {
    deps.stderr("use-api：目前只支援 Linux，Windows／macOS 版之後提供\n");
    return EXIT.failed;
  }

  const store = fileStore(defaultKeyPath(deps.env));
  try {
    switch (command) {
      case "print-key":
        return printKey(store, deps);
      case "setup":
        return await setup(argv.slice(1), store, deps);
      case "status":
        return status(store, deps);
      case "remove":
        deps.stdout(store.remove() ? `已刪除 ${store.describe()}\n` : "沒有存任何金鑰\n");
        return EXIT.ok;
      default:
        return await launch(argv, store, deps);
    }
  } catch (error) {
    if (error instanceof StoreError) {
      deps.stderr(`use-api：${error.message}\n`);
      return EXIT.failed;
    }
    throw error;
  }
}

function managedConflicts(deps: CliDeps): string[] {
  return findManagedConflicts(deps.env["USE_API_MANAGED_DIR"] ?? DEFAULT_MANAGED_DIR);
}

/** 給 Claude Code 的 apiKeyHelper 呼叫：只輸出金鑰，不能有其他文字 */
function printKey(store: KeyStore, deps: CliDeps): number {
  const key = store.read();
  if (!key) {
    deps.stderr(`use-api：找不到金鑰（${store.describe()}），請先執行 use-api setup\n`);
    return EXIT.noKey;
  }
  deps.stdout(key);
  return EXIT.ok;
}

async function setup(args: string[], store: KeyStore, deps: CliDeps): Promise<number> {
  const unknown = args.filter((a) => a !== "--stdin" && a !== "--no-verify");
  if (unknown.length) {
    deps.stderr(`use-api：setup 不認得 ${unknown.join(" ")}\n`);
    return EXIT.usage;
  }

  let key: string;
  try {
    key = (args.includes("--stdin") ? deps.readStdin() : await deps.promptHidden("貼上 Anthropic API 金鑰（不會顯示）：")).trim();
  } catch (error) {
    deps.stderr(`use-api：${(error as Error).message}\n`);
    return EXIT.failed;
  }
  if (!key) {
    deps.stderr("use-api：沒有輸入金鑰\n");
    return EXIT.usage;
  }
  if (!/^[\x21-\x7e]+$/.test(key)) {
    deps.stderr("use-api：金鑰含有空白、換行或其他特殊字元，請確認只貼了一把金鑰\n");
    return EXIT.usage;
  }

  if (!args.includes("--no-verify")) {
    const result = await deps.validate(key);
    if (!result.ok) {
      const hint = result.reason === "error" ? "；網路有問題時可加 --no-verify 先存起來" : "";
      deps.stderr(`use-api：驗證失敗，沒有存檔：${result.message}${hint}\n`);
      return EXIT.failed;
    }
  }

  store.write(key);
  deps.stdout(`已存到 ${store.describe()}（${maskKey(key)}）\n`);
  return EXIT.ok;
}

function status(store: KeyStore, deps: CliDeps): number {
  const key = store.read();
  deps.stdout(`金鑰檔：${store.describe()}\n`);
  deps.stdout(`金鑰：${key ? maskKey(key) : "沒有（請執行 use-api setup）"}\n`);
  const conflicts = managedConflicts(deps);
  deps.stdout(conflicts.length ? `公司派發的設定衝突（這台不能用 use-api）：\n${conflicts.map((c) => `  - ${c}\n`).join("")}` : "設定衝突：無\n");
  return key && conflicts.length === 0 ? EXIT.ok : EXIT.failed;
}

async function launch(forwarded: string[], store: KeyStore, deps: CliDeps): Promise<number> {
  if (forwarded.some((a) => a === "--settings" || a.startsWith("--settings="))) {
    deps.stderr("use-api：use-api 自己會用 --settings 帶入金鑰，不能再另外指定 --settings\n");
    return EXIT.usage;
  }
  if (!store.read()) {
    deps.stderr(`use-api：找不到金鑰（${store.describe()}），請先執行 use-api setup\n`);
    return EXIT.noKey;
  }
  // 使用者與專案設定檔的衝突由 --settings 的 env 覆寫處理；公司派發的設定優先順序更高，只能拒絕
  const conflicts = managedConflicts(deps);
  if (conflicts.length) {
    deps.stderr(
      `use-api：這台電腦有公司統一派發的設定，會讓 Claude Code 不用這把金鑰或把金鑰送到別處，use-api 無法使用：\n${conflicts.map((c) => `  - ${c}\n`).join("")}`,
    );
    return EXIT.failed;
  }

  const bin = deps.env["USE_API_CLAUDE_BIN"] ?? "claude";
  const args = buildClaudeArgs(forwarded, helperCommand(deps.execPath, deps.cliPath));
  deps.stderr("[use-api] 這次用 API 金鑰計費；手機遙控與 claude.ai 連接器在這段對話中不能用\n");
  try {
    return await deps.launch(bin, args, scrubEnv(deps.env));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    deps.stderr(missing ? `use-api：找不到 ${bin} 指令，請確認已安裝 Claude Code\n` : `use-api：無法執行 ${bin}：${(error as Error).message}\n`);
    return EXIT.failed;
  }
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error("不是在終端機執行，請改用 use-api setup --stdin"));
      return;
    }
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003" || ch === "\u0004") return finish(new Error("已取消"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), {
    env: process.env,
    platform: process.platform,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readStdin: () => readFileSync(0, "utf8"),
    promptHidden,
    validate: (key) => validateKey(key),
    launch: spawnClaude,
    execPath: process.execPath,
    cliPath: fileURLToPath(import.meta.url),
  });
}
