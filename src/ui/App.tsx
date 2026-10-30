import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeError, isAbort, streamReply } from "../api/claude.ts";
import { DEFAULT_EFFORT, DEFAULT_MODEL_ID, MODEL_CHOICES } from "../core/catalog.ts";
import {
  deriveTitle,
  matchesSearch,
  monthSummary,
  newId,
  toApiMessages,
  type Attachment,
  type ChatMessage,
  type Conversation,
  type RoleTemplate,
  type UsageRecord,
} from "../core/chat.ts";
import { costUsd } from "../core/models.ts";
import { platform } from "../platform/index.ts";
import { ChatDb, DEFAULT_PREFERENCES, type Preferences } from "../store/db.ts";
import { ChatView, type ChatSettings } from "./ChatView.tsx";
import { Onboarding } from "./Onboarding.tsx";
import { Settings, type SettingsTab } from "./Settings.tsx";
import { Sidebar } from "./Sidebar.tsx";

interface Pending {
  conversationId: string;
  text: string;
}

export function App() {
  const [db, setDb] = useState<ChatDb | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null | undefined>(undefined);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [templates, setTemplates] = useState<RoleTemplate[]>([]);
  const [usage, setUsage] = useState<UsageRecord[]>([]);
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ChatSettings>({ model: DEFAULT_MODEL_ID, effort: DEFAULT_EFFORT, system: "", templateId: null });
  const [query, setQuery] = useState("");
  const [view, setView] = useState<{ kind: "chat" } | { kind: "settings"; tab: SettingsTab }>({ kind: "chat" });
  const [pending, setPending] = useState<Pending | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const opened = await ChatDb.open();
        const [convs, tpls, records, preferences, key] = await Promise.all([
          opened.listConversations(),
          opened.listTemplates(),
          opened.listUsage(),
          opened.getPreferences(),
          platform.keyStore.get(),
        ]);
        setDb(opened);
        setConversations(convs);
        setTemplates(tpls.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")));
        setUsage(records);
        setPrefs(preferences);
        setDraft((d) => ({ ...d, model: preferences.lastModel ?? d.model, effort: preferences.lastEffort ?? d.effort }));
        setApiKey(key);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (prefs.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", prefs.theme);
  }, [prefs.theme]);

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const filtered = useMemo(() => conversations.filter((c) => matchesSearch(c, query)), [conversations, query]);
  const month = useMemo(() => monthSummary(usage), [usage]);

  const savePrefs = useCallback(
    async (next: Preferences) => {
      setPrefs(next);
      await db?.putPreferences(next);
    },
    [db],
  );

  const saveConversation = useCallback(
    async (conversation: Conversation) => {
      setConversations((list) => [conversation, ...list.filter((c) => c.id !== conversation.id)]);
      await db?.putConversation(conversation);
    },
    [db],
  );

  const runReply = useCallback(
    async (conversation: Conversation) => {
      if (!db || !apiKey) return;
      const controller = new AbortController();
      controllerRef.current = controller;
      setErrors(({ [conversation.id]: _, ...rest }) => rest);
      setPending({ conversationId: conversation.id, text: "" });

      // 逐字更新畫面，但每個畫格最多更新一次
      let buffer = "";
      let frame = 0;
      const flush = () => {
        frame = 0;
        setPending({ conversationId: conversation.id, text: buffer });
      };

      try {
        const result = await streamReply({
          apiKey,
          model: conversation.model,
          effort: conversation.effort,
          system: conversation.system,
          messages: toApiMessages(conversation.messages),
          signal: controller.signal,
          onText: (delta) => {
            buffer += delta;
            if (!frame) frame = requestAnimationFrame(flush);
          },
        });
        const cost = costUsd(result.usage);
        const reply: ChatMessage = {
          id: newId(),
          role: "assistant",
          text: result.text,
          createdAt: Date.now(),
          meta: {
            model: conversation.model,
            servedModel: result.servedModel,
            usage: result.usage,
            costUsd: cost,
            stopReason: result.stopReason,
            fallbackUsed: result.fallbackUsed,
          },
        };
        const record: UsageRecord = { id: newId(), at: Date.now(), conversationId: conversation.id, model: conversation.model, usage: result.usage, costUsd: cost };
        // 和加入回覆放在同一次畫面更新，避免回覆短暫出現兩次
        setPending(null);
        await saveConversation({ ...conversation, messages: [...conversation.messages, reply], updatedAt: Date.now() });
        setUsage((list) => [...list, record]);
        await db.addUsage(record);
      } catch (error) {
        if (isAbort(error)) {
          // 停止時拿不到用量；有收到文字就保留，費用記為「無法計算」
          const record: UsageRecord = { id: newId(), at: Date.now(), conversationId: conversation.id, model: conversation.model, usage: [], costUsd: null };
          setUsage((list) => [...list, record]);
          await db.addUsage(record);
          setPending(null);
          if (buffer.trim()) {
            const partial: ChatMessage = {
              id: newId(),
              role: "assistant",
              text: buffer,
              createdAt: Date.now(),
              meta: { model: conversation.model, usage: [], costUsd: null, stopped: true },
            };
            await saveConversation({ ...conversation, messages: [...conversation.messages, partial], updatedAt: Date.now() });
          }
        } else {
          setErrors((all) => ({ ...all, [conversation.id]: describeError(error) }));
        }
      } finally {
        if (frame) cancelAnimationFrame(frame);
        controllerRef.current = null;
        setPending(null);
      }
    },
    [apiKey, db, saveConversation],
  );

  const send = useCallback(
    async (text: string, attachments: Attachment[]) => {
      const now = Date.now();
      const message: ChatMessage = { id: newId(), role: "user", text, createdAt: now, ...(attachments.length ? { attachments } : {}) };
      let conversation: Conversation;
      if (active) {
        conversation = { ...active, messages: [...active.messages, message], updatedAt: now };
      } else {
        conversation = {
          id: newId(),
          title: deriveTitle(text, attachments),
          model: draft.model,
          effort: draft.effort,
          system: draft.system,
          templateId: draft.templateId,
          messages: [message],
          createdAt: now,
          updatedAt: now,
        };
        setActiveId(conversation.id);
      }
      await saveConversation(conversation);
      await runReply(conversation);
    },
    [active, draft, runReply, saveConversation],
  );

  const regenerate = useCallback(async () => {
    if (!active) return;
    const last = active.messages[active.messages.length - 1];
    const messages = last?.role === "assistant" ? active.messages.slice(0, -1) : active.messages;
    const conversation = { ...active, messages, updatedAt: Date.now() };
    await saveConversation(conversation);
    await runReply(conversation);
  }, [active, runReply, saveConversation]);

  const changeSettings = useCallback(
    async (next: ChatSettings) => {
      await savePrefs({ ...prefs, lastModel: next.model, lastEffort: next.effort });
      if (active) await saveConversation({ ...active, ...next });
      else setDraft(next);
    },
    [active, prefs, saveConversation, savePrefs],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      setConversations((list) => list.filter((c) => c.id !== id));
      if (activeId === id) setActiveId(null);
      await db?.deleteConversation(id);
    },
    [activeId, db],
  );

  if (loadError) {
    return (
      <div className="center-screen">
        <div className="card">
          <h1>無法開啟本機資料</h1>
          <p className="muted">{loadError}</p>
        </div>
      </div>
    );
  }
  if (apiKey === undefined || !db) return <div className="center-screen muted">載入中…</div>;
  if (apiKey === null) return <Onboarding onSaved={setApiKey} />;

  const settings: ChatSettings = active ? { model: active.model, effort: active.effort, system: active.system, templateId: active.templateId } : draft;
  const busyElsewhere = pending !== null && pending.conversationId !== activeId;

  return (
    <div className="app">
      <Sidebar
        conversations={filtered}
        activeId={view.kind === "chat" ? activeId : null}
        query={query}
        onQuery={setQuery}
        onNew={() => {
          setActiveId(null);
          setView({ kind: "chat" });
        }}
        onSelect={(id) => {
          setActiveId(id);
          setView({ kind: "chat" });
        }}
        monthUsd={month.totalUsd}
        monthUnknown={month.unknown}
        onSettings={() => setView({ kind: "settings", tab: "key" })}
        settingsOpen={view.kind === "settings"}
      />
      {view.kind === "settings" ? (
        <Settings
          tab={view.tab}
          onTab={(tab) => setView({ kind: "settings", tab })}
          onClose={() => setView({ kind: "chat" })}
          apiKey={apiKey}
          onKeyChanged={setApiKey}
          templates={templates}
          onSaveTemplate={async (template) => {
            setTemplates((list) => [...list.filter((t) => t.id !== template.id), template].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")));
            await db.putTemplate(template);
          }}
          onDeleteTemplate={async (id) => {
            setTemplates((list) => list.filter((t) => t.id !== id));
            await db.deleteTemplate(id);
          }}
          usage={usage}
          prefs={prefs}
          onPrefs={savePrefs}
        />
      ) : (
        <ChatView
          key={activeId ?? "new"}
          conversation={active}
          settings={settings}
          onSettings={changeSettings}
          templates={templates}
          models={MODEL_CHOICES}
          pendingText={pending && pending.conversationId === activeId ? pending.text : null}
          busyElsewhere={busyElsewhere}
          error={activeId ? (errors[activeId] ?? null) : null}
          onSend={send}
          onStop={() => controllerRef.current?.abort()}
          onRegenerate={regenerate}
          onRename={async (title) => {
            if (active) await saveConversation({ ...active, title });
          }}
          onDelete={async () => {
            if (active) await deleteConversation(active.id);
          }}
          onManageTemplates={() => setView({ kind: "settings", tab: "templates" })}
        />
      )}
    </div>
  );
}

