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
  /** 重新產生中：畫面先藏起舊的最後一則回覆 */
  replacesLast: boolean;
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
  // 串流結束時要拿「最新」的對話（期間可能被改名、換設定或刪除），所以清單同步存一份在 ref
  const conversationsRef = useRef<Conversation[]>([]);
  const pendingIdRef = useRef<string | null>(null);

  const replaceConversations = useCallback((next: Conversation[]) => {
    conversationsRef.current = next;
    setConversations(next);
  }, []);

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
        replaceConversations(convs);
        setTemplates(tpls.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")));
        setUsage(records);
        setPrefs(preferences);
        setDraft((d) => ({ ...d, model: preferences.lastModel ?? d.model, effort: preferences.lastEffort ?? d.effort }));
        setApiKey(key);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [replaceConversations]);

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
      replaceConversations([conversation, ...conversationsRef.current.filter((c) => c.id !== conversation.id)]);
      await db?.putConversation(conversation);
    },
    [db, replaceConversations],
  );

  /**
   * 送出請求並把回覆存進對話。
   * - requestMessages：這次送給 API 的訊息（重新產生時不含最後一則回覆）。
   * - replacesLast：重新產生。成功才取代舊回覆；失敗或停止都保留舊回覆。
   */
  const runReply = useCallback(
    async (conversation: Conversation, requestMessages: ChatMessage[], replacesLast: boolean) => {
      if (!db || !apiKey) return;
      const id = conversation.id;
      const controller = new AbortController();
      controllerRef.current = controller;
      pendingIdRef.current = id;
      setErrors(({ [id]: _, ...rest }) => rest);
      setPending({ conversationId: id, text: "", replacesLast });

      // 逐字更新畫面，但每個畫格最多更新一次
      let buffer = "";
      let frame = 0;
      const flush = () => {
        frame = 0;
        setPending({ conversationId: id, text: buffer, replacesLast });
      };
      const stopFrames = () => {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
      };
      const recordUsage = async (record: Omit<UsageRecord, "id" | "at" | "conversationId">) => {
        const full: UsageRecord = { id: newId(), at: Date.now(), conversationId: id, ...record };
        setUsage((list) => [...list, full]);
        await db.addUsage(full);
      };
      /** 用最新的對話（保留期間的改名、設定）接上回覆；對話已被刪除就不存 */
      const commit = async (reply: ChatMessage) => {
        const latest = conversationsRef.current.find((c) => c.id === id);
        if (!latest) return;
        await saveConversation({ ...latest, messages: [...requestMessages, reply], updatedAt: Date.now() });
      };

      try {
        const result = await streamReply({
          apiKey,
          model: conversation.model,
          effort: conversation.effort,
          system: conversation.system,
          messages: toApiMessages(requestMessages),
          signal: controller.signal,
          onText: (delta) => {
            buffer += delta;
            if (!frame) frame = requestAnimationFrame(flush);
          },
        });
        const cost = costUsd(result.usage);
        // 和加入回覆放在同一次畫面更新，避免回覆短暫出現兩次
        stopFrames();
        setPending(null);
        await commit({
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
        });
        await recordUsage({ model: conversation.model, usage: result.usage, costUsd: cost });
      } catch (error) {
        stopFrames();
        setPending(null);
        const aborted = isAbort(error);
        // 停止或中途斷線時拿不到用量，記為「無法計算」；還沒開始就失敗（例如金鑰無效）不收費，不記
        if (aborted || buffer) await recordUsage({ model: conversation.model, usage: [], costUsd: null });
        if (buffer.trim() && !replacesLast) {
          await commit({
            id: newId(),
            role: "assistant",
            text: buffer,
            createdAt: Date.now(),
            meta: { model: conversation.model, usage: [], costUsd: null, ...(aborted ? { stopped: true } : { interrupted: true }) },
          });
        }
        if (!aborted && conversationsRef.current.some((c) => c.id === id)) {
          setErrors((all) => ({ ...all, [id]: describeError(error) }));
        }
      } finally {
        stopFrames();
        controllerRef.current = null;
        pendingIdRef.current = null;
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
      await runReply(conversation, conversation.messages, false);
    },
    [active, draft, runReply, saveConversation],
  );

  /** 重新產生最後一則回覆；最後一則是使用者訊息時（例如上次出錯）就是重試 */
  const regenerate = useCallback(async () => {
    if (!active) return;
    const last = active.messages[active.messages.length - 1];
    const replacesLast = last?.role === "assistant";
    await runReply(active, replacesLast ? active.messages.slice(0, -1) : active.messages, replacesLast);
  }, [active, runReply]);

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
      // 正在回覆的對話被刪掉：先停止，回覆結束時也不會再寫回去
      if (pendingIdRef.current === id) controllerRef.current?.abort();
      replaceConversations(conversationsRef.current.filter((c) => c.id !== id));
      if (activeId === id) setActiveId(null);
      await db?.deleteConversation(id);
    },
    [activeId, db, replaceConversations],
  );

  if (loadError) {
    return (
      <div className="center-screen">
        <div className="card">
          <h1>API Chat 無法啟動</h1>
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
          pendingReplacesLast={pending?.replacesLast ?? false}
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

