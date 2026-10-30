import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, run, type CliDeps } from "../../../cli/use-api/cli.ts";
import { ENV_OVERRIDES, helperCommand, spawnClaude } from "../../../cli/use-api/launch.ts";
import { defaultKeyPath, fileStore, maskKey, parseEnvFile } from "../../../cli/use-api/store.ts";
import { keyFilePath } from "../../../cli/ai-call/credentials.ts";
import { validateKey } from "../../../cli/use-api/validate.ts";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
const CLI_PATH = fileURLToPath(new URL("../../../cli/use-api/cli.ts", import.meta.url));

interface Harness {
  deps: CliDeps;
  out: () => string;
  err: () => string;
  dir: string;
  keyFile: string;
  launches: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv }>;
}

function harness(options: { key?: string | null; env?: NodeJS.ProcessEnv; stdin?: string; valid?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "use-api-test-"));
  const keyFile = join(dir, "config", "use-api", "anthropic.env");
  if (options.key !== null) {
    mkdirSync(join(dir, "config", "use-api"), { recursive: true });
    writeFileSync(keyFile, `ANTHROPIC_API_KEY='${options.key ?? KEY}'\n`, { mode: 0o600 });
  }
  mkdirSync(join(dir, "managed"));
  let stdout = "";
  let stderr = "";
  const launches: Harness["launches"] = [];
  const deps: CliDeps = {
    env: { API_CHAT_KEY_FILE: keyFile, USE_API_MANAGED_DIR: join(dir, "managed"), PATH: process.env["PATH"], ...options.env },
    platform: "linux",
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    readStdin: () => options.stdin ?? "",
    promptHidden: async () => options.stdin ?? "",
    validate: async () => (options.valid === false ? { ok: false, reason: "invalid", message: "金鑰無效或沒有權限" } : { ok: true }),
    launch: async (bin, args, env) => {
      launches.push({ bin, args, env });
      return 0;
    },
    execPath: process.execPath,
    cliPath: CLI_PATH,
  };
  return { deps, out: () => stdout, err: () => stderr, dir, keyFile, launches };
}

test("啟動：帶 --settings apiKeyHelper，原樣轉交其他參數", async () => {
  const h = harness();
  assert.equal(await run(["--continue", "--model", "opus"], h.deps), EXIT.ok);
  const [call] = h.launches;
  assert.equal(call!.bin, "claude");
  assert.equal(call!.args[0], "--settings");
  const settings = JSON.parse(call!.args[1]!);
  assert.deepEqual(Object.keys(settings), ["apiKeyHelper", "env"]);
  assert.match(settings.apiKeyHelper, /print-key$/);
  assert.ok(!call!.args[1]!.includes(KEY), "argv 不能含金鑰");
  // 設定檔 env 的衝突變數由 --settings 覆寫：網址固定官方、其他清空
  assert.deepEqual(settings.env, ENV_OVERRIDES);
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_MANTLE"]) {
    assert.equal(settings.env[name], "", name);
  }
  assert.deepEqual(call!.args.slice(2), ["--continue", "--model", "opus"]);
  assert.match(h.err(), /API 金鑰計費/);
});

test("啟動：從子程序環境移除會蓋過金鑰或改變去向的變數，保留其他變數", async () => {
  const h = harness({
    env: {
      ANTHROPIC_API_KEY: "sk-other",
      ANTHROPIC_AUTH_TOKEN: "tok",
      ANTHROPIC_BASE_URL: "https://proxy.example.com",
      ANTHROPIC_CUSTOM_HEADERS: "x: y",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_MODEL: "claude-opus-5-5",
      KEEP_ME: "1",
    },
  });
  await run([], h.deps);
  const env = h.launches[0]!.env;
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_USE_BEDROCK"]) {
    assert.equal(env[name], undefined, name);
  }
  assert.equal(env["ANTHROPIC_MODEL"], "claude-opus-5-5");
  assert.equal(env["KEEP_ME"], "1");
});

test("啟動：公司派發的設定（managed）有衝突就拒絕；無關設定照常啟動", async () => {
  const cases: Array<[string, unknown, number]> = [
    ["managed-settings.json", { env: { ANTHROPIC_BASE_URL: "https://gw.example.com" } }, EXIT.failed],
    ["managed-settings.d/10-auth.json", { apiKeyHelper: "corp-helper" }, EXIT.failed],
    ["managed-settings.json", { env: { CLAUDE_CODE_TMPDIR: "/x" }, permissions: {} }, EXIT.ok],
  ];
  for (const [relative, content, expected] of cases) {
    const h = harness();
    const file = join(h.dir, "managed", relative);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(content));
    assert.equal(await run([], h.deps), expected, relative);
    assert.equal(h.launches.length, expected === EXIT.ok ? 1 : 0, relative);
  }
});

