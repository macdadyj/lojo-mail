import type { MailStore } from "../store/types.ts";
import type { StoredMessage } from "../types.ts";
import { utcDay } from "../ids.ts";
import { senderMatches } from "./match.ts";
import type { ReplyAction, Rule, RulesDocument } from "./types.ts";

/** Appended to every auto-sent reply. Not configurable, so no rule can hide that a machine answered. */
export const AUTO_REPLY_FOOTER = "\n\n--\nThis is an automatic reply from Jon's mail rules. Jon has not read your message yet.";

/** Headers that mark mail no machine should answer (RFC 3834 and common practice). */
export interface LoopHeaders {
  autoSubmitted?: string;
  precedence?: string;
  listId?: string;
  listUnsubscribe?: string;
  autoResponseSuppress?: string;
  returnPath?: string;
  subject: string;
  from: string;
  replyTo?: string;
}

const NO_REPLY_LOCAL =
  /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?|automated|auto|daemon|robot|listserv|majordomo|news(letter)?|info|support|billing|marketing)([+._-].*)?$/i;
const AUTO_SUBJECT = /^\s*(auto(matic)?[\s:-]*(reply|response)|out of (the )?office|ooo\b|undeliver|delivery (status|failure)|returned mail|mail delivery)/i;

/**
 * Header-derived reasons never to auto-reply to this message. Computed once at
 * delivery and stored on the message (codes only, no content) so dry runs later
 * see the same answer.
 */
export function replyBlockers(headers: LoopHeaders): string[] {
  const out: string[] = [];
  if (headers.autoSubmitted && !/^no$/i.test(headers.autoSubmitted.trim())) out.push("auto-submitted");
  if (headers.precedence && /^(bulk|list|junk|auto_reply)$/i.test(headers.precedence.trim())) out.push("precedence");
  if (headers.listId) out.push("list-id");
  if (headers.listUnsubscribe) out.push("list-unsubscribe");
  if (headers.autoResponseSuppress && /\b(all|autoreply|oof)\b/i.test(headers.autoResponseSuppress)) out.push("auto-response-suppress");
  if (headers.returnPath !== undefined && /^\s*<?\s*>?\s*$/.test(headers.returnPath)) out.push("null-return-path");
  if (NO_REPLY_LOCAL.test(headers.from.split("@")[0] ?? "")) out.push("no-reply-sender");
  if (AUTO_SUBJECT.test(headers.subject)) out.push("auto-reply-subject");
  if (headers.replyTo && headers.replyTo.toLowerCase() !== headers.from.toLowerCase()) out.push("reply-to-differs");
  return out;
}

export interface AutoSendContext {
  doc: RulesDocument;
  rule: Rule;
  action: ReplyAction;
  message: StoredMessage;
  /** LOJO_AUTO_SEND=on and a sender wired in. Terraform grants the processor SES only when auto_send_enabled. */
  enabled: boolean;
  mailbox: string;
  domain: string;
  /** The recipient has an OpenPGP key; auto-replies are plaintext only. */
  recipientUsesPgp: boolean;
}

/** Every static reason this reply must not go out without Jon. Empty means rate limits are next. */
export function autoSendRefusals(ctx: AutoSendContext): string[] {
  const { doc, rule, action, message } = ctx;
  const from = message.from.email.toLowerCase();
  const out: string[] = [];
  if (!ctx.enabled) out.push("auto-send is disabled on this deployment");
  if (doc.killSwitch) out.push("kill switch is engaged");
  if (doc.sendKillSwitch) out.push("global send kill switch is engaged");
  if (doc.paused) out.push("rules are paused");
  if (rule.createdBy !== "human") out.push("rule was not written by a human session");
  if (action.allowSenders.length === 0 || !senderMatches(from, action.allowSenders)) out.push("sender is not on the rule's allowlist");
  if (action.allowCategories.length > 0 && !(message.ai && action.allowCategories.includes(message.ai.category))) {
    out.push("category is not on the rule's allowlist");
  }
  if (message.origin !== "inbound") out.push("not inbound mail");
  if (message.verdicts?.dmarc !== "pass") out.push("sender did not pass DMARC");
  if (message.verdicts?.spam === "FAIL" || message.verdicts?.virus === "FAIL" || message.labels.includes("quarantined")) out.push("quarantined");
  if (message.bulk) out.push("bulk mail");
  if (message.pgpEncrypted) out.push("encrypted mail");
  if (!message.ai || message.ai.skipped) out.push("no AI screening for this message");
  if (message.ai && (message.ai.category === "phishing" || message.ai.phishingScore >= 40)) out.push("possible phishing");
  if (from === ctx.mailbox.toLowerCase() || from.endsWith(`@${ctx.domain.toLowerCase()}`)) out.push("sender is on Jon's own domain");
  if (ctx.recipientUsesPgp) out.push("recipient uses OpenPGP; auto-replies are plaintext only");
  for (const blocker of message.replyBlockers ?? []) out.push(`loop guard: ${blocker}`);
  return out;
}

