import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { person, when, type ActionItem, type AttachmentMeta, type Message } from "./types.ts";
import { downloadAttachment, onKeyChange, openMessage } from "./unlock.ts";

function uniqueItems(items: ActionItem[]): ActionItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.text.trim().toLowerCase()}|${item.deadline ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function Reader({ threadId, onChanged }: { threadId: string; onChanged: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");

  async function fetchThread(): Promise<Message[]> {
    const body = await api<{ messages: Message[] }>(`/v1/threads/${encodeURIComponent(threadId)}`);
    return Promise.all(body.messages.map((message) => openMessage(message)));
  }

  useEffect(() => {
    let cancel = false;
    const load = () => {
      setError(null);
      fetchThread()
        .then((opened) => {
          if (!cancel) setMessages(opened);
        })
        .catch((err: unknown) => {
          if (!cancel) setError(err instanceof Error ? err.message : "Could not open the thread");
        });
    };
    load();
    // Locking drops the decrypted bodies from the page; unlocking opens them.
    const unsubscribe = onKeyChange(() => {
      setMessages([]);
      load();
    });
    return () => {
      cancel = true;
      unsubscribe();
    };
  }, [threadId]);

  const latest = messages[messages.length - 1];
  const title = messages[0]?.subject ?? latest?.subject;
  const summary = messages.map((message) => message.summary).find(Boolean);
  const actions = uniqueItems(messages.flatMap((message) => message.actionItems ?? []));
  const phish = messages.find((message) => (message.ai?.phishingScore ?? 0) >= 40);

  async function archive() {
    const inbox = messages.filter((message) => message.folder === "inbox");
    const targets = inbox.length > 0 ? inbox : latest ? [latest] : [];
    await Promise.all(targets.map((message) => api(`/v1/messages/${message.id}/archive`, { method: "POST" })));
    onChanged();
    window.location.hash = "#/inbox";
  }

  async function addLabel() {
    const next = label.trim().toLowerCase();
    if (!next || messages.length === 0) return;
    await Promise.all(
      messages.map((message) => {
        const labels = [...new Set([...message.labels, next])];
        return api(`/v1/messages/${message.id}/labels`, { method: "POST", body: JSON.stringify({ labels }) });
      }),
    );
    setLabel("");
    onChanged();
    setMessages(await fetchThread());
  }

  async function download(message: Message, attachment: AttachmentMeta) {
    setError(null);
    try {
      await downloadAttachment(message.id, attachment);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    }
  }

  if (!latest) return error ? <p className="error">{error}</p> : <p className="empty">Opening…</p>;
  const replyTo = [...messages].reverse().find((message) => message.origin !== "sent") ?? latest;

  return (
    <>
      <header>
        <h2>{title}</h2>
        <a className="back" href="#/inbox">Back</a>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {summary ? (
        <div className="summary">
          <strong>Summary</strong>
          <p>{summary}</p>
          {actions.length > 0 ? (
            <ul>
              {actions.map((item) => (
                <li key={`${item.text}|${item.deadline ?? ""}`}>
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
          <pre>
            {message.locked
              ? "Locked. Unlock the envelope key in Settings, or with Unlock in the menu, to read this message in this browser."
              : message.text}
          </pre>
          {message.attachments.length > 0 ? (
            <ul className="attachments">
              {message.attachments.map((attachment) => (
                <li key={attachment.id}>
                  <button className="ghost" type="button" onClick={() => void download(message, attachment)}>
                    {attachment.filename || "attachment"}
                  </button>
                  <span className="muted">{size(attachment.size)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </article>
      ))}
      <div className="actions">
        <a className="button primary" href={`#/compose?reply=${encodeURIComponent(replyTo.id)}`}>
          Draft reply
        </a>
        <button className="ghost" type="button" onClick={() => void archive()}>Archive</button>
        <input className="label-input" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Add a label" />
        <button className="ghost" type="button" onClick={() => void addLabel()}>Label</button>
      </div>
    </>
  );
}
