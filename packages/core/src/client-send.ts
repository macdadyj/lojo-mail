import type { Embedder } from "./ai/types.ts";
import type { BlobStore } from "./blob/store.ts";
import type { KeyWrapper } from "./crypto/server-seal.ts";
import { deleteDraftAttachments } from "./draft-attachments.ts";
import { MailError } from "./errors.ts";
import { newId, normalizeMessageId, sha256, utcDay } from "./ids.ts";
import { ingestRaw } from "./ingest.ts";
import { cleanEmail } from "./mime/compose.ts";
import { parseMime, type ParsedInbound } from "./mime/parse.ts";
import type { RulesDocument } from "./rules/types.ts";
import { sesRfcId, type MailSender } from "./send.ts";
import type { MailStore } from "./store/types.ts";
import type { Address, Draft, EcPublicJwk, LojoConfig } from "./types.ts";

export interface ClientSendLimits {
  /** Raw message bytes. The API receives it as base64 JSON inside Lambda's 6 MB request limit. */
  maxBytes: number;
  maxRecipients: number;
  perDay: number;
  recipientsPerDay: number;
  perTenMinutes: number;
}

export const DEFAULT_CLIENT_SEND_LIMITS: ClientSendLimits = {
  maxBytes: 4_000_000,
  maxRecipients: 50,
  perDay: 200,
  recipientsPerDay: 500,
  perTenMinutes: 30,
};

function limitEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, max: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${key} must be a whole number from 1 to ${max}`);
  return value;
}

export function clientSendLimitsFromEnv(env: NodeJS.ProcessEnv): ClientSendLimits {
  const d = DEFAULT_CLIENT_SEND_LIMITS;
  return {
    maxBytes: d.maxBytes,
    maxRecipients: limitEnv(env, "LOJO_SEND_MAX_RECIPIENTS", d.maxRecipients, 50),
    perDay: limitEnv(env, "LOJO_SEND_PER_DAY", d.perDay, 2000),
    recipientsPerDay: limitEnv(env, "LOJO_SEND_RECIPIENTS_PER_DAY", d.recipientsPerDay, 10_000),
    perTenMinutes: limitEnv(env, "LOJO_SEND_PER_10_MINUTES", d.perTenMinutes, 500),
  };
}

export interface ClientSendInput {
  raw: Uint8Array;
  /** SMTP MAIL FROM. */
  envelopeFrom: string;
  /** SMTP RCPT TO: To, Cc and Bcc. */
  recipients: string[];
}

export interface ClientSendResult {
  /** SES MessageId. */
  messageId: string;
  /** The stored Sent copy, when it could be written. */
  sentId: string | null;
  bcc: number;
  draftId: string | null;
  draftUnchanged: boolean | null;
}

export interface ClientSendDeps {
  store: MailStore;
  blobs: BlobStore;
  keys: KeyWrapper;
  config: LojoConfig;
  publicJwk: EcPublicJwk;
  embedder?: Embedder | null;
  styleGuide: string;
  sender?: MailSender | null;
  limits: ClientSendLimits;
  now: () => Date;
  rules: () => Promise<RulesDocument>;
  draftText: (draft: Draft) => Promise<string>;
}

const EDITABLE = new Set(["suggested", "edited", "pending_approval"]);
/** Never delivered: Bcc would reveal the blind recipients, X-Lojo-* are the bridge's own bookkeeping. */
const STRIPPED_HEADERS = /^(bcc|x-lojo-[a-z0-9-]*|x-mozilla-draft-info)$/i;

interface SplitMessage {
  fields: string[];
  eol: string;
  body: Buffer;
}

function splitMessage(raw: Buffer): SplitMessage {
  const text = raw.toString("latin1");
  const crlf = text.indexOf("\r\n\r\n");
  const lf = text.indexOf("\n\n");
  const useCrlf = crlf >= 0 && (lf < 0 || crlf <= lf);
  const end = useCrlf ? crlf : lf;
  if (end < 0) throw new MailError("The message has no header/body separator", "invalid");
  const eol = useCrlf ? "\r\n" : "\n";
  const fields: string[] = [];
  for (const line of text.slice(0, end).split(eol)) {
    const last = fields.length - 1;
    if (/^[ \t]/.test(line) && last >= 0) fields[last] += `${eol}${line}`;
    else fields.push(line);
  }
  return { fields, eol, body: raw.subarray(end + eol.length * 2) };
}

function fieldName(field: string): string {
  return field.slice(0, Math.max(field.indexOf(":"), 0)).trim().toLowerCase();
}

function joinMessage(fields: string[], eol: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${fields.join(eol)}${eol}${eol}`, "latin1"), body]);
}

