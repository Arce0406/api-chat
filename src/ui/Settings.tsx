import { useEffect, useState } from "react";
import { formatUsd, monthSummary, newId, type RoleTemplate, type UsageRecord } from "../core/chat.ts";
import { PRICES_UPDATED_AT } from "../core/models.ts";
import { platform } from "../platform/index.ts";
import type { Preferences, ThemeSetting } from "../store/db.ts";
import { maskKey } from "./files.ts";
import { KeyForm } from "./KeyForm.tsx";

export type SettingsTab = "key" | "cli" | "templates" | "usage" | "appearance";

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "key", label: "API 金鑰" },
  { id: "cli", label: "讓其他 AI 使用" },
  { id: "templates", label: "角色範本" },
  { id: "usage", label: "用量" },
  { id: "appearance", label: "外觀" },
];

interface Props {
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  onClose: () => void;
  apiKey: string;
  onKeyChanged: (key: string | null) => void;
  templates: RoleTemplate[];
  onSaveTemplate: (template: RoleTemplate) => Promise<void>;
  onDeleteTemplate: (id: string) => Promise<void>;
  usage: UsageRecord[];
  prefs: Preferences;
  onPrefs: (prefs: Preferences) => Promise<void>;
}

export function Settings(props: Props) {
  return (
    <main className="settings">
      <header className="settings-header">
        <h1>設定</h1>
        <button type="button" className="btn ghost" onClick={props.onClose}>
          回到對話
        </button>
      </header>
      <div className="settings-body">
        <nav className="tabs" aria-label="設定分類" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={props.tab === t.id} className={`tab${props.tab === t.id ? " active" : ""}`} onClick={() => props.onTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <section className="pane" role="tabpanel">
          {props.tab === "key" ? <KeyPane {...props} /> : null}
          {props.tab === "cli" ? <CliPane /> : null}
          {props.tab === "templates" ? <TemplatesPane {...props} /> : null}
          {props.tab === "usage" ? <UsagePane usage={props.usage} /> : null}
          {props.tab === "appearance" ? <AppearancePane {...props} /> : null}
        </section>
      </div>
    </main>
  );
}

function KeyPane({ apiKey, onKeyChanged }: Props) {
  const [mode, setMode] = useState<"view" | "replace" | "confirm-remove">("view");
  const [error, setError] = useState<string | null>(null);
  const [location, setLocation] = useState<string | null>(null);
  useEffect(() => {
    platform.keyStore.location?.().then(setLocation, () => setLocation(null));
  }, []);
  return (
    <div className="stack">
      <h2>API 金鑰</h2>
      <div className="kv">
        <span>Anthropic</span>
        <code data-testid="masked-key">{maskKey(apiKey)}</code>
        <span className="row">
          <button type="button" className="btn ghost" onClick={() => setMode("replace")}>
            更換
          </button>
          <button type="button" className="btn ghost danger" onClick={() => setMode("confirm-remove")}>
            刪除
          </button>
        </span>
      </div>
      <p className="muted small">{platform.keyStore.description} OpenAI、Gemini 之後再加。</p>
      {location ? (
        <p className="muted small">
          存放位置：<code data-testid="key-location">{location}</code>
        </p>
      ) : null}
      {mode === "replace" ? (
        <KeyForm
          submitLabel="驗證並更換"
          onSaved={(key) => {
            setMode("view");
            onKeyChanged(key);
          }}
        />
      ) : null}
      {mode === "confirm-remove" ? (
        <div className="confirm-bar" role="alertdialog" aria-label="確認刪除金鑰">
          <span>從這台電腦刪除金鑰？對話紀錄會保留，之後要重新輸入金鑰才能對話。</span>
          <button
            type="button"
            className="btn danger"
            onClick={async () => {
              try {
                await platform.keyStore.remove();
                onKeyChanged(null);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            刪除金鑰
          </button>
          <button type="button" className="btn ghost" onClick={() => setMode("view")}>
            取消
          </button>
        </div>
      ) : null}
      {error ? <p className="problem">{error}</p> : null}
    </div>
  );
}

function CliPane() {
  const desktop = platform.kind === "desktop";
  return (
    <div className="stack">
      <h2>讓其他 AI 使用（命令列工具）</h2>
      <p className="muted">安裝後，Claude Code 之類的 AI 工具就能在終端機呼叫這些指令，費用一樣記在你的 API 金鑰。需要先在電腦上安裝 Node.js 22 以上。</p>
      <table className="tools">
        <tbody>
          <tr>
            <td>
              <code>ai-call</code>
            </td>
            <td>讓 AI 把簡單的工作派給便宜的模型</td>
          </tr>
          <tr>
            <td>
              <code>use-api</code>
            </td>
            <td>訂閱額度用完時，改用 API 金鑰接續 Claude Code 的對話</td>
          </tr>
          <tr>
            <td>Claude Code 說明檔</td>
            <td>讓 Claude Code 知道什麼時候該用 ai-call</td>
          </tr>
        </tbody>
      </table>
      <p className="note">{desktop ? "Windows、macOS 的安裝功能下一版加入；Linux 可以照 GitHub 上的 README 手動安裝。" : "瀏覽器開發版不能安裝命令列工具。"}</p>
    </div>
  );
}

function TemplatesPane({ templates, onSaveTemplate, onDeleteTemplate }: Props) {
  const [editing, setEditing] = useState<RoleTemplate | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  return (
    <div className="stack">
      <h2>角色範本</h2>
      <p className="muted">常用的角色設定（system prompt）存成範本，在對話上方的「角色」選單選用。改範本不會影響已經開始的對話。</p>
      {templates.length === 0 && !editing ? <p className="muted">還沒有範本。</p> : null}
      <ul className="template-list">
        {templates.map((t) => (
          <li key={t.id}>
            <div className="template-name">{t.name}</div>
            <div className="template-prompt muted small">{t.prompt}</div>
            <div className="row">
              <button type="button" className="btn ghost small" onClick={() => setEditing(t)}>
                編輯
              </button>
              {confirmId === t.id ? (
                <>
                  <button
                    type="button"
                    className="btn danger small"
                    onClick={async () => {
                      await onDeleteTemplate(t.id);
                      setConfirmId(null);
                    }}
                  >
                    確定刪除
                  </button>
                  <button type="button" className="btn ghost small" onClick={() => setConfirmId(null)}>
                    取消
                  </button>
                </>
              ) : (
                <button type="button" className="btn ghost small danger" onClick={() => setConfirmId(t.id)}>
                  刪除
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {editing ? (
        <TemplateForm
          key={editing.id}
          template={editing}
          onCancel={() => setEditing(null)}
          onSave={async (t) => {
            await onSaveTemplate(t);
            setEditing(null);
          }}
        />
      ) : (
        <button type="button" className="btn" onClick={() => setEditing({ id: newId(), name: "", prompt: "" })}>
          ＋ 新增範本
        </button>
      )}
    </div>
  );
}

function TemplateForm(props: { template: RoleTemplate; onSave: (t: RoleTemplate) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(props.template.name);
  const [prompt, setPrompt] = useState(props.template.prompt);
  const valid = name.trim() && prompt.trim();
  return (
    <form
      className="template-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void props.onSave({ ...props.template, name: name.trim(), prompt: prompt.trim() });
      }}
    >
      <label htmlFor="template-name">名稱</label>
      <input id="template-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：英文編輯" />
      <label htmlFor="template-prompt">角色設定</label>
      <textarea id="template-prompt" rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="例如：你是專業的英文編輯，幫我修改文法並說明原因，說明用繁體中文。" />
      <div className="row">
        <button type="submit" className="btn primary" disabled={!valid}>
          儲存範本
        </button>
        <button type="button" className="btn ghost" onClick={props.onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

function UsagePane({ usage }: { usage: UsageRecord[] }) {
  const now = new Date();
  const summary = monthSummary(usage, now);
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const max = Math.max(0.0001, ...summary.byDay.values());
  return (
    <div className="stack">
      <h2>
        用量（{now.getFullYear()} 年 {now.getMonth() + 1} 月）
      </h2>
      <p className="big" data-testid="usage-total">
        {formatUsd(summary.totalUsd)}
      </p>
      {summary.unknown ? <p className="muted small">另有 {summary.unknown} 次費用無法計算（例如回覆中途停止）。</p> : null}
      <div className="bars" aria-label="每天花費">
        {Array.from({ length: days }, (_, i) => {
          const value = summary.byDay.get(i + 1) ?? 0;
          return (
            <div key={i} className="bar-col" title={`${i + 1} 日：${formatUsd(value)}`}>
              <div className="bar" style={{ height: `${(value / max) * 100}%` }} />
              <span className="bar-label">{(i + 1) % 5 === 1 ? i + 1 : ""}</span>
            </div>
          );
        })}
      </div>
      <p className="muted small">
        只計算這個 App 的對話，依 Anthropic 公布的牌價估算（價格表更新於 {PRICES_UPDATED_AT}）。實際金額以 Claude Console 的帳單為準。
      </p>
    </div>
  );
}

function AppearancePane({ prefs, onPrefs }: Props) {
  const options: Array<{ id: ThemeSetting; label: string }> = [
    { id: "system", label: "跟系統一樣" },
    { id: "light", label: "淺色" },
    { id: "dark", label: "深色" },
  ];
  return (
    <div className="stack">
      <h2>外觀</h2>
      <fieldset className="radio-group">
        <legend>主題</legend>
        {options.map((o) => (
          <label key={o.id}>
            <input type="radio" name="theme" value={o.id} checked={prefs.theme === o.id} onChange={() => void onPrefs({ ...prefs, theme: o.id })} />
            {o.label}
          </label>
        ))}
      </fieldset>
    </div>
  );
}
