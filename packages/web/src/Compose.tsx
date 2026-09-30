import { useEffect, useState } from "react";
import { ApiError, api } from "./api.ts";
import { RECHECK_DELAY_MS, authorNotice, changedFields, type Fields } from "./review.ts";
import { statusLabel, type Draft, type DraftView, type Message } from "./types.ts";
import { openMessage } from "./unlock.ts";

class DraftConflict extends Error {
  constructor(readonly changed: string[]) {
    super("This draft changed after you opened it. Nothing was approved or sent. The current version is shown now.");
  }
}

const EMPTY: Fields = { to: "", cc: "", subject: "", text: "", pgp: "auto" };

function list(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function fieldsOf(view: DraftView): Fields {
  return {
    to: view.draft.to.map((item) => item.email).join(", "),
    cc: view.draft.cc.map((item) => item.email).join(", "),
    subject: view.draft.subject,
    text: view.text ?? "",
    pgp: view.draft.pgp,
  };
}

function same(a: Fields, b: Fields): boolean {
  return a.to === b.to && a.cc === b.cc && a.subject === b.subject && a.text === b.text && a.pgp === b.pgp;
}

function payloadOf(fields: Fields) {
  return { to: list(fields.to), cc: list(fields.cc), subject: fields.subject, text: fields.text, pgp: fields.pgp };
}

export function Compose({ draftId }: { draftId?: string }) {
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [saved, setSaved] = useState<Fields | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [instruction, setInstruction] = useState("Make it shorter.");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ changed: string[]; armed: boolean } | null>(null);

  useEffect(() => {
    if (!conflict || conflict.armed) return;
    const timer = window.setTimeout(() => setConflict((current) => (current ? { ...current, armed: true } : current)), RECHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [conflict]);

  function show(view: DraftView) {
    const next = fieldsOf(view);
    setDraft(view.draft);
    setFields(next);
    setSaved(next);
  }

  useEffect(() => {
    setConflict(null);
    if (draftId) {
      api<DraftView>(`/v1/drafts/${encodeURIComponent(draftId)}?text=1`)
        .then(show)
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not open the draft"));
      return;
    }
    const reply = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("reply");
    if (!reply) return;
    setBusy(true);
    draftReply(reply)
      .then((view) => {
        show(view);
        window.history.replaceState(null, "", `#/compose/${view.draft.id}`);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not draft a reply"))
      .finally(() => setBusy(false));
  }, [draftId]);

  function set<K extends keyof Fields>(name: K, value: Fields[K]) {
    setFields((current) => ({ ...current, [name]: value }));
  }

  async function save(): Promise<string> {
    if (draft && saved && same(fields, saved)) return draft.id;
    const payload = JSON.stringify(payloadOf(fields));
    const view = draft
      ? await api<DraftView>(`/v1/drafts/${draft.id}`, { method: "POST", body: payload })
      : await api<DraftView>("/v1/drafts", { method: "POST", body: payload });
    show(view);
    return view.draft.id;
  }

  async function run(label: string, action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await action();
    } catch (err) {
      if (err instanceof DraftConflict) return;
      setError(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setBusy(false);
    }
  }

  const saveDraft = () =>
    run("Save", async () => {
      await save();
      setStatus("Saved. Nothing is sent until you approve.");
    });

  const rewrite = () =>
    run("Rewrite", async () => {
      const id = await save();
      show(await api<DraftView>(`/v1/drafts/${id}/rewrite`, { method: "POST", body: JSON.stringify({ instruction }) }));
      setStatus("Rewritten. Still a draft.");
    });

  async function approve(id: string, reviewed: Fields): Promise<string> {
    try {
      const minted = await api<{ approvalToken: string }>(`/v1/drafts/${id}/approval`, { method: "POST", body: JSON.stringify(payloadOf(reviewed)) });
      return minted.approvalToken;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 409) throw err;
      const current = await api<DraftView>(`/v1/drafts/${id}?text=1`);
      show(current);
      throw new DraftConflict(changedFields(reviewed, fieldsOf(current)));
    }
  }

  const approveAndSend = () =>
    run("Send", async () => {
      if (conflict && !conflict.armed) return;
      const reviewed = fields;
      const id = await save();
      let approvalToken: string;
      try {
        approvalToken = await approve(id, reviewed);
      } catch (err) {
        if (err instanceof DraftConflict) setConflict({ changed: err.changed, armed: false });
        throw err;
      }
      setConflict(null);
      const sent = await api<{ messageId: string }>(`/v1/drafts/${id}/approve-and-send`, {
        method: "POST",
        body: JSON.stringify({ approvalToken }),
      });
      show(await api<DraftView>(`/v1/drafts/${id}?text=1`));
      setStatus(`Sent (${sent.messageId}).`);
    });

  const discard = () =>
    run("Discard", async () => {
      if (!draft) return;
      await api(`/v1/drafts/${draft.id}/discard`, { method: "POST" });
      window.location.hash = "#/drafts";
    });

  const closed = draft?.status === "sent" || draft?.status === "sending" || draft?.status === "discarded";

  return (
    <form className="panel" onSubmit={(event) => event.preventDefault()}>
      <header>
        <h2>Write</h2>
        <a className="back" href="#/inbox">Back</a>
      </header>
      {draft ? (
        <div className="meta">
          <span className={draft.status === "pending_approval" ? "chip now" : "chip"}>{statusLabel(draft.status)}</span>
          {draft.origin === "ai" ? <span className="chip">AI</span> : null}
          {draft.origin === "agent" ? <span className="chip">assistant</span> : null}
        </div>
      ) : null}
      {draft && authorNotice(draft) ? <p className="notice">{authorNotice(draft)}</p> : null}
      {conflict ? (
        <div className="notice warn" role="alert">
          <p>
            This draft changed after you opened it. Nothing was approved or sent.
            {conflict.changed.length > 0 ? ` Changed: ${conflict.changed.join(", ")}.` : ""} Read the current version below
            before you approve it.
          </p>
        </div>
      ) : null}
      <label htmlFor="to">To</label>
      <input id="to" value={fields.to} disabled={closed} onChange={(event) => set("to", event.target.value)} placeholder="ada@example.com" />
      <label htmlFor="cc">Cc</label>
      <input id="cc" value={fields.cc} disabled={closed} onChange={(event) => set("cc", event.target.value)} />
      <label htmlFor="subject">Subject</label>
      <input id="subject" value={fields.subject} disabled={closed} onChange={(event) => set("subject", event.target.value)} />
      <label htmlFor="body">Message</label>
      <textarea id="body" value={fields.text} disabled={closed} onChange={(event) => set("text", event.target.value)} />
      <label htmlFor="pgp">Encryption</label>
      <select id="pgp" value={fields.pgp} disabled={closed} onChange={(event) => set("pgp", event.target.value === "off" ? "off" : "auto")}>
        <option value="auto">OpenPGP when every recipient has a key</option>
        <option value="off">Off: send unencrypted</option>
      </select>
      {fields.pgp === "off" ? (
        <p className="muted">Encryption is off. This goes out in plain text, even to recipients who have an OpenPGP key.</p>
      ) : null}
      <label htmlFor="instruction">Rewrite instruction</label>
      <input id="instruction" value={instruction} disabled={closed} onChange={(event) => setInstruction(event.target.value)} />
      <div className="actions flush">
        <button className="ghost" type="button" disabled={busy || closed} onClick={() => void rewrite()}>Rewrite</button>
        <button className="ghost" type="button" disabled={busy || closed} onClick={() => void saveDraft()}>Save draft</button>
        {draft ? (
          <button className="ghost" type="button" disabled={busy || closed} onClick={() => void discard()}>Discard</button>
        ) : null}
        <button className="primary" type="button" disabled={busy || closed || (conflict !== null && !conflict.armed)} onClick={() => void approveAndSend()}>
          {conflict ? (conflict.armed ? "Approve this version and send" : "Read the changes first…") : "Approve and send"}
        </button>
      </div>
      <p className="muted">
        Approve and send saves this draft and asks the API for a one-time approval bound to exactly the recipients,
        subject, text, and encryption shown here, then sends. If anything changed since you opened the draft, nothing is
        approved and the current version is shown instead. Assistants can't do this step.
      </p>
      {status ? <p className="muted">{status}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}

/** When the server can't read the body, the browser opens it and sends the text along. */
async function draftReply(messageId: string): Promise<DraftView> {
  const message = await api<Message>(`/v1/messages/${encodeURIComponent(messageId)}`);
  const sourceText = message.locked ? (await openMessage(message)).text : undefined;
  return api<DraftView>(`/v1/messages/${encodeURIComponent(messageId)}/draft-reply`, {
    method: "POST",
    body: JSON.stringify(sourceText !== undefined ? { sourceText } : {}),
  });
}
