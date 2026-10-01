import { createHash } from "node:crypto";
import type { DraftOrigin, DraftView, MessageView } from "@lojo/core";

/** Drafts Thunderbird can open, edit and send. Sent and discarded drafts leave the Drafts mailbox. */
const OPEN_STATUSES = new Set(["suggested", "edited", "pending_approval"]);

/** A keyword on every draft an assistant or rule wrote, so Jon can tell them apart (and tag them in Thunderbird). */
export const BOT_DRAFT_LABEL = "bot-draft";

/**
 * A keyword on drafts with files attached through the API (the iOS app, a bot). Thunderbird can't
 * show or send those files; send such a draft with Approve in the app or the web app.
 */
export const SERVER_FILES_LABEL = "server-files";

const ENTRY = /^drf:([A-Za-z0-9_-]+):[0-9a-f]+$/;

export interface DraftEntry {
  draftId: string;
  text: string;
}

function botWritten(origin: DraftOrigin): boolean {
  switch (origin) {
    case "agent":
    case "ai":
    case "rule":
      return true;
    case "human":
    case "client":
      return false;
    default: {
      const unexpected: never = origin;
      throw new Error(`Unknown draft origin ${String(unexpected)}`);
    }
  }
}

export function isOpenDraft(view: DraftView): boolean {
  return OPEN_STATUSES.has(view.draft.status);
}

/**
 * IMAP messages never change, so every edit of a draft is a new message: the
 * entry id carries a version and an edited draft gets a new UID.
 */
export function draftEntryId(view: DraftView, text: string): string {
  const version = createHash("sha256").update(`${view.draft.updatedAt}\n${view.draft.status}\n${text}`).digest("hex").slice(0, 16);
  return `drf:${view.draft.id}:${version}`;
}

export function draftIdOf(entryId: string): string | null {
  return ENTRY.exec(entryId)?.[1] ?? null;
}

export function draftMessageView(entryId: string, view: DraftView, text: string, address: string): MessageView {
  const { draft } = view;
  const labels = botWritten(draft.origin) ? [BOT_DRAFT_LABEL] : [];
  if ((draft.attachments ?? []).length > 0) labels.push(SERVER_FILES_LABEL);
  const out: MessageView = {
    id: entryId,
    threadId: draft.threadId ?? draft.id,
    rfcMessageId: draft.clientMessageId ?? `${draft.id}@drafts.lojo-mail.invalid`,
    references: draft.references ?? [],
    folder: "drafts",
    origin: "sent",
    from: { email: address },
    to: draft.to,
    cc: draft.cc,
    subject: draft.subject,
    date: draft.updatedAt,
    snippet: text.slice(0, 160),
    unread: false,
    labels,
    attachments: [],
    bulk: false,
    pgpEncrypted: false,
    ai: null,
    locked: false,
    text,
    html: "",
  };
  if (draft.inReplyTo) out.inReplyTo = draft.inReplyTo;
  return out;
}
