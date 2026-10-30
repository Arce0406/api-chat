// 金鑰存放：使用者資料夾的檔案，和 ai-call、桌面 App 共用。

import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { KEY_VARIABLE as KEY_VARIABLES, keyFilePath, parseEnvFile } from "../shared/key-file.ts";

export { parseEnvFile };

const KEY_VARIABLE = KEY_VARIABLES.anthropic;

export class StoreError extends Error {}

export interface KeyStore {
  /** 給使用者看的存放位置 */
  describe(): string;
  read(): string | null;
  write(key: string): void;
  /** 回傳是否真的刪了東西 */
  remove(): boolean;
}

export function defaultKeyPath(env: NodeJS.ProcessEnv): string {
  return keyFilePath("anthropic", env);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function fileStore(path: string): KeyStore {
  return {
    describe() {
      return isSymlink(path) ? `${path}（連結到 ${readlinkSync(path)}）` : path;
    },

    read() {
      let content: string;
      try {
        content = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new StoreError(`讀不到金鑰檔 ${path}（${(error as NodeJS.ErrnoException).code}），請檢查權限`);
      }
      return parseEnvFile(content)[KEY_VARIABLE] || null;
    },

    write(key) {
      // 連結的目標通常是使用者另外管理的機密檔，不替使用者覆寫
      if (isSymlink(path)) {
        throw new StoreError(`${path} 是連結（指向 ${readlinkSync(path)}），請直接修改原檔`);
      }
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, `${KEY_VARIABLE}=${key}\n`, { mode: 0o600 });
        chmodSync(path, 0o600); // 檔案已存在時 writeFileSync 不會改權限
      } catch (error) {
        throw new StoreError(`無法寫入 ${path}（${(error as NodeJS.ErrnoException).code}），請檢查權限`);
      }
    },

    remove() {
      try {
        lstatSync(path);
      } catch {
        return false;
      }
      unlinkSync(path); // 是連結時只刪連結本身，不動原檔
      return true;
    },
  };
}

/** 顯示用：只露出開頭與最後 4 碼 */
export function maskKey(key: string): string {
  if (key.length <= 16) return "****";
  return `${key.slice(0, 10)}…${key.slice(-4)}`;
}
