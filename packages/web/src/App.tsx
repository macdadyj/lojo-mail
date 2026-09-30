import { useEffect, useState } from "react";
import { api, sessionToken, signOut, SIGNED_OUT_EVENT } from "./api.ts";
import { Compose } from "./Compose.tsx";
import { Login } from "./Login.tsx";
import { Reader } from "./Reader.tsx";
import { Search } from "./Search.tsx";
import { Settings } from "./Settings.tsx";
import { person, statusLabel, when, type DraftView, type Message } from "./types.ts";

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
  const [signedIn, setSignedIn] = useState(() => sessionToken() !== null);

  useEffect(() => {
    const onSignedOut = () => setSignedIn(false);
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, []);

  if (!signedIn) return <Login onSignedIn={() => setSignedIn(true)} />;
  return <Mail />;
}

function Mail() {
  const [route, setRoute] = useState(parseHash);
  const [messages, setMessages] = useState<Message[]>([]);
  const [drafts, setDrafts] = useState<DraftView[]>([]);
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
        const body = await api<{ drafts: DraftView[] }>("/v1/drafts");
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
  const waiting = drafts.filter((row) => row.draft.status === "pending_approval");
  const open = drafts.filter((row) => row.draft.status === "suggested" || row.draft.status === "edited");

  return (
    <div className="app" data-pane={pane}>
      <nav className="rail">
        <p className="mark">Lojo</p>
        <a className={route.tab === "inbox" ? "active" : ""} href="#/inbox">Inbox</a>
        <a className={route.tab === "triage" ? "active" : ""} href="#/triage">Triage</a>
        <a className={route.tab === "drafts" ? "active" : ""} href="#/drafts">Drafts</a>
        <a className={route.tab === "search" ? "active" : ""} href="#/search">Search</a>
        <a className={route.tab === "settings" ? "active" : ""} href="#/settings">Settings</a>
        <a className={route.tab === "compose" ? "active" : ""} href="#/compose">Write</a>
        <button type="button" onClick={() => signOut()}>Sign out</button>
      </nav>
      <section className="list">
        <header>
          <h1>{route.tab === "triage" || route.tab === "drafts" ? title(route.tab) : "Inbox"}</h1>
          <span className="muted">{route.tab === "drafts" ? waiting.length + open.length : messages.length}</span>
        </header>
        {error ? <p className="error">{error}</p> : null}
        {route.tab === "drafts" ? (
          <div className="rows">
            {waiting.length > 0 ? <h3 className="group">Waiting for your approval</h3> : null}
            {waiting.map((row) => (
              <DraftRow key={row.draft.id} row={row} />
            ))}
            {waiting.length > 0 && open.length > 0 ? <h3 className="group">Drafts</h3> : null}
            {open.map((row) => (
              <DraftRow key={row.draft.id} row={row} />
            ))}
            {waiting.length + open.length === 0 ? <p className="empty">No drafts yet.</p> : null}
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
                  {message.labels
                    .filter((label) => label !== "bulk" || !message.bulk)
                    .map((label) => (
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
        {route.tab === "compose" ? <Compose key={route.id ?? window.location.hash} draftId={route.id} /> : null}
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

function DraftRow({ row }: { row: DraftView }) {
  const { draft } = row;
  return (
    <a className="row" href={`#/compose/${draft.id}`}>
      <strong>{draft.to[0]?.email ?? "Draft"}</strong>
      <div className="subject">{draft.subject}</div>
      <div className="meta">
        <span className="muted">{when(draft.updatedAt)}</span>
        <span className={draft.status === "pending_approval" ? "chip now" : "chip"}>{statusLabel(draft.status)}</span>
        {draft.origin === "ai" ? <span className="chip">AI</span> : null}
        {draft.origin === "agent" ? <span className="chip">assistant</span> : null}
      </div>
    </a>
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