const FORBIDDEN_TERMS =
  /\b(password|passcode|passphrase|verification code|one[- ]time|otp|2fa|mfa|wire|bank|iban|swift|routing|account number|gift ?cards?|bitcoin|crypto|wallet|invoice|payment|pay you|refund|ssn|social security|credentials?|log ?in|api key|token|attach(ed|ment))\b/i;
const URL_LIKE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|us|co|me|ru|cn|xyz|info|biz|app|dev|link|ly|gl|to|sh)\b)/i;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+/;
const MANY_DIGITS = /(?:\d[\s().+/-]*){5,}/;
const MARKUP = /<\/?[a-z!][^>]*>|```|\[[^\]]*\]\([^)]*\)/i;

/**
 * Fixed constraints on text a rule may send without review. They are not
 * configurable: an injected instruction that gets past the model still has to
 * produce text that passes these, and a failure only downgrades to a draft.
 */
export function replyTextRefusals(text: string, maxChars: number, incoming: string): string[] {
  const out: string[] = [];
  const body = text.trim();
  if (!body) out.push("empty reply");
  if (body.length > maxChars) out.push(`longer than ${maxChars} characters`);
  if (URL_LIKE.test(body)) out.push("contains a link or domain");
  if (EMAIL_LIKE.test(body)) out.push("contains an email address");
  if (MANY_DIGITS.test(body)) out.push("contains a long number");
  if (FORBIDDEN_TERMS.test(body)) out.push("mentions money, credentials, attachments or codes");
  if (MARKUP.test(body)) out.push("contains markup");
  if (/untrusted-mail-content|ignore (all )?(previous|prior) instructions|system prompt/i.test(body)) out.push("echoes prompt text");
  if (quotesIncoming(body, incoming)) out.push("quotes the incoming message");
  return out;
}

function quotesIncoming(reply: string, incoming: string, window = 8): boolean {
  const words = (value: string) => value.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  const source = words(incoming);
  if (source.length < window) return false;
  const grams = new Set<string>();
  for (let i = 0; i + window <= source.length; i += 1) grams.add(source.slice(i, i + window).join(" "));
  const out = words(reply);
  for (let i = 0; i + window <= out.length; i += 1) if (grams.has(out.slice(i, i + window).join(" "))) return true;
  return false;
}

/**
 * Counts this attempt against every limit and reports which are exceeded.
 * Counters are bumped before the check, so concurrent deliveries cannot both
 * slip under a limit; a refused attempt still counts, which errs toward fewer sends.
 */
export async function rateLimitRefusals(store: MailStore, ctx: AutoSendContext, at: Date): Promise<string[]> {
  const day = utcDay(at);
  const dayEnd = new Date(Date.parse(`${day}T00:00:00Z`) + 2 * 86_400_000);
  const sender = ctx.message.from.email.toLowerCase();
  const out: string[] = [];
  if ((await store.bumpCounter(`autosend:msg:${ctx.message.id}`, new Date(at.getTime() + 30 * 86_400_000))) > 1) out.push("already answered this message");
  if ((await store.bumpCounter(`autosend:thread:${ctx.message.threadId}:${day}`, dayEnd)) > 1) out.push("already answered this thread today");
  if ((await store.bumpCounter(`autosend:sender:${sender}:${day}`, dayEnd)) > ctx.action.perSenderPerDay) out.push("per-sender daily limit");
  if ((await store.bumpCounter(`autosend:rule:${ctx.rule.id}:${day}`, dayEnd)) > ctx.action.perDay) out.push("rule daily limit");
  if ((await store.bumpCounter(`autosend:day:${day}`, dayEnd)) > ctx.doc.maxAutoSendPerDay) out.push("global daily limit");
  return out;
}

/** `{{first_name}}` from the display name when it looks like a name, else "there". */
export function renderTemplate(template: string, message: Pick<StoredMessage, "from">): string {
  const first = (message.from.name ?? "").trim().split(/\s+/)[0] ?? "";
  const safe = /^[\p{L}][\p{L}'-]{0,29}$/u.test(first) ? first : "there";
  return template.replace(/\{\{\s*first_name\s*\}\}/g, safe);
}
