import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { person, when, type Message } from "./types.ts";

export function Reader({ threadId, onChanged }: { threadId: string; onChanged: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");

  useEffect(() => {
    let cancel = false;
    api<{ messages: Message[] }>(`/v1/threads/${encodeURIComponent(threadId)}`)
      .then((body) => {
        if (!cancel) setMessages(body.messages);
      })
      .catch((err: unknown) => {
        if (!cancel) setError(err instanceof Error ? err.message : "Could not open the thread");
      });
    return () => {
      cancel = true;
    };
  }, [threadId]);

  const latest = messages[messages.length - 1];
  const summary = messages.map((message) => message.summary).find(Boolean);
  const actions = messages.flatMap((message) => message.actionItems ?? []);
  const phish = messages.find((message) => (message.ai?.phishingScore ?? 0) >= 40);

  async function archive() {
    if (!latest) return;
    await api(`/v1/messages/${latest.id}/archive`, { method: "POST" });
    onChanged();
    window.location.hash = "#/inbox";
  }

  async function addLabel() {
    if (!latest || !label.trim()) return;
    const labels = [...new Set([...latest.labels, label.trim().toLowerCase()])];
    await api(`/v1/messages/${latest.id}/labels`, { method: "POST", body: JSON.stringify({ labels }) });
    setLabel("");
    onChanged();
    const body = await api<{ messages: Message[] }>(`/v1/threads/${encodeURIComponent(threadId)}`);
    setMessages(body.messages);
  }

  if (error) return <p className="error">{error}</p>;
  if (!latest) return <p className="empty">Opening…</p>;

  return (
    <>
      <header>
        <h2>{latest.subject}</h2>
        <a className="back" href="#/inbox">Back</a>
      </header>
      {summary ? (
        <div className="summary">
          <strong>Summary</strong>
          <p>{summary}</p>
          {actions.length > 0 ? (
            <ul>
              {actions.map((item) => (
                <li key={item.text}>
                  {item.text}
                  {item.deadline ? ` · ${item.deadline}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {phish ? (
        <div className="warn">
          Phishing score {phish.ai?.phishingScore}. {phish.phishingReasons?.join(" ")}
        </div>
      ) : null}
      {messages.map((message) => (
        <article className="message" key={message.id}>
          <strong>{person(message.from)}</strong>
          <div className="muted">{when(message.date)} · {message.from.email}</div>
          {message.pgpEncrypted ? <div className="chip">OpenPGP</div> : null}
          <pre>{message.locked ? "Locked. Unlock the mailbox to read the body." : message.text}</pre>
        </article>
      ))}
      <div className="actions">
        <a className="primary" href={`#/compose?reply=${latest.id}`} style={{ textDecoration: "none", borderRadius: 999, padding: "8px 14px" }}>
          Draft reply
        </a>
        <button className="ghost" type="button" onClick={() => void archive()}>Archive</button>
        <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Add a label" style={{ width: 160 }} />
        <button className="ghost" type="button" onClick={() => void addLabel()}>Label</button>
      </div>
    </>
  );
}
