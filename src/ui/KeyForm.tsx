import { useState } from "react";
import { normalizeKey, verifyKey } from "../api/claude.ts";
import { platform } from "../platform/index.ts";

/** 輸入金鑰 → 驗證 → 存起來。首次設定與「更換金鑰」共用 */
export function KeyForm({ onSaved, submitLabel = "驗證並儲存" }: { onSaved: (key: string) => void; submitLabel?: string }) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" } | { kind: "checking" } | { kind: "error"; message: string }>({ kind: "idle" });

  async function submit() {
    const normalized = normalizeKey(value);
    if (!normalized.ok) {
      setStatus({ kind: "error", message: normalized.reason });
      return;
    }
    setStatus({ kind: "checking" });
    const check = await verifyKey(normalized.key);
    if (!check.ok) {
      setStatus({ kind: "error", message: check.reason });
      return;
    }
    try {
      await platform.keyStore.set(normalized.key);
    } catch (error) {
      setStatus({ kind: "error", message: `金鑰有效，但存不進去：${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    setValue("");
    setStatus({ kind: "idle" });
    onSaved(normalized.key);
  }

  return (
    <form
      className="key-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="api-key-input">API 金鑰</label>
      <input
        id="api-key-input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="sk-ant-api03-…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <div className="row">
        <button type="submit" className="btn primary" disabled={status.kind === "checking"}>
          {status.kind === "checking" ? "驗證中…" : submitLabel}
        </button>
        <span className="muted small">{platform.keyStore.description}</span>
      </div>
      {status.kind === "error" ? (
        <p className="problem" role="alert">
          {status.message}
        </p>
      ) : null}
    </form>
  );
}
