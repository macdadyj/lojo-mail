import { analyzeMessage } from "./ai/pipeline.ts";
import { ModelOutputError } from "./ai/schema.ts";
import type { LlmClient } from "./ai/types.ts";
import { aiContextKey, attachmentKey, bodyKey, type BlobStore } from "./blob/store.ts";
import { attachmentContext, encodeEnvelope, messageBodyContext, sealBytes, sealJson } from "./crypto/envelope.ts";
import { aiContextContext, draftContext, serverSeal, type KeyWrapper } from "./crypto/server-seal.ts";
import { newId, sha256, utcDay } from "./ids.ts";
import { isBulk } from "./mime/bulk.ts";
import { snippetFrom } from "./mime/html.ts";
import { parseMime, type ParsedInbound } from "./mime/parse.ts";
import { threadIdForRoot } from "./mime/thread.ts";
import type { MailStore } from "./store/types.ts";
import type {
  AiPublic,
  EcPublicJwk,
  Folder,
  LojoConfig,
  MessageOrigin,
  Priority,
  SealedBody,
  SkipReason,
  StoredAttachment,
  StoredMessage,
  Thread,
} from "./types.ts";

export interface IngestDeps {
  store: MailStore;
  blobs: BlobStore;
  /** Seals the AI-context copy and suggested drafts. Without it neither is written. */
  keys?: KeyWrapper | null;
  publicJwk: EcPublicJwk;
  llm: LlmClient | null;
  config: LojoConfig;
  styleGuide: string;
  now?: Date;
}

export interface IngestOptions {
  /** Decides the folder. Inbound mail is never filed as sent, whatever its From says. */
  origin?: MessageOrigin;
  /** Unique per delivery: the SES object key, `sent:{sesMessageId}`, or a hash of the raw bytes. */
  deliveryId?: string;
  /** Import only: the folder the export put it in. */
  folder?: Folder;
  /** Import only: extra labels, for example from a custom folder. */
  labels?: string[];
}

export interface IngestResult {
  message: StoredMessage;
  duplicate: boolean;
}

const PRIORITY_RANK: Record<Priority, number> = { now: 0, today: 1, later: 2, noise: 3 };

/**
 * The dedupe key for mail with no SES delivery (imports). Exporters disagree on
 * CRLF vs LF and on trailing blank lines, so both are normalized before hashing;
 * latin1 maps bytes one to one, so 8-bit bodies hash unchanged.
 */
export function contentDeliveryId(raw: Buffer): string {
  const text = raw.toString("latin1").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  return `sha256:${sha256(Buffer.from(text, "latin1"))}`;
}

export function messageIdFor(deliveryId: string): string {
  return `msg_${sha256(deliveryId).slice(0, 32)}`;
}

