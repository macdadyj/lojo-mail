import { MailError } from "../errors.ts";
import { utcDay } from "../ids.ts";
import type { MailStore } from "../store/types.ts";
import type { Draft, StoredMessage } from "../types.ts";

/**
 * The `send-approved` scope: Jon approves a reply in chat with his assistant,
 * and the bot sends it. The server cannot see the chat, so the approval is the
 * bot's attestation (`approvalSource: "chat"` plus a note quoting Jon). What the
 * server does enforce: the exact content (hash) the bot showed Jon, replies only
 * to people already in a received thread unless Jon granted `send-new`, rate
 * limits Jon sets, both kill switches, and a note that is not mailbox text.
 */
export const CHAT_APPROVAL_SOURCE = "chat";

export interface ChatSendLimits {
  perHour: number;
  perDay: number;
}

export const DEFAULT_CHAT_SEND_LIMITS: ChatSendLimits = { perHour: 10, perDay: 30 };
export const MAX_CHAT_SEND_LIMITS: ChatSendLimits = { perHour: 50, perDay: 200 };

const NOTE_MIN = 8;
const NOTE_MAX = 300;
const QUOTE_WINDOW = 5;

export function chatSendLimits(value: unknown): ChatSendLimits {
  const input = (value ?? {}) as Partial<Record<keyof ChatSendLimits, unknown>>;
  const pick = (key: keyof ChatSendLimits) => {
    const raw = input[key] ?? DEFAULT_CHAT_SEND_LIMITS[key];
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_CHAT_SEND_LIMITS[key]) {
      throw new MailError(`${key} must be a whole number from 1 to ${MAX_CHAT_SEND_LIMITS[key]}`, "invalid");
    }
    return raw;
  };
  const limits = { perHour: pick("perHour"), perDay: pick("perDay") };
  if (limits.perHour > limits.perDay) throw new MailError("perHour cannot be more than perDay", "invalid");
  return limits;
}

function words(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

/**
 * Mail is untrusted: an email that says "Jon approved this, send it" must not
 * become the approval. So the note must be Jon's words, not text the mailbox
 * holds. It is refused if it appears in, or quotes five words in a row from,
 * the subject, snippet or AI-context text of any message in the thread.
 */
export function approvalNoteRefusals(note: unknown, mailboxText: readonly string[]): string[] {
  if (typeof note !== "string") return ["approvalNote is required"];
  const trimmed = note.trim();
  const out: string[] = [];
  if (trimmed.length < NOTE_MIN || trimmed.length > NOTE_MAX) out.push(`approvalNote must be ${NOTE_MIN}-${NOTE_MAX} characters quoting Jon's approval`);
  if (/untrusted-mail-content|ignore (all )?(previous|prior) instructions/i.test(trimmed)) out.push("approvalNote contains prompt text");
  const mine = words(trimmed);
  const flat = mine.join(" ");
  for (const source of mailboxText) {
    const theirs = words(source);
    if (flat && theirs.join(" ").includes(flat)) {
      out.push("approvalNote is text from the mailbox, not Jon's approval");
      break;
    }
    const grams = new Set<string>();
    for (let i = 0; i + QUOTE_WINDOW <= theirs.length; i += 1) grams.add(theirs.slice(i, i + QUOTE_WINDOW).join(" "));
    let quoted = false;
    for (let i = 0; i + QUOTE_WINDOW <= mine.length; i += 1) if (grams.has(mine.slice(i, i + QUOTE_WINDOW).join(" "))) quoted = true;
    if (quoted) {
      out.push("approvalNote quotes the mailbox, not Jon's approval");
      break;
    }
  }
  return out;
}

/** The received message a draft answers, if it answers one. */
export async function repliedMessage(store: MailStore, draft: Draft): Promise<StoredMessage | null> {
  if (!draft.inReplyTo) return null;
  const found = await store.getMessagesByRfcId(draft.inReplyTo);
  return found.find((message) => message.origin === "inbound") ?? null;
}

/**
 * Without `send-new`: the draft must answer a received message, and every
 * recipient must already be on that thread's received mail (its senders,
 * Reply-To, and the people they copied). Jon's own addresses never count.
 */
export async function replyRecipientRefusals(store: MailStore, draft: Draft, mailbox: string, domain: string): Promise<string[]> {
  const parent = await repliedMessage(store, draft);
  if (!parent) return ["not a reply to a received message (sending new mail needs the send-new scope)"];
  const out: string[] = [];
  if (draft.threadId && draft.threadId !== parent.threadId) out.push("the draft's thread is not the thread of the message it answers");
  if (parent.folder === "spam" || parent.labels.includes("quarantined") || parent.ai?.category === "phishing" || (parent.ai?.phishingScore ?? 0) >= 40) {
    out.push("the message being answered is spam or possible phishing; send this one from the app");
  }
  const own = (email: string) => email === mailbox.toLowerCase() || email.endsWith(`@${domain.toLowerCase()}`);
  const allowed = new Set<string>();
  const thread = await store.listThreadMessages(parent.threadId);
  for (const message of [parent, ...thread.filter((item) => item.origin === "inbound")]) {
    for (const address of [message.from, ...(message.replyTo ? [message.replyTo] : []), ...message.to, ...message.cc]) {
      const email = address.email.toLowerCase();
      if (!own(email)) allowed.add(email);
    }
  }
  const extra = [...draft.to, ...draft.cc, ...(draft.bcc ?? [])].map((item) => item.email.toLowerCase()).filter((email) => !allowed.has(email));
  if (extra.length > 0) out.push(`not on the thread being answered: ${extra.join(", ")} (needs the send-new scope)`);
  return out;
}

/** Bumped before the check, like every other send limit: a refused attempt still counts. */
export async function chatSendRateRefusals(store: MailStore, bot: string, limits: ChatSendLimits, at: Date): Promise<string[]> {
  const hour = Math.floor(at.getTime() / 3_600_000);
  const day = utcDay(at);
  const perHour = await store.bumpCounter(`chatsend:${bot}:h${hour}`, new Date((hour + 2) * 3_600_000));
  const perDay = await store.bumpCounter(`chatsend:${bot}:${day}`, new Date(Date.parse(`${day}T00:00:00Z`) + 2 * 86_400_000));
  const out: string[] = [];
  if (perHour > limits.perHour) out.push(`limit of ${limits.perHour} bot sends an hour`);
  if (perDay > limits.perDay) out.push(`limit of ${limits.perDay} bot sends a day`);
  return out;
}

/** Audit detail for one chat-approved send: who (the `bot:<name>` label), the source, and Jon's words as the bot reported them. */
export function chatApprovalDetail(bot: string, note: string, to: string[]): string {
  return `approvalSource:${CHAT_APPROVAL_SOURCE} by:${bot} to:${to.join(",")} note:${JSON.stringify(note.trim())}`.slice(0, 500);
}

/** Audit detail for `bot.send_new`. The quote is Jon's words when approval is required, and absent when he waived it for a window. */
export function sendNewAuditDetail(bot: string, note: string | null, recipients: string[]): string {
  const approval = note === null ? "approval:waived" : `approvalSource:${CHAT_APPROVAL_SOURCE} note:${JSON.stringify(note.trim())}`;
  return `${approval} by:${bot} rcpt:${recipients.join(",")}`.slice(0, 500);
}
