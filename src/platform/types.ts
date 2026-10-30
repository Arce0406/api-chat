// 桌面版（Tauri）和瀏覽器開發版不同的部分。介面只透過這裡取用。

export interface KeyStore {
  /** 沒設定時回傳 null */
  get(): Promise<string | null>;
  set(key: string): Promise<void>;
  remove(): Promise<void>;
  /** 給設定頁說明金鑰存在哪裡 */
  readonly description: string;
}

export interface Platform {
  readonly kind: "browser" | "desktop";
  keyStore: KeyStore;
  /** 讓使用者把文字存成檔案（匯出 Markdown） */
  saveTextFile(fileName: string, content: string): Promise<void>;
  /** 用系統瀏覽器開外部連結，不在 App 視窗裡換頁 */
  openExternal(url: string): void;
}
