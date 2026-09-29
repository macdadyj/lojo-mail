import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { Compose } from "./Compose.tsx";
import { Reader } from "./Reader.tsx";
import { Search } from "./Search.tsx";
import { Settings } from "./Settings.tsx";
import { person, when, type DraftRow, type Message } from "./types.ts";

type Tab = "inbox" | "triage" | "drafts" | "search" | "settings" | "compose";

function parseHash(): { tab: Tab; id?: string } {
  const hash = window.location.hash.replace(/^#\/?/, "");
  const path = hash.split("?")[0] ?? "";
  const [tab, id] = path.split("/");
  switch (tab) {
    case "triage":
    case "drafts":
    case "search":
    case "settings":
    case "compose":
    case "thread":
      return tab === "thread" ? { tab: "inbox", id } : { tab, id };
    default:
      return { tab: "inbox" };
  }
}

export function App() {
  const [route, setRoute] = useState(parseHash);
  const [messages, setMessages] = useState<Message[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | undefined>(route.tab === "inbox" ? route.id : undefined);

  useEffect(() => {
    const onHash = () => {
      const next = parseHash();
      setRoute(next);
      if (next.tab === "inbox") setThreadId(next.id);
      else setThreadId(undefined);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  async function load() {
    setError(null);
    try {
      if (route.tab === "drafts") {
        const body = await api<{ drafts: DraftRow[] }>("/v1/drafts");
        setDrafts(body.drafts);
        return;
      }
      const path = route.tab === "triage" ? "/v1/triage" : "/v1/inbox";
      const body = await api<{ messages: Message[] }>(path);
      setMessages(body.messages);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load mail");
    }
  }

  useEffect(() => {
    if (route.tab === "search" || route.tab === "settings") return;
    void load();
  }, [route.tab]);

  const pane = threadId || route.tab === "compose" || route.tab === "settings" || route.tab === "search" ? "reader" : "list";

  return (
    <div className="app" data-pane={pane}>
      <nav className="rail">
        <p className="mark">Lojo</p>
        <a className={route.tab === "inbox" ? "active" : ""} href="#/inbox">Inbox</a>
        <a className={route.tab === "triage" ? "active" : ""} href="#/triage">Triage</a>
        <a className={route.tab === "drafts" ? "active" : ""} href="#/drafts">Drafts</a>
        <a className={route.tab === "search" ? "active" : ""} href="#/search">Search</a>
        <a className={route.tab === "settings" ? "active" : ""} href="#/settings">Settings</a>
        <a href="#/compose">Write</a>
      </nav>
      <section className="list">
        <header>
          <h1>{route.tab === "triage" || route.tab === "drafts" ? title(route.tab) : "Inbox"}</h1>
          <span className="muted">{route.tab === "drafts" ? drafts.length : messages.length}</span>
        </header>
        {error ? <p className="error">{error}</p> : null}
        {route.tab === "drafts" ? (
          <div className="rows">
            {drafts.length === 0 ? <p className="empty">No drafts yet.</p> : null}
            {drafts.map((row) => (
              <a className="row" key={row.draft.id} href={`#/compose/${row.draft.id}`}>
                <strong>{row.draft.to[0]?.email ?? "Draft"}</strong>
                <div className="subject">{row.draft.subject}</div>
                <div className="meta">
                  <span className="chip">{row.draft.status}</span>
                  {row.draft.aiGenerated ? <span className="chip">suggested</span> : null}
                </div>
              </a>
            ))}
          </div>
        ) : (
          <div className="rows">
            {messages.length === 0 ? <p className="empty">Nothing here.</p> : null}
            {messages.map((message) => (
              <a
                className={threadId === message.threadId ? "row active" : "row"}
                key={message.id}
                href={`#/thread/${message.threadId}`}
                onClick={() => setThreadId(message.threadId)}
              >
                <strong>{person(message.from)}</strong>
                <div className="subject">{message.subject}</div>
                <div className="snippet">{message.summary || message.snippet}</div>
                <div className="meta">
                  <span className="muted">{when(message.date)}</span>
                  {message.ai ? <span className={`chip ${message.ai.priority}`}>{message.ai.priority}</span> : null}
                  {message.bulk ? <span className="chip bulk">bulk</span> : null}
                  {message.labels.map((label) => (
                    <span className="chip" key={label}>{label}</span>
                  ))}
                </div>
              </a>
            ))}
          </div>
        )}
      </section>
      <section className="reader">
        {route.tab === "search" ? <Search /> : null}
        {route.tab === "settings" ? <Settings /> : null}
        {route.tab === "compose" ? <Compose draftId={route.id} /> : null}
        {route.tab !== "search" && route.tab !== "settings" && route.tab !== "compose" ? (
          threadId ? (
            <Reader threadId={threadId} onChanged={() => void load()} />
          ) : (
            <p className="empty">Select a message.</p>
          )
        ) : null}
      </section>
    </div>
  );
}

function title(tab: Tab): string {
  switch (tab) {
    case "inbox":
      return "Inbox";
    case "triage":
      return "Triage";
    case "drafts":
      return "Drafts";
    case "search":
      return "Search";
    case "settings":
      return "Settings";
    case "compose":
      return "Write";
    default: {
      const unexpected: never = tab;
      return unexpected;
    }
  }
}