test("啟動：沒有金鑰 exit 3、另外指定 --settings exit 2，都不啟動", async () => {
  const noKey = harness({ key: null });
  assert.equal(await run(["--continue"], noKey.deps), EXIT.noKey);
  assert.match(noKey.err(), /use-api setup/);

  const withSettings = harness();
  assert.equal(await run(["--settings", "{}"], withSettings.deps), EXIT.usage);
  assert.equal(await run(["--settings={}"], withSettings.deps), EXIT.usage);
  assert.equal(noKey.launches.length + withSettings.launches.length, 0);
});

test("print-key：只輸出金鑰本身（去掉引號、沒有換行）", async () => {
  const h = harness();
  assert.equal(await run(["print-key"], h.deps), EXIT.ok);
  assert.equal(h.out(), KEY);
});

test("helper 指令真的能被 shell 執行並印出金鑰（路徑含單引號也可以）", () => {
  const h = harness();
  const command = helperCommand(process.execPath, CLI_PATH);
  const output = execFileSync("sh", ["-c", command], { env: { ...process.env, API_CHAT_KEY_FILE: h.keyFile } }).toString();
  assert.equal(output, KEY);

  // 程式本身的路徑含單引號、空白、$()
  const oddDir = join(h.dir, "it's $(touch pwned) dir");
  symlinkSync(join(CLI_PATH, ".."), oddDir);
  const oddCommand = helperCommand(process.execPath, join(oddDir, "cli.ts"));
  const output3 = execFileSync("sh", ["-c", oddCommand], { cwd: h.dir, env: { ...process.env, API_CHAT_KEY_FILE: h.keyFile } }).toString();
  assert.equal(output3, KEY);
  assert.equal(existsSync(join(h.dir, "pwned")), false);

  const odd = join(h.dir, "it's here.env");
  writeFileSync(odd, `ANTHROPIC_API_KEY=${KEY}\n`);
  const output2 = execFileSync("sh", ["-c", command], { env: { ...process.env, API_CHAT_KEY_FILE: odd } }).toString();
  assert.equal(output2, KEY);
});

test("spawnClaude：被訊號結束回傳 128＋訊號編號；找不到指令時說明要安裝", async () => {
  const h = harness();
  const fake = join(h.dir, "killed-claude");
  writeFileSync(fake, "#!/bin/sh\nkill -TERM $$\n", { mode: 0o755 });
  assert.equal(await spawnClaude(fake, [], { PATH: process.env["PATH"] }), 143);

  h.deps.env["USE_API_CLAUDE_BIN"] = join(h.dir, "no-such-claude");
  h.deps.launch = spawnClaude;
  assert.equal(await run([], h.deps), EXIT.failed);
  assert.match(h.err(), /找不到 .*no-such-claude 指令，請確認已安裝 Claude Code/);
});

test("spawnClaude：真的執行子程序、傳入參數與環境、回傳結束碼", async () => {
  const h = harness();
  const fake = join(h.dir, "fake-claude");
  const record = join(h.dir, "record.json");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}.args'\nprintf '%s' "\${ANTHROPIC_API_KEY-unset}" > '${record}.env'\nexit 7\n`, { mode: 0o755 });
  const code = await spawnClaude(fake, ["--settings", "{}", "--continue"], { PATH: process.env["PATH"] });
  assert.equal(code, 7);
  assert.equal(readFileSync(`${record}.args`, "utf8"), "--settings\n{}\n--continue\n");
  assert.equal(readFileSync(`${record}.env`, "utf8"), "unset");
});

test("setup：驗證通過才存，權限 600；驗證失敗不存", async () => {
  const ok = harness({ key: null, stdin: `  ${KEY}\n` });
  assert.equal(await run(["setup", "--stdin"], ok.deps), EXIT.ok);
  assert.equal(parseEnvFile(readFileSync(ok.keyFile, "utf8"))["ANTHROPIC_API_KEY"], KEY);
  assert.equal(statSync(ok.keyFile).mode & 0o777, 0o600);
  assert.ok(!ok.out().includes(KEY), "畫面不能出現完整金鑰");

  const bad = harness({ key: null, stdin: KEY, valid: false });
  assert.equal(await run(["setup", "--stdin"], bad.deps), EXIT.failed);
  assert.equal(existsSync(bad.keyFile), false);

  const skip = harness({ key: null, stdin: KEY, valid: false });
  assert.equal(await run(["setup", "--stdin", "--no-verify"], skip.deps), EXIT.ok);
});

