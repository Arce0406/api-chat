import { platform } from "../platform/index.ts";
import { KeyForm } from "./KeyForm.tsx";

const CONSOLE_KEYS_URL = "https://platform.claude.com/settings/keys";

export function Onboarding({ onSaved, problem = null }: { onSaved: (key: string) => void; problem?: string | null }) {
  return (
    <div className="center-screen">
      <div className="card onboarding">
        <h1>先設定你的 Anthropic API 金鑰</h1>
        {problem ? (
          <p className="problem" role="alert">
            讀不到原本存的金鑰：{problem}。重新輸入金鑰會覆寫那個檔案。
          </p>
        ) : null}
        <p className="muted">
          到 Claude Console 的「API Keys」建立一把金鑰，貼到下面。費用記在你自己的 Console 帳號，這個 App 不會收費，也不會把金鑰傳到 Anthropic 以外的地方。
        </p>
        <p>
          <a
            href={CONSOLE_KEYS_URL}
            onClick={(e) => {
              e.preventDefault();
              platform.openExternal(CONSOLE_KEYS_URL);
            }}
          >
            開啟 Claude Console
          </a>
        </p>
        <KeyForm onSaved={onSaved} />
        <p className="muted small">按下後會用金鑰向 Anthropic 查一次可用的模型，確認金鑰有效（不花錢）。</p>
      </div>
    </div>
  );
}
