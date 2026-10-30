// 把使用者選的檔案讀成附檔。

import { classifyFile, decodeText, MESSAGE_TOTAL_LIMIT, formatBytes, toBase64 } from "../core/attachments.ts";
import { newId, type Attachment } from "../core/chat.ts";

export async function readAttachments(files: File[], existing: Attachment[]): Promise<{ added: Attachment[]; errors: string[] }> {
  const added: Attachment[] = [];
  const errors: string[] = [];
  let total = existing.reduce((sum, a) => sum + a.size, 0);
  for (const file of files) {
    const classified = classifyFile(file.name, file.type, file.size);
    if (!classified.ok) {
      errors.push(classified.reason);
      continue;
    }
    if (total + file.size > MESSAGE_TOTAL_LIMIT) {
      errors.push(`附檔加起來超過 ${formatBytes(MESSAGE_TOTAL_LIMIT)}，「${file.name}」沒有加入。`);
      continue;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let data: string;
    if (classified.kind === "text") {
      const decoded = decodeText(file.name, bytes);
      if (!decoded.ok) {
        errors.push(decoded.reason);
        continue;
      }
      data = decoded.text;
    } else {
      data = toBase64(bytes);
    }
    total += file.size;
    added.push({ id: newId(), name: file.name || "貼上的圖片.png", kind: classified.kind, mediaType: classified.mediaType, size: file.size, data });
  }
  return { added, errors };
}

export function maskKey(key: string): string {
  if (key.length <= 16) return "••••";
  return `${key.slice(0, 10)}…${key.slice(-4)}`;
}