test("setup：空白、含換行的輸入與不認得的參數都拒絕", async () => {
  assert.equal(await run(["setup", "--stdin"], harness({ key: null, stdin: "  " }).deps), EXIT.usage);
  assert.equal(await run(["setup", "--stdin"], harness({ key: null, stdin: `${KEY}\n${KEY}` }).deps), EXIT.usage);
  assert.equal(await run(["setup", "--bogus"], harness({ key: null }).deps), EXIT.usage);
  // 終端機控制字元（Ctrl-D、方向鍵）混進來
  assert.equal(await run(["setup", "--stdin", "--no-verify"], harness({ key: null, stdin: `${KEY}\u0004` }).deps), EXIT.usage);
  assert.equal(await run(["setup", "--stdin", "--no-verify"], harness({ key: null, stdin: `${KEY}\u001b[D` }).deps), EXIT.usage);
});

test("金鑰檔是連結時：setup 不覆寫原檔，remove 只刪連結", async () => {
  const h = harness({ key: null, stdin: "sk-ant-api03-new-key-value-0000" });
  const target = join(h.dir, "shared.env");
  writeFileSync(target, `# 共用機密\nANTHROPIC_API_KEY=${KEY}\n`);
  mkdirSync(join(h.keyFile, ".."), { recursive: true });
  symlinkSync(target, h.keyFile);

  assert.equal(await run(["print-key"], h.deps), EXIT.ok);
  assert.equal(h.out(), KEY);
  assert.equal(await run(["setup", "--stdin"], h.deps), EXIT.failed);
  assert.match(readFileSync(target, "utf8"), /共用機密/);

  assert.equal(await run(["remove"], h.deps), EXIT.ok);
  assert.equal(existsSync(h.keyFile), false);
  assert.equal(lstatSync(target).isFile(), true, "原檔要留著");
});

test("status：遮蔽金鑰、列出衝突", async () => {
  const h = harness();
  assert.equal(await run(["status"], h.deps), EXIT.ok);
  assert.ok(!h.out().includes(KEY));
  assert.match(h.out(), new RegExp(maskKey(KEY).replace("…", ".")));
  assert.match(h.out(), /設定衝突：無/);
});

test("金鑰檔讀不到（權限）：說明檢查權限，不叫人重新 setup", async () => {
  const h = harness();
  chmodSync(h.keyFile, 0o000);
  try {
    assert.equal(await run(["status"], h.deps), EXIT.failed);
    assert.match(h.err(), /讀不到金鑰檔.*權限/);
    assert.equal(await run(["--continue"], h.deps), EXIT.failed);
    assert.equal(h.launches.length, 0);
  } finally {
    chmodSync(h.keyFile, 0o600);
  }
});

test("非 Linux：說明尚未支援，不讀也不啟動", async () => {
  const h = harness();
  h.deps.platform = "darwin";
  assert.equal(await run(["--continue"], h.deps), EXIT.failed);
  assert.equal(h.launches.length, 0);
  assert.equal(await run(["help"], h.deps), EXIT.ok, "help 在任何平台都能看");
});

test("validateKey：200 通過、401 無效、其他狀態與連線失敗回報錯誤，且帶正確 header", async () => {
  const seen: Array<{ url: string; key: string | null }> = [];
  const fakeFetch = (status: number) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push({ url: request.url, key: request.headers.get("x-api-key") });
      return new Response("{}", { status });
    }) as typeof fetch;

  assert.deepEqual(await validateKey(KEY, fakeFetch(200)), { ok: true });
  assert.equal(seen[0]!.url, "https://api.anthropic.com/v1/models?limit=1");
  assert.equal(seen[0]!.key, KEY);
  const invalid = await validateKey(KEY, fakeFetch(401));
  assert.equal(invalid.ok, false);
  assert.equal(!invalid.ok && invalid.reason, "invalid");
  const server = await validateKey(KEY, fakeFetch(500));
  assert.equal(!server.ok && server.reason, "error");
  const offline = await validateKey(KEY, (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch);
  assert.equal(!offline.ok && offline.reason, "error");
});

test("fileStore：沒有檔案時 read 回傳 null、remove 回傳 false", () => {
  const store = fileStore(join(mkdtempSync(join(tmpdir(), "use-api-store-")), "none.env"));
  assert.equal(store.read(), null);
  assert.equal(store.remove(), false);
});

test("ai-call 與 use-api 讀同一個預設金鑰檔（有沒有設 XDG_CONFIG_HOME 都一樣）", () => {
  for (const env of [{}, { XDG_CONFIG_HOME: "/tmp/xdg-test" }] as NodeJS.ProcessEnv[]) {
    assert.equal(defaultKeyPath(env), keyFilePath("anthropic", env));
  }
  assert.equal(defaultKeyPath({ XDG_CONFIG_HOME: "/tmp/xdg-test" }), "/tmp/xdg-test/api-chat/anthropic.env");
  assert.equal(defaultKeyPath({ API_CHAT_KEY_FILE: "/k.env" }), "/k.env");
});
