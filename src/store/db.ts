// 對話、角色範本、用量紀錄、偏好設定，存在本機（App 的網頁畫面所屬的 IndexedDB）。
// 金鑰不存在這裡，見 platform/。

import type { Conversation, Effort, RoleTemplate, UsageRecord } from "../core/chat.ts";

const DB_NAME = "api-chat";
const DB_VERSION = 1;

export type ThemeSetting = "system" | "light" | "dark";

export interface Preferences {
  theme: ThemeSetting;
  /** 新對話預設沿用上次選的模型與思考深度 */
  lastModel: string | null;
  lastEffort: Effort | null;
}

export const DEFAULT_PREFERENCES: Preferences = { theme: "system", lastModel: null, lastEffort: null };

type StoreName = "conversations" | "templates" | "usage" | "preferences";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class ChatDb {
  private constructor(private readonly db: IDBDatabase) {}

  static open(name: string = DB_NAME): Promise<ChatDb> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("conversations", { keyPath: "id" });
        db.createObjectStore("templates", { keyPath: "id" });
        db.createObjectStore("usage", { keyPath: "id" });
        db.createObjectStore("preferences");
      };
      req.onsuccess = () => resolve(new ChatDb(req.result));
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("資料庫被另一個視窗占用，請關掉其他視窗後重開。"));
    });
  }

  private store(name: StoreName, mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(name, mode).objectStore(name);
  }

  listConversations(): Promise<Conversation[]> {
    return request(this.store("conversations", "readonly").getAll() as IDBRequest<Conversation[]>);
  }

  async putConversation(conversation: Conversation): Promise<void> {
    await request(this.store("conversations", "readwrite").put(conversation));
  }

  async deleteConversation(id: string): Promise<void> {
    await request(this.store("conversations", "readwrite").delete(id));
  }

  listTemplates(): Promise<RoleTemplate[]> {
    return request(this.store("templates", "readonly").getAll() as IDBRequest<RoleTemplate[]>);
  }

  async putTemplate(template: RoleTemplate): Promise<void> {
    await request(this.store("templates", "readwrite").put(template));
  }

  async deleteTemplate(id: string): Promise<void> {
    await request(this.store("templates", "readwrite").delete(id));
  }

  /** 用量紀錄和對話分開存：刪掉對話後，當月花費仍然正確 */
  listUsage(): Promise<UsageRecord[]> {
    return request(this.store("usage", "readonly").getAll() as IDBRequest<UsageRecord[]>);
  }

  async addUsage(record: UsageRecord): Promise<void> {
    await request(this.store("usage", "readwrite").put(record));
  }

  async getPreferences(): Promise<Preferences> {
    const value = (await request(this.store("preferences", "readonly").get("main"))) as Partial<Preferences> | undefined;
    return { ...DEFAULT_PREFERENCES, ...(value ?? {}) };
  }

  async putPreferences(preferences: Preferences): Promise<void> {
    await request(this.store("preferences", "readwrite").put(preferences, "main"));
  }
}