function domainOf(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`;
}

export function threadParticipants(messages: Array<Pick<StoredMessage, "from" | "to" | "cc">>): string[] {
  const all = messages.flatMap((message) => [message.from, ...message.to, ...(message.cc ?? [])]);
  return [...new Set(all.map((address) => address.email.toLowerCase()))];
}

interface Classification {
  fromSelf: boolean;
  quarantined: boolean;
  unverifiedSelf: boolean;
  dmarcReport: boolean;
}

function classify(parsed: ParsedInbound, origin: MessageOrigin, config: LojoConfig): Classification {
  const from = parsed.from.email.toLowerCase();
  const fromSelf = from === config.mailbox.toLowerCase();
  if (origin !== "inbound") return { fromSelf, quarantined: false, unverifiedSelf: false, dmarcReport: false };
  const verdicts = parsed.verdicts;
  const ownDomain = domainOf(from) === config.domain.toLowerCase();
  const recipients = [...parsed.to, ...parsed.cc].map((address) => address.email.toLowerCase());
  return {
    fromSelf,
    quarantined: verdicts.virus === "FAIL" || verdicts.spam === "FAIL" || (ownDomain && verdicts.dmarc === "fail"),
    unverifiedSelf: ownDomain && verdicts.dmarc !== "pass",
    dmarcReport: recipients.includes(config.dmarcMailbox.toLowerCase()) && !recipients.includes(config.mailbox.toLowerCase()),
  };
}

function folderFor(origin: MessageOrigin, classes: Classification, requested: Folder | undefined): Folder {
  switch (origin) {
    case "inbound":
      if (classes.quarantined) return "spam";
      return classes.dmarcReport ? "archive" : "inbox";
    case "sent":
      return "sent";
    case "import":
      return requested ?? (classes.fromSelf ? "sent" : "inbox");
    default: {
      const unexpected: never = origin;
      throw new Error(`Unknown origin ${String(unexpected)}`);
    }
  }
}

/**
 * Inbound mail joins an existing thread only when its sender already takes part
 * in it. References and Message-ID are sender-controlled; participation is not.
 */
async function resolveThreadId(
  store: MailStore,
  parsed: ParsedInbound,
  origin: MessageOrigin,
  classes: Classification,
  id: string,
): Promise<string> {
  const candidates = [...(parsed.inReplyTo ? [parsed.inReplyTo] : []), ...[...parsed.references].reverse()];
  const sender = parsed.from.email.toLowerCase();
  const verifiedSelf = classes.fromSelf && parsed.verdicts.dmarc === "pass";
  for (const candidate of [...new Set(candidates)]) {
    for (const parent of await store.getMessagesByRfcId(candidate)) {
      if (origin !== "inbound") return parent.threadId;
      if (parsed.verdicts.dmarc === "fail") continue;
      const thread = await store.getThread(parent.threadId);
      const participants = thread?.participants ?? threadParticipants([parent]);
      if (classes.fromSelf ? verifiedSelf : participants.includes(sender)) return parent.threadId;
    }
  }
  if (origin === "inbound") return threadIdForRoot(id);
  return threadIdForRoot(parsed.references[0] ?? parsed.inReplyTo ?? parsed.rfcMessageId);
}

export async function refreshThread(store: MailStore, threadId: string, fallbackSubject: string): Promise<Thread | null> {
  const messages = await store.listThreadMessages(threadId);
  if (messages.length === 0) {
    await store.retireThread(threadId);
    return null;
  }
  const sorted = [...messages].sort((a, b) => (a.date < b.date ? 1 : -1));
  const latest = sorted[0];
  if (!latest) return null;
  let best: Priority | undefined;
  for (const message of messages) {
    const priority = message.ai?.priority;
    if (!priority) continue;
    if (!best || PRIORITY_RANK[priority] < PRIORITY_RANK[best]) best = priority;
  }
  const folder: Folder = messages.some((message) => message.folder === "inbox") ? "inbox" : latest.folder;
  const thread: Thread = {
    id: threadId,
    subject: latest.subject || fallbackSubject,
    participants: threadParticipants(messages),
    lastDate: latest.date,
    unreadCount: messages.filter((message) => message.unread).length,
    messageIds: [...sorted].reverse().map((message) => message.id),
    folder,
  };
  if (best) thread.priority = best;
  await store.putThread(thread);
  return thread;
}

function skipped(reason: SkipReason): AiPublic {
  return {
    category: reason === "bulk" ? "newsletter" : "other",
    priority: reason === "bulk" || reason === "dmarc-report" ? "noise" : "later",
    phishingScore: 0,
    labels: [],
    unsubscribeDetected: reason === "bulk",
    skipped: true,
    skipReason: reason,
  };
}

function skipReasonFor(
  parsed: ParsedInbound,
  origin: MessageOrigin,
  classes: Classification,
  bulk: boolean,
  deps: IngestDeps,
): SkipReason | null {
  if (origin === "sent") return "sent";
  if (parsed.pgpEncrypted) return "pgp";
  if (classes.quarantined) return "quarantined";
  if (classes.dmarcReport) return "dmarc-report";
  if (bulk && deps.config.skipBulk) return "bulk";
  if (!deps.llm) return "disabled";
  return null;
}

export async function upsertCorrespondents(store: MailStore, addresses: Array<{ email: string; name?: string }>, self: string): Promise<void> {
  for (const address of addresses) {
    const email = address.email.toLowerCase();
    if (email === self.toLowerCase()) continue;
    await store.putContact(address.name ? { email, name: address.name } : { email }, { ifAbsent: true });
  }
}

export async function ingestRaw(raw: Buffer | string, deps: IngestDeps, options: IngestOptions = {}): Promise<IngestResult> {
  const now = deps.now ?? new Date();
  const origin = options.origin ?? "inbound";
  const buffer = typeof raw === "string" ? Buffer.from(raw) : raw;
  const deliveryId = options.deliveryId ?? contentDeliveryId(buffer);
  const id = messageIdFor(deliveryId);

  const duplicate = async (message: StoredMessage): Promise<IngestResult> => {
    await deps.store.putAudit({ id: newId("aud"), day: utcDay(now), at: now.toISOString(), action: "ingest", messageId: message.id, outcome: "duplicate" });
    return { message, duplicate: true };
  };
  const existing = await deps.store.getMessage(id);
  if (existing) return duplicate(existing);

  const parsed = await parseMime(buffer);
  const classes = classify(parsed, origin, deps.config);
  const threadId = await resolveThreadId(deps.store, parsed, origin, classes, id);
  const bulk = isBulk(parsed);
  const labels = new Set<string>(options.labels ?? []);
  if (bulk) labels.add("bulk");
  if (classes.quarantined) labels.add("quarantined");
  if (classes.unverifiedSelf) labels.add("unverified-self");
  if (classes.dmarcReport) labels.add("dmarc-report");

  let ai: AiPublic | null = null;
  let sensitive: SealedBody["ai"] = null;
  let embedding: number[] | null = null;
  const auditBase = { day: utcDay(now), at: now.toISOString(), messageId: id, provider: deps.llm?.name, model: deps.llm?.model };

  const skip = skipReasonFor(parsed, origin, classes, bulk, deps);
  if (skip) {
    ai = skipped(skip);
    const detail = skip === "pgp" ? "Encrypted to Jon's OpenPGP key; not sent to a model." : undefined;
    await deps.store.putAudit({ ...auditBase, id: newId("aud"), action: "ai.skip", outcome: skip, ...(detail ? { detail } : {}) });
  } else if (deps.llm) {
    const used = await deps.store.getBudget(utcDay(now));
    if (used >= deps.config.dailyTokenBudget) {
      ai = skipped("budget");
      await deps.store.putAudit({ ...auditBase, id: newId("aud"), action: "ai.skip", outcome: "budget_exceeded", detail: `${used} tokens already used` });
    } else {
      const prior = await deps.store.listThreadMessages(threadId);
      const threadContext = prior.map((message) => `${message.date} ${message.from.email}: ${message.subject}`).join("\n");
      try {
        const analyzed = await analyzeMessage(deps.llm, {
          subject: parsed.subject,
          from: parsed.from,
          ...(parsed.replyTo ? { replyTo: parsed.replyTo } : {}),
          to: parsed.to.map((item) => item.email).join(", "),
          text: parsed.text,
          threadContext,
          styleGuide: deps.styleGuide,
          maxBodyChars: deps.config.maxBodyChars,
        });
        ai = analyzed.aiPublic;
        sensitive = analyzed.sensitive;
        embedding = analyzed.embedding;
        await deps.store.addBudget(utcDay(now), analyzed.inputTokens + analyzed.outputTokens);
        await deps.store.putAudit({
          ...auditBase,
          id: newId("aud"),
          action: "ai.analyze",
          outcome: "ok",
          inputTokens: analyzed.inputTokens,
          outputTokens: analyzed.outputTokens,
          promptSha256: analyzed.promptSha256,
        });
      } catch (error) {
        ai = skipped("error");
        if (error instanceof ModelOutputError) await deps.store.addBudget(utcDay(now), error.usage.inputTokens + error.usage.outputTokens);
        const detail = error instanceof Error ? error.message : "unknown error";
        await deps.store.putAudit({ ...auditBase, id: newId("aud"), action: "ai.analyze", outcome: "error", detail: detail.slice(0, 200) });
      }
    }
  }

  const body: SealedBody = { text: parsed.text, html: parsed.html, ai: sensitive };
  await deps.blobs.put(bodyKey(id), encodeEnvelope(await sealJson(body, deps.publicJwk, messageBodyContext(id))), "application/json");
  const attachments: StoredAttachment[] = [];
  for (const item of parsed.attachments) {
    const key = attachmentKey(id, item.id);
    await deps.blobs.put(key, encodeEnvelope(await sealBytes(item.bytes, deps.publicJwk, attachmentContext(id, item.id))), "application/json");
    attachments.push({ id: item.id, filename: item.filename, contentType: item.contentType, size: item.size, blobKey: key });
  }

  let contextKey: string | undefined;
  const wantsContext =
    origin === "inbound" && deps.keys && deps.config.aiContextDays > 0 && !parsed.pgpEncrypted && !bulk && !classes.quarantined && !classes.dmarcReport;
  if (wantsContext && deps.keys) {
    contextKey = aiContextKey(id);
    const sealed = await serverSeal({ text: truncate(parsed.text, deps.config.maxBodyChars) }, aiContextContext(id), deps.keys);
    await deps.blobs.put(contextKey, new TextEncoder().encode(JSON.stringify(sealed)), "application/json");
  }

  const folder = folderFor(origin, classes, options.folder);
  const message: StoredMessage = {
    id,
    deliveryId,
    origin,
    rfcMessageId: parsed.rfcMessageId,
    threadId,
    folder,
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    subject: parsed.subject,
    date: parsed.date,
    snippet: deps.config.snippetInClear && !parsed.pgpEncrypted ? snippetFrom(parsed.text) : "",
    unread: origin === "inbound" && !classes.dmarcReport,
    labels: [...labels],
    attachments,
    references: parsed.references,
    bulk,
    pgpEncrypted: parsed.pgpEncrypted,
    bodyKey: bodyKey(id),
    ai,
    embedding,
    createdAt: now.toISOString(),
  };
  if (Object.keys(parsed.verdicts).length > 0) message.verdicts = parsed.verdicts;
  if (contextKey) message.aiContextKey = contextKey;
  if (parsed.replyTo) message.replyTo = parsed.replyTo;
  if (parsed.inReplyTo) message.inReplyTo = parsed.inReplyTo;

  if (!(await deps.store.putMessage(message, { ifAbsent: true }))) {
    const winner = await deps.store.getMessage(id);
    if (winner) return duplicate(winner);
  }
  if (origin === "sent" || (origin === "import" && classes.fromSelf)) {
    await upsertCorrespondents(deps.store, [...parsed.to, ...parsed.cc], deps.config.mailbox);
  }
  await refreshThread(deps.store, threadId, parsed.subject);

  if (
    origin === "inbound" &&
    deps.keys &&
    !classes.fromSelf &&
    sensitive?.draftReply &&
    ai &&
    !ai.skipped &&
    ai.category === "personal" &&
    ai.phishingScore < 40 &&
    (ai.priority === "now" || ai.priority === "today")
  ) {
    const draftId = newId("drf");
    await deps.store.putDraft({
      id: draftId,
      threadId,
      inReplyTo: parsed.rfcMessageId,
      references: [...parsed.references, parsed.rfcMessageId],
      to: [parsed.from],
      cc: [],
      subject: parsed.subject.toLowerCase().startsWith("re:") ? parsed.subject : `Re: ${parsed.subject}`,
      status: "suggested",
      origin: "ai",
      aiGenerated: true,
      pgp: "auto",
      sealed: await serverSeal({ text: sensitive.draftReply }, draftContext(draftId), deps.keys),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  }

  return { message, duplicate: false };
}