function headerValue(fields: string[], name: string): string | undefined {
  const field = fields.find((item) => fieldName(item) === name);
  return field?.slice(field.indexOf(":") + 1).replace(/\r?\n[ \t]+/g, " ").trim();
}

function lower(email: string): string {
  return email.trim().toLowerCase();
}

function sameAddresses(a: Address[], b: Address[]): boolean {
  const left = new Set(a.map((item) => lower(item.email)));
  return left.size === new Set(b.map((item) => lower(item.email))).size && b.every((item) => left.has(lower(item.email)));
}

function normalizedText(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function sameThread(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b && normalizeMessageId(a).toLowerCase() === normalizeMessageId(b).toLowerCase());
}

/**
 * The draft this send came from, if any: the one the bridge exported (its
 * X-Lojo-Draft-Id), else an open reply to the same message, else an open
 * draft with the same subject and To.
 */
function matchDraft(drafts: Draft[], parsed: ParsedInbound, draftId: string | undefined): Draft | null {
  const open = drafts.filter((draft) => EDITABLE.has(draft.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const byId = draftId ? open.find((draft) => draft.id === draftId) : undefined;
  if (byId) return byId;
  if (parsed.inReplyTo) return open.find((draft) => sameThread(draft.inReplyTo, parsed.inReplyTo)) ?? null;
  const subject = parsed.subject.trim().toLowerCase();
  return open.find((draft) => !draft.inReplyTo && draft.subject.trim().toLowerCase() === subject && sameAddresses(draft.to, parsed.to)) ?? null;
}

async function audit(deps: ClientSendDeps, outcome: string, detail: string, messageId?: string): Promise<void> {
  const at = deps.now();
  await deps.store.putAudit({ id: newId("aud"), day: utcDay(at), at: at.toISOString(), action: "send.client", outcome, detail, ...(messageId ? { messageId } : {}) });
}

async function refuse(deps: ClientSendDeps, outcome: string, message: string, code: "forbidden" | "invalid" | "rate_limited"): Promise<never> {
  await audit(deps, "refused", outcome);
  throw new MailError(message, code);
}

async function sendKillSwitchEngaged(deps: ClientSendDeps): Promise<boolean> {
  try {
    return (await deps.rules()).sendKillSwitch === true;
  } catch {
    throw new MailError("Could not read the send kill switch, so nothing was sent. Try again later.", "unavailable");
  }
}

/** Counters are bumped before the check, like auto-send: a refused attempt still counts. */
async function rateLimitRefusal(deps: ClientSendDeps, recipients: number): Promise<string | null> {
  const at = deps.now();
  const day = utcDay(at);
  const dayEnd = new Date(Date.parse(`${day}T00:00:00Z`) + 2 * 86_400_000);
  const bucket = Math.floor(at.getTime() / 600_000);
  const { limits, store } = deps;
  if ((await store.bumpCounter(`clientsend:burst:${bucket}`, new Date((bucket + 2) * 600_000))) > limits.perTenMinutes) {
    return `more than ${limits.perTenMinutes} messages in 10 minutes`;
  }
  if ((await store.bumpCounter(`clientsend:day:${day}`, dayEnd)) > limits.perDay) return `more than ${limits.perDay} messages today`;
  let total = 0;
  for (let i = 0; i < recipients; i += 1) total = await store.bumpCounter(`clientsend:rcpt:${day}`, dayEnd);
  if (total > limits.recipientsPerDay) return `more than ${limits.recipientsPerDay} recipients today`;
  return null;
}

/**
 * Jon pressing Send in Thunderbird. Only the bridge token's `client-send` scope
 * reaches this; no agent token can hold it. There is no approval step: a human
 * at his own mail client is the approval. Everything else still applies: the
 * global send kill switch, the From list, size and recipient caps, and rate limits.
 */
/**
 * Files attached to the draft through the API must have gone out as they were. Thunderbird's own
 * attachments on a text-only draft are not compared, as before.
 */
function sameFileHashes(draft: Draft, parsed: ParsedInbound): boolean {
  const expected = (draft.attachments ?? []).map((file) => file.sha256).sort();
  if (expected.length === 0) return true;
  const sent = parsed.attachments.map((file) => sha256(file.bytes)).sort();
  return sent.length === expected.length && sent.every((hash, index) => hash === expected[index]);
}

export async function sendFromClient(deps: ClientSendDeps, input: ClientSendInput): Promise<ClientSendResult> {
  const sender = deps.sender;
  if (!sender?.sendRaw) throw new MailError("No sender is configured", "unavailable");
  if (await sendKillSwitchEngaged(deps)) {
    return refuse(deps, "kill_switch", "Sending is stopped: the global send kill switch is on. Only Jon's web session can release it.", "forbidden");
  }
  const raw = Buffer.from(input.raw);
  if (raw.length === 0) return refuse(deps, "empty", "The message is empty", "invalid");
  if (raw.length > deps.limits.maxBytes) {
    return refuse(deps, "too_large", `The message is ${raw.length} bytes; the limit is ${deps.limits.maxBytes} including attachments`, "invalid");
  }
  const split = splitMessage(raw);
  const parsed = await parseMime(raw);
  const from = lower(parsed.from.email);
  const allowed = deps.config.sendFrom.map(lower);
  if (!allowed.includes(from)) return refuse(deps, "from_not_allowed", `You can only send as ${allowed.join(", ")}`, "forbidden");
  if (lower(input.envelopeFrom) !== from) return refuse(deps, "envelope_mismatch", "MAIL FROM must match the From header", "forbidden");

  const recipients = [...new Set(input.recipients.map((item) => lower(cleanEmail(item))))].filter(Boolean);
  if (recipients.length === 0) return refuse(deps, "no_recipients", "At least one recipient is required", "invalid");
  if (recipients.length > deps.limits.maxRecipients) {
    return refuse(deps, "too_many_recipients", `At most ${deps.limits.maxRecipients} recipients per message`, "invalid");
  }
  const visible = new Set([...parsed.to, ...parsed.cc].map((item) => lower(item.email)));
  const bcc = recipients.filter((email) => !visible.has(email));

  const limited = await rateLimitRefusal(deps, recipients.length);
  if (limited) return refuse(deps, "rate_limited", `Send rate limit: ${limited}. Try again later.`, "rate_limited");

  const draftId = headerValue(split.fields, "x-lojo-draft-id");
  const outgoing = split.fields.filter((field) => !STRIPPED_HEADERS.test(fieldName(field)));
  let sent: { messageId: string };
  try {
    sent = await sender.sendRaw({ from, destinations: recipients, raw: joinMessage(outgoing, split.eol, split.body) });
  } catch (error) {
    await audit(deps, "failed", (error instanceof Error ? error.message : "send failed").slice(0, 200));
    throw new MailError("SES did not accept the message. Nothing was sent.", "upstream");
  }

  const draft = matchDraft(await deps.store.listDrafts(), parsed, draftId);
  let draftUnchanged: boolean | null = null;
  if (draft) {
    draftUnchanged =
      sameAddresses(draft.to, parsed.to) &&
      sameAddresses(draft.cc, parsed.cc) &&
      draft.subject.trim() === parsed.subject.trim() &&
      normalizedText(await deps.draftText(draft)) === normalizedText(parsed.text) &&
      sameFileHashes(draft, parsed);
    const { approvalTokenHash: _a, approvalContentHash: _b, approvalExpiresAt: _c, approvalUsedAt: _d, ...rest } = draft;
    const at = deps.now().toISOString();
    await deps.store.putDraft({ ...rest, status: "sent", sentMessageId: sent.messageId, clientSent: { at, unchanged: draftUnchanged }, updatedAt: at });
    await deleteDraftAttachments(deps.blobs, draft.id, draft.attachments);
  }

  const rfcId = sesRfcId(sent.messageId, deps.config.region);
  const copyFields = [...outgoing.filter((field) => fieldName(field) !== "message-id"), `Message-ID: <${rfcId}>`];
  let sentId: string | null = null;
  try {
    const { message } = await ingestRaw(
      joinMessage(copyFields, split.eol, split.body),
      { store: deps.store, blobs: deps.blobs, keys: deps.keys, publicJwk: deps.publicJwk, llm: null, embedder: deps.embedder ?? null, config: deps.config, styleGuide: deps.styleGuide, now: deps.now() },
      { origin: "sent", deliveryId: `sent:${sent.messageId}` },
    );
    sentId = message.id;
    if (bcc.length > 0) await deps.store.updateMessage(message.id, { bcc: bcc.map((email) => ({ email })) });
  } catch (error) {
    // The mail is already out; failing here would make Thunderbird send it again.
    await audit(deps, "copy_failed", (error instanceof Error ? error.message : "sent copy failed").slice(0, 200));
  }
  await audit(
    deps,
    "sent",
    `ses:${sent.messageId} rcpt:${recipients.length} bcc:${bcc.length} bytes:${raw.length} attachments:${parsed.attachments.length} draft:${draft?.id ?? "none"}${draft ? ` unchanged:${String(draftUnchanged)}` : ""}`,
    sentId ?? undefined,
  );
  return { messageId: sent.messageId, sentId, bcc: bcc.length, draftId: draft?.id ?? null, draftUnchanged };
}
