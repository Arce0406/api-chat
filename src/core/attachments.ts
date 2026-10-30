// 附檔的種類判斷與大小限制（純函式，讀檔在 ui 層）。

import type { AttachmentKind } from "./chat.ts";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export const LIMITS: Record<AttachmentKind, number> = {
  image: 5 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  text: 1024 * 1024,
};

/** 一則訊息所有附檔加起來的上限（API 單次請求上限 32 MB，base64 會再變大約 1/3） */
export const MESSAGE_TOTAL_LIMIT = 20 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "xml", "html", "htm", "css",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp",
  "cs", "php", "sh", "bash", "zsh", "ps1", "bat", "sql", "ini", "cfg", "conf", "log", "env", "vue", "svelte", "srt", "vtt",
]);

export type Classified = { ok: true; kind: AttachmentKind; mediaType: string } | { ok: false; reason: string };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function classifyFile(name: string, mimeType: string, size: number): Classified {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  let kind: AttachmentKind | null = null;
  let mediaType = mimeType;
  if ((IMAGE_TYPES as readonly string[]).includes(mimeType)) {
    kind = "image";
  } else if (mimeType === "application/pdf" || ext === "pdf") {
    kind = "pdf";
    mediaType = "application/pdf";
  } else if (mimeType.startsWith("text/") || TEXT_EXTENSIONS.has(ext)) {
    kind = "text";
    mediaType = mimeType || "text/plain";
  }
  if (!kind) {
    return { ok: false, reason: `「${name}」的格式不支援。可以附文字檔、圖片（PNG、JPEG、GIF、WebP）或 PDF。` };
  }
  if (size > LIMITS[kind]) {
    return { ok: false, reason: `「${name}」太大（${formatBytes(size)}），${kindLabel(kind)}最多 ${formatBytes(LIMITS[kind])}。` };
  }
  return { ok: true, kind, mediaType };
}

export function kindLabel(kind: AttachmentKind): string {
  return kind === "image" ? "圖片" : kind === "pdf" ? "PDF" : "文字檔";
}

/** 文字檔用嚴格的 UTF-8 解碼，解不開就當成二進位檔拒絕 */
export function decodeText(name: string, bytes: Uint8Array): { ok: true; text: string } | { ok: false; reason: string } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\u0000")) throw new Error("binary");
    return { ok: true, text };
  } catch {
    return { ok: false, reason: `「${name}」不是 UTF-8 文字檔，無法讀取。` };
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
