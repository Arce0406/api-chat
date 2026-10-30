// 組出送給模型的內容：檔案在前、指示在後（長內容把問題放最後效果較好）。

import { readFileSync } from "node:fs";

export interface InputDocument {
  /** 檔案路徑；從 stdin 讀的是 "-" */
  source: string;
  content: string;
}

export class InputError extends Error {}

export function readDocuments(paths: string[], readStdin: () => string): InputDocument[] {
  const documents: InputDocument[] = [];
  for (const path of paths) {
    let content: string;
    if (path === "-") {
      content = readStdin();
      // Claude Code 的 Bash 工具 stdin 是 /dev/null，讀到空的多半是忘了接管線
      if (!content.trim()) throw new InputError("-f - 從 stdin 讀到空內容，請用管線傳入資料");
    } else {
      let buffer: Buffer;
      try {
        buffer = readFileSync(path);
      } catch (error) {
        throw new InputError(`讀不到檔案 ${path}：${(error as Error).message}`);
      }
      if (buffer.includes(0)) {
        throw new InputError(`${path} 看起來是二進位檔，目前只支援文字檔`);
      }
      content = buffer.toString("utf8");
    }
    documents.push({ source: path, content });
  }
  return documents;
}

export function buildPrompt(documents: InputDocument[], instruction: string): string {
  const parts = documents.map((doc) =>
    doc.source === "-" ? `<stdin>\n${doc.content}\n</stdin>` : `<file path="${doc.source}">\n${doc.content}\n</file>`,
  );
  if (instruction) parts.push(instruction);
  return parts.join("\n\n");
}
