import { groupConversations, formatUsd, type Conversation } from "../core/chat.ts";

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  query: string;
  onQuery: (q: string) => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  monthUsd: number;
  monthUnknown: number;
  onSettings: () => void;
  settingsOpen: boolean;
}

export function Sidebar(props: Props) {
  const groups = groupConversations(props.conversations);
  return (
    <aside className="sidebar">
      <div className="brand">API Chat</div>
      <button type="button" className="btn primary block" onClick={props.onNew}>
        ＋ 新對話
      </button>
      <input id="search-input" type="search" placeholder="搜尋對話…" aria-label="搜尋對話" value={props.query} onChange={(e) => props.onQuery(e.target.value)} />
      <nav className="conv-list" aria-label="對話列表">
        {groups.length === 0 ? <p className="muted small">{props.query ? "找不到符合的對話" : "還沒有對話"}</p> : null}
        {groups.map(({ group, items }) => (
          <section key={group}>
            <h2 className="group-label">{group}</h2>
            <ul>
              {items.map((c) => (
                <li key={c.id}>
                  <button type="button" className={`conv-item${c.id === props.activeId ? " active" : ""}`} aria-current={c.id === props.activeId ? "true" : undefined} onClick={() => props.onSelect(c.id)} title={c.title}>
                    {c.title}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>
      <div className="sidebar-foot">
        <div className="month" data-testid="month-cost">
          本月花費 {formatUsd(props.monthUsd)}
          {props.monthUnknown ? <span className="muted small">（另有 {props.monthUnknown} 次無法計算）</span> : null}
        </div>
        <button type="button" className={`btn ghost block${props.settingsOpen ? " active" : ""}`} onClick={props.onSettings}>
          設定
        </button>
      </div>
    </aside>
  );
}
