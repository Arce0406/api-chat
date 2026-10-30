// AI 回覆的 Markdown 轉 HTML。回覆內容不可信（可能被附檔裡的文字誘導），所以：
// - 回覆裡的原始 HTML 一律當純文字顯示；
// - 不載入外部圖片（圖片網址可能把對話內容帶出去），改成顯示連結文字；
// - 連結只允許 http(s)／mailto，點擊由畫面攔下來用系統瀏覽器開；
// - 最後再過一次 DOMPurify。

import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked, type Tokens } from "marked";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeHref(href: string): string | null {
  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    image({ href, text }: Tokens.Image) {
      const label = text || href;
      const safe = safeHref(href);
      return safe
        ? `<a href="${escapeHtml(safe)}" data-external="1" class="blocked-image">[圖片：${escapeHtml(label)}]</a>`
        : `<span class="blocked-image">[圖片：${escapeHtml(label)}]</span>`;
    },
    link({ href, tokens }: Tokens.Link) {
      const inner = this.parser.parseInline(tokens);
      const safe = safeHref(href);
      return safe ? `<a href="${escapeHtml(safe)}" data-external="1" title="${escapeHtml(safe)}">${inner}</a>` : inner;
    },
    code({ text, lang }: Tokens.Code) {
      const language = (lang ?? "").trim().split(/\s+/)[0] ?? "";
      let highlighted: string;
      try {
        highlighted = language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : hljs.highlightAuto(text).value;
      } catch {
        highlighted = escapeHtml(text);
      }
      return `<div class="code-block"><div class="code-head"><span>${escapeHtml(language || "程式碼")}</span><button type="button" class="copy-code">複製</button></div><pre><code class="hljs">${highlighted}</code></pre></div>`;
    },
  },
});

export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false });
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
    FORBID_TAGS: ["img", "style", "form", "input", "iframe", "object", "embed", "svg", "math"],
    ADD_ATTR: ["data-external"],
  });
}
