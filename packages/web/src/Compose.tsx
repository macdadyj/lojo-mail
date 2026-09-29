import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { DraftRow, Message } from "./types.ts";
import { openDraftText, openMessage } from "./unlock.ts";

export function Compose({ draftId }: { draftId?: string }) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [id, setId] = useState(draftId);
  const [instruction, setInstruction] = useState("Make it shorter.");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
    const reply = params.get("reply");
    if (!reply) return;
    api<DraftRow["draft"]>(`/v1/messages/${reply}/draft-reply`, { method: "POST" })
      .then(async (draft) => {
        setId(draft.id);
        setSubject(draft.subject);
        setTo(draft.to.map((item) => item.email).join(", "));
        const rows = await api<{ drafts: DraftRow[] }>("/v1/drafts");
        const row = rows.drafts.find((item) => item.draft.id === draft.id);
        setText(row ? ((await openDraftText(row)) ?? "") : "");
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not draft a reply"));
  }, []);

  useEffect(() => {
    if (!draftId) return;
    api<{ drafts: DraftRow[] }>("/v1/drafts")
      .then(async (body) => {
        const row = body.drafts.find((item) => item.draft.id === draftId);
        if (!row) return;
        setId(row.draft.id);
        setSubject(row.draft.subject);
        setTo(row.draft.to.map((item) => item.email).join(", "));
        setText((await openDraftText(row)) ?? "");
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not open the draft"));
  }, [draftId]);

  async function ensureDraft(): Promise<string> {
    if (id) return id;
    const created = await api<{ id: string }>("/v1/drafts", {
      method: "POST",
      body: JSON.stringify({
        to: to.split(",").map((item) => item.trim()).filter(Boolean),
        subject,
        text,
      }),
    });
    setId(created.id);
    return created.id;
  }

  async function rewrite() {
    setError(null);
    try {
      const draft = await ensureDraft();
      const updated = await api<{ text: string }>(`/v1/drafts/${draft}/rewrite`, {
        method: "POST",
        body: JSON.stringify({ instruction }),
      });
      setText(updated.text);
      setStatus("Rewritten. Still a draft.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rewrite failed");
    }
  }

  async function send() {
    setError(null);
    try {
      const draft = await ensureDraft();
      await api(`/v1/drafts/${draft}`, { method: "POST", body: JSON.stringify({ text }) });
      const sent = await api<{ messageId: string }>(`/v1/drafts/${draft}/approve-and-send`, { method: "POST" });
      setStatus(`Sent ${sent.messageId}. Nothing is mailed until this step.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
    }
  }

  return (
    <form
      className="panel"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <header>
        <h2>Write</h2>
        <a className="back" href="#/inbox">Back</a>
      </header>
      <p className="muted">A draft is not mail. Sending asks the API, which checks the send scope.</p>
      <label htmlFor="to">To</label>
      <input id="to" value={to} onChange={(event) => setTo(event.target.value)} placeholder="ada@example.com" />
      <label htmlFor="subject">Subject</label>
      <input id="subject" value={subject} onChange={(event) => setSubject(event.target.value)} />
      <label htmlFor="body">Message</label>
      <textarea id="body" value={text} onChange={(event) => setText(event.target.value)} />
      <label htmlFor="instruction">Rewrite instruction</label>
      <input id="instruction" value={instruction} onChange={(event) => setInstruction(event.target.value)} />
      <div className="actions" style={{ padding: "16px 0 0" }}>
        <button className="ghost" type="button" onClick={() => void rewrite()}>Rewrite</button>
        <button className="primary" type="submit">Approve and send</button>
      </div>
      {status ? <p className="muted">{status}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      <ReplyHint />
    </form>
  );
}

function ReplyHint() {
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
    const reply = params.get("reply");
    if (!reply) return;
    api<Message>(`/v1/messages/${reply}`)
      .then((message) => openMessage(message))
      .then((message) => setHint(message.subject))
      .catch(() => setHint(null));
  }, []);
  if (!hint) return null;
  return <p className="muted">Replying in “{hint}”.</p>;
}
