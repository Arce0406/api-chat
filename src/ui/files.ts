// 把使用者選的檔案讀成附檔。

import { classifyFile, decodeText, formatBytes, IMAGE_MAX_EDGE, IMAGE_SEND_LIMIT, MESSAGE_TOTAL_LIMIT, toBase64 } from "../core/attachments.ts";
import { newId, type Attachment } from "../core/chat.ts";

export async function readAttachments(files: File[], existing: Attachment[]): Promise<{ added: Attachment[]; errors: string[] }> {
  const added: Attachment[] = [];
  const errors: string[] = [];
  let total = existing.reduce((sum, a) => sum + a.size, 0);
  for (const file of files) {
    const name = file.name || "貼上的圖片.png";
    const classified = classifyFile(name, file.type, file.size);
    if (!classified.ok) {
      errors.push(classified.reason);
      continue;
    }
    let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
    let mediaType = classified.mediaType;
    if (classified.kind === "image") {
      const prepared = await prepareImage(file, bytes, mediaType);
      if (!prepared) {
        errors.push(`「${name}」無法讀取或縮小到 ${formatBytes(IMAGE_SEND_LIMIT)} 以下。`);
        continue;
      }
      ({ bytes, mediaType } = prepared);
    }
    if (total + bytes.length > MESSAGE_TOTAL_LIMIT) {
      errors.push(`附檔加起來超過 ${formatBytes(MESSAGE_TOTAL_LIMIT)}，「${name}」沒有加入。`);
      continue;
    }
    let data: string;
    if (classified.kind === "text") {
      const decoded = decodeText(name, bytes);
      if (!decoded.ok) {
        errors.push(decoded.reason);
        continue;
      }
      data = decoded.text;
    } else {
      data = toBase64(bytes);
    }
    total += bytes.length;
    added.push({ id: newId(), name, kind: classified.kind, mediaType, size: bytes.length, data });
  }
  return { added, errors };
}

/**
 * 太大的圖片縮小成長邊 IMAGE_MAX_EDGE 的 JPEG（透明的地方補白色）。
 * 本來就夠小的圖片原樣送出。
 */
async function prepareImage(file: File, bytes: Uint8Array, mediaType: string): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    if (longEdge <= IMAGE_MAX_EDGE && bytes.length <= IMAGE_SEND_LIMIT) return { bytes, mediaType };
    const scale = Math.min(1, IMAGE_MAX_EDGE / longEdge);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) return null;
    const resized = new Uint8Array(await blob.arrayBuffer());
    return resized.length <= IMAGE_SEND_LIMIT ? { bytes: resized, mediaType: "image/jpeg" } : null;
  } finally {
    bitmap.close();
  }
}

export function maskKey(key: string): string {
  if (key.length <= 16) return "••••";
  return `${key.slice(0, 10)}…${key.slice(-4)}`;
}
