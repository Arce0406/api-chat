import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { estimateRequestBytes, formatBytes, kindLabel, REQUEST_LIMIT } from "../core/attachments.ts";
import { EFFORT_CHOICES, modelLabel, supportsEffort, type ModelChoice } from "../core/catalog.ts";
import { exportFileName, exportMarkdown, formatUsd, totalTokens, type Attachment, type ChatMessage, type Conversation, type Effort, type RoleTemplate } from "../core/chat.ts";
import { platform } from "../platform/index.ts";
import { readAttachments } from "./files.ts";
import { renderMarkdown } from "./markdown.ts";

export interface ChatSettings {
  model: string;
  effort: Effort;
  system: string;
  templateId: string | null;
}

interface Props {
  conversation: Conversation | null;
  settings: ChatSettings;
  onSettings: (next: ChatSettings) => void;
  templates: RoleTemplate[];
  models: ModelChoice[];
  pendingText: string | null;
  pendingReplacesLast: boolean;
  busyElsewhere: boolean;
  error: string | null;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onRegenerate: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onManageTemplates: () => void;
}

const CUSTOM = "__custom__";
const NONE = "__none__";

export function ChatView(props: Props) {
  const { conversation, settings, pendingText } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const allMessages = conversation?.messages ?? [];
  // 重新產生中先藏起舊回覆；成功才會被取代，失敗或停止就再出現
  const hideLast = pendingText !== null && props.pendingReplacesLast && allMessages[allMessages.length - 1]?.role === "assistant";
  const messages = hideLast ? allMessages.slice(0, -1) : allMessages;

  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, pendingText]);

  const lastAssistantIndex = messages.map((m) => m.role).lastIndexOf("assistant");
  const streaming = pendingText !== null;
  const lastIsUser = messages[messages.length - 1]?.role === "user";

  return (
    <main className="chat">
      <Header {...props} />
      <div
        className="messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        onClick={handleMessageClick}
      >
        {messages.length === 0 && !streaming ? <EmptyState settings={settings} templates={props.templates} /> : null}
        {messages.map((message, index) =>
          message.role === "user" ? (
            <UserMessage key={message.id} message={message} />
          ) : (
            <AssistantMessage key={message.id} message={message} canRegenerate={index === lastAssistantIndex && !streaming && !props.busyElsewhere} onRegenerate={props.onRegenerate} />
          ),
        )}
        {streaming ? <StreamingMessage text={pendingText} model={settings.model} /> : null}
        {props.error ? (
          <div className="error-box" role="alert">
            <span>{props.error}</span>
            {lastIsUser ? (
              <button type="button" className="btn" onClick={props.onRegenerate}>
                重試
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <Composer streaming={streaming} busyElsewhere={props.busyElsewhere} historyBytes={estimateRequestBytes(allMessages)} onSend={props.onSend} onStop={props.onStop} />
    </main>
  );
}

/** 回覆裡的連結用系統瀏覽器開；程式碼區塊的「複製」 */
function handleMessageClick(event: MouseEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement;
  const copy = target.closest("button.copy-code");
  if (copy) {
    const code = copy.closest(".code-block")?.querySelector("code")?.textContent ?? "";
    void copyText(code, copy as HTMLButtonElement);
    return;
  }
  const link = target.closest("a[data-external]") as HTMLAnchorElement | null;
  if (link) {
    event.preventDefault();
    platform.openExternal(link.href);
  }
}

async function copyText(text: string, button: HTMLButtonElement) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "已複製";
  } catch {
    button.textContent = "複製失敗";
  }
  setTimeout(() => (button.textContent = original), 1500);
}

function Header(props: Props) {
  const { conversation, settings, onSettings, templates } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [title, setTitle] = useState(conversation?.title ?? "");
  const [editingSystem, setEditingSystem] = useState(false);
  const effortOk = supportsEffort(settings.model);

  const roleValue = settings.templateId ?? (settings.system.trim() ? CUSTOM : NONE);
  const templateMissing = settings.templateId !== null && !templates.some((t) => t.id === settings.templateId);

  return (
    <header className="chat-header">
      <div className="chat-title">
        {renaming && conversation ? (
          <form
            className="rename"
            onSubmit={(e) => {
              e.preventDefault();
              const next = title.trim();
              if (next) props.onRename(next);
              setRenaming(false);
            }}
          >
            <input id="rename-input" aria-label="對話名稱" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} onBlur={() => setRenaming(false)} />
          </form>
        ) : (
          <h1>{conversation?.title ?? "新對話"}</h1>
        )}
      </div>
      <div className="chat-controls">
        <label className="select">
          <span>模型</span>
          <select id="model-select" value={settings.model} onChange={(e) => onSettings({ ...settings, model: e.target.value })}>
            {props.models.map((m) => (
              <option key={m.id} value={m.id} title={m.hint}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="select" title={effortOk ? "想得越久越準，但比較慢、比較貴" : "這個模型不支援調整思考深度"}>
          <span>思考</span>
          <select id="effort-select" value={settings.effort} disabled={!effortOk} onChange={(e) => onSettings({ ...settings, effort: e.target.value as Effort })}>
            {EFFORT_CHOICES.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
        <label className="select">
          <span>角色</span>
          <select
            id="role-select"
            value={templateMissing ? CUSTOM : roleValue}
            onChange={(e) => {
              const value = e.target.value;
              if (value === NONE) onSettings({ ...settings, system: "", templateId: null });
              else if (value === CUSTOM) setEditingSystem(true);
              else {
                const template = templates.find((t) => t.id === value);
                if (template) onSettings({ ...settings, system: template.prompt, templateId: template.id });
              }
            }}
          >
            <option value={NONE}>預設</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
            <option value={CUSTOM}>{settings.system.trim() && (settings.templateId === null || templateMissing) ? "自訂（這段對話）" : "自訂…"}</option>
          </select>
        </label>
        {conversation ? (
          <div className="menu-wrap">
            <button type="button" className="btn ghost" aria-label="更多動作" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
              ⋯
            </button>
            {menuOpen ? (
              <div className="menu" role="menu" onMouseLeave={() => setMenuOpen(false)}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setTitle(conversation.title);
                    setRenaming(true);
                    setMenuOpen(false);
                  }}
                >
                  改名
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void platform.saveTextFile(exportFileName(conversation.title), exportMarkdown(conversation, modelLabel));
                  }}
                >
                  匯出 Markdown
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    setConfirmDelete(true);
                    setMenuOpen(false);
                  }}
                >
                  刪除
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {confirmDelete ? (
        <div className="confirm-bar" role="alertdialog" aria-label="確認刪除">
          <span>刪除「{conversation?.title}」？刪除後無法復原。</span>
          <button type="button" className="btn danger" onClick={() => props.onDelete()}>
            刪除
          </button>
          <button type="button" className="btn ghost" onClick={() => setConfirmDelete(false)}>
            取消
          </button>
        </div>
      ) : null}
      {editingSystem ? (
        <SystemEditor
          initial={settings.system}
          onCancel={() => setEditingSystem(false)}
          onSave={(system) => {
            onSettings({ ...settings, system, templateId: null });
            setEditingSystem(false);
          }}
          onManage={props.onManageTemplates}
        />
      ) : null}
    </header>
  );
}

function SystemEditor(props: { initial: string; onSave: (value: string) => void; onCancel: () => void; onManage: () => void }) {
  const [value, setValue] = useState(props.initial);
  return (
    <div className="system-editor">
      <label htmlFor="system-input">這段對話的角色設定（例如「你是專業的英文編輯，回答用繁體中文」）</label>
      <textarea id="system-input" rows={4} value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      <div className="row">
        <button type="button" className="btn" onClick={() => props.onSave(value.trim())}>
          套用
        </button>
        <button type="button" className="btn ghost" onClick={props.onCancel}>
          取消
        </button>
        <span className="grow" />
        <button type="button" className="link-button" onClick={props.onManage}>
          管理常用角色範本
        </button>
      </div>
    </div>
  );
}

function EmptyState({ settings, templates }: { settings: ChatSettings; templates: RoleTemplate[] }) {
  const template = templates.find((t) => t.id === settings.templateId);
  return (
    <div className="empty">
      <p className="empty-title">要問什麼？</p>
      <p className="muted">
        使用 {modelLabel(settings.model)}
        {template ? `，角色「${template.name}」` : settings.system.trim() ? "，自訂角色" : ""}。可以附文字檔、圖片或 PDF，也可以直接把圖片貼上或拖進來。
      </p>
    </div>
  );
}

function AttachmentChips({ attachments, onRemove }: { attachments: Attachment[]; onRemove?: (id: string) => void }) {
  return (
    <ul className="chips">
      {attachments.map((a) => (
        <li key={a.id} className="chip" title={`${kindLabel(a.kind)}，${formatBytes(a.size)}`}>
          {a.kind === "image" ? <img className="thumb" alt="" src={`data:${a.mediaType};base64,${a.data}`} /> : <span className="chip-kind">{a.kind === "pdf" ? "PDF" : "TXT"}</span>}
          <span className="chip-name">{a.name}</span>
          {onRemove ? (
            <button type="button" className="chip-remove" aria-label={`移除 ${a.name}`} onClick={() => onRemove(a.id)}>
              ×
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="msg user" data-testid="user-message">
      {message.attachments?.length ? <AttachmentChips attachments={message.attachments} /> : null}
      {message.text ? <div className="user-text">{message.text}</div> : null}
    </div>
  );
}

function AssistantMessage({ message, canRegenerate, onRegenerate }: { message: ChatMessage; canRegenerate: boolean; onRegenerate: () => void }) {
  const html = useMemo(() => renderMarkdown(message.text), [message.text]);
  const meta = message.meta;
  const tokens = meta ? totalTokens(meta.usage) : null;
  return (
    <div className="msg assistant" data-testid="assistant-message">
      <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
      {meta?.stopped ? <p className="note">已停止。這次的費用無法計算（仍會計入你的 Anthropic 帳單）。</p> : null}
      {meta?.interrupted ? <p className="note">回覆中斷，只收到這些內容。這次的費用無法計算。</p> : null}
      {meta?.stopReason === "max_tokens" ? <p className="note">回覆太長被截斷了，可以請它「繼續」。</p> : null}
      {meta?.stopReason === "refusal" ? <p className="note">模型拒絕回答這個問題。這一問和這則回覆不會帶進之後的對話。</p> : null}
      {meta?.fallbackUsed ? <p className="note">原模型拒答，這則改由 {modelLabel(meta.servedModel ?? "")} 回答。</p> : null}
      <div className="meta">
        {meta ? <span>{modelLabel(meta.servedModel ?? meta.model)}</span> : null}
        {tokens && meta && !meta.stopped ? (
          <span>
            輸入 {tokens.input.toLocaleString()}／輸出 {tokens.output.toLocaleString()} tokens
          </span>
        ) : null}
        {meta && !meta.stopped ? <span data-testid="reply-cost">{formatUsd(meta.costUsd)}</span> : null}
        <button type="button" className="btn ghost small" onClick={(e) => void copyText(message.text, e.currentTarget)}>
          複製
        </button>
        {canRegenerate ? (
          <button type="button" className="btn ghost small" onClick={onRegenerate}>
            重新產生
          </button>
        ) : null}
      </div>
    </div>
  );
}

function StreamingMessage({ text, model }: { text: string; model: string }) {
  // 串流中每個畫格都會重畫，先不做程式碼高亮，完成後再高亮
  const html = useMemo(() => renderMarkdown(text, { highlight: false }), [text]);
  return (
    <div className="msg assistant streaming" data-testid="streaming-message" aria-live="polite">
      {text ? <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} /> : <p className="muted">{modelLabel(model)} 思考中…</p>}
    </div>
  );
}

function Composer(props: { streaming: boolean; busyElsewhere: boolean; historyBytes: number; onSend: (text: string, attachments: Attachment[]) => void; onStop: () => void }) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  // 讀檔、縮圖要一點時間；這段期間不能送出，否則附檔會被漏掉
  const [reading, setReading] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const canSend = !props.streaming && !props.busyElsewhere && reading === 0 && (text.trim().length > 0 || attachments.length > 0);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  async function addFiles(files: File[]) {
    if (files.length === 0) return;
    setReading((n) => n + 1);
    try {
      const { added, errors } = await readAttachments(files, attachments);
      setAttachments((list) => [...list, ...added]);
      setProblems(errors);
    } finally {
      setReading((n) => n - 1);
    }
  }

  function submit() {
    if (!canSend) return;
    // 每次都會重送整段對話（含之前的附檔），總量超過 API 單次上限就整段對話都送不出去
    const total = props.historyBytes + estimateRequestBytes([{ id: "", role: "user", text, attachments, createdAt: 0 }]);
    if (total > REQUEST_LIMIT) {
      setProblems([`這段對話的附檔加起來太大（約 ${formatBytes(total)}，上限 ${formatBytes(REQUEST_LIMIT)}）。請開新對話再附檔，或移除部分附檔。`]);
      return;
    }
    props.onSend(text.trim(), attachments);
    setText("");
    setAttachments([]);
    setProblems([]);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // 中文輸入法選字時按 Enter 不送出
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      submit();
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.files];
    if (files.length) {
      event.preventDefault();
      void addFiles(files);
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void addFiles([...event.dataTransfer.files]);
  }

  return (
    <div
      className={`composer${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {attachments.length ? <AttachmentChips attachments={attachments} onRemove={(id) => setAttachments((list) => list.filter((a) => a.id !== id))} /> : null}
      {problems.map((p) => (
        <p key={p} className="problem" role="alert">
          {p}
        </p>
      ))}
      <textarea
        id="composer-input"
        ref={textRef}
        rows={2}
        value={text}
        placeholder={props.busyElsewhere ? "另一段對話正在回覆，等它完成再送出" : "輸入訊息…（Enter 送出，Shift+Enter 換行）"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        aria-label="訊息"
      />
      <div className="row">
        <button type="button" className="btn ghost" onClick={() => fileRef.current?.click()} disabled={props.streaming}>
          附檔
        </button>
        <input
          ref={fileRef}
          id="file-input"
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void addFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <span className="grow muted small">{reading ? "讀取附檔中…" : "文字檔、圖片、PDF"}</span>
        {props.streaming ? (
          <button type="button" className="btn primary" onClick={props.onStop}>
            停止
          </button>
        ) : (
          <button type="button" className="btn primary" onClick={submit} disabled={!canSend}>
            送出
          </button>
        )}
      </div>
    </div>
  );
}
