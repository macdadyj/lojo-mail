import { analyzeMessage } from "./ai/pipeline.ts";
import type { LlmClient } from "./ai/types.ts";
import { sealJson } from "./crypto/envelope.ts";
import { newId, utcDay } from "./ids.ts";
import { isBulk } from "./mime/bulk.ts";
import { snippetFrom } from "./mime/html.ts";
import { parseMime } from "./mime/parse.ts";
import { threadIdForRoot } from "./mime/thread.ts";
import type { MailStore } from "./store/types.ts";
import type { AiPublic, EcPublicJwk, Folder, LojoConfig, Priority, SealedBody, StoredMessage, Thread } from "./types.ts";

export interface IngestDeps {
  store: MailStore;
  publicJwk: EcPublicJwk;
  llm: LlmClient | null;
  config: LojoConfig;
  styleGuide: string;
  now?: Date;
}

export interface IngestResult {
  message: StoredMessage;
  duplicate: boolean;
}

const PRIORITY_RANK: Record<Priority, number> = { now: 0, today: 1, later: 2, noise: 3 };

async function resolveThreadId(store: MailStore, rfcMessageId: string, references: string[], inReplyTo?: string): Promise<string> {
  const candidates = [...references];
  if (inReplyTo) candidates.push(inReplyTo);
  for (const candidate of candidates) {
    const existing = await store.getMessageByRfcId(candidate);
    if (existing) return existing.threadId;
  }
  const root = references[0] ?? inReplyTo ?? rfcMessageId;
  return threadIdForRoot(root);
}

async function refreshThread(store: MailStore, threadId: string, fallbackSubject: string): Promise<void> {
  const messages = (await store.listMessages({ limit: 1000 })).filter((message) => message.threadId === threadId);
  if (messages.length === 0) return;
  const sorted = [...messages].sort((a, b) => (a.date < b.date ? 1 : -1));
  const latest = sorted[0];
  if (!latest) return;
  const participants = [...new Set(messages.flatMap((message) => [message.from.email, ...message.to.map((item) => item.email)]))];
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
    participants,
    lastDate: latest.date,
    unreadCount: messages.filter((message) => message.unread).length,
    messageIds: sorted.map((message) => message.id).reverse(),
    folder,
  };
  if (best) thread.priority = best;
  await store.putThread(thread);
}

function skipped(reason: NonNullable<AiPublic["skipReason"]>): AiPublic {
  return {
    category: reason === "bulk" ? "newsletter" : "other",
    priority: reason === "bulk" ? "noise" : "later",
    phishingScore: 0,
    labels: [],
    unsubscribeDetected: reason === "bulk",
    skipped: true,
    skipReason: reason,
  };
}

export async function ingestRaw(raw: Buffer | string, deps: IngestDeps): Promise<IngestResult> {
  const now = deps.now ?? new Date();
  const parsed = await parseMime(raw);
  const existing = await deps.store.getMessageByRfcId(parsed.rfcMessageId);
  if (existing) {
    await deps.store.putAudit({
      id: newId("aud"),
      day: utcDay(now),
      at: now.toISOString(),
      action: "ingest",
      messageId: existing.id,
      outcome: "duplicate",
    });
    return { message: existing, duplicate: true };
  }

  const threadId = await resolveThreadId(deps.store, parsed.rfcMessageId, parsed.references, parsed.inReplyTo);
  const bulk = isBulk(parsed);
  const labels = bulk ? ["bulk"] : [];
  let ai: AiPublic | null = null;
  let sensitive: SealedBody["ai"] = null;
  let embedding: number[] | null = null;
  const id = newId("msg");

  const auditBase = {
    day: utcDay(now),
    at: now.toISOString(),
    messageId: id,
    provider: deps.llm?.name,
    model: deps.llm?.model,
  };

  if (parsed.pgpEncrypted) {
    ai = skipped("pgp");
    await deps.store.putAudit({ ...auditBase, id: newId("aud"), action: "ai.skip", outcome: "pgp", detail: "Encrypted to Jon's OpenPGP key; not sent to a model." });
  } else if (bulk && deps.config.skipBulk) {
    ai = skipped("bulk");
    await deps.store.putAudit({ ...auditBase, id: newId("aud"), action: "ai.skip", outcome: "bulk" });
  } else if (!deps.llm) {
    ai = skipped("disabled");
    await deps.store.putAudit({ ...auditBase, id: newId("aud"), action: "ai.skip", outcome: "disabled" });
  } else {
    const used = await deps.store.getBudget(utcDay(now));
    if (used >= deps.config.dailyTokenBudget) {
      ai = skipped("budget");
      await deps.store.putAudit({
        ...auditBase,
        id: newId("aud"),
        action: "ai.skip",
        outcome: "budget_exceeded",
        detail: `${used} tokens already used`,
      });
    } else {
      const prior = (await deps.store.listMessages({ limit: 1000 })).filter((message) => message.threadId === threadId);
      const threadContext = prior.map((message) => `${message.date} ${message.from.email}: ${message.subject}`).join("\n");
      try {
        const analyzed = await analyzeMessage(deps.llm, {
          subject: parsed.subject,
          from: parsed.from,
          to: parsed.to.map((item) => item.email).join(", "),
          text: parsed.text,
          threadContext,
          styleGuide: deps.styleGuide,
          maxBodyChars: deps.config.maxBodyChars,
        });
        ai = analyzed.aiPublic;
        sensitive = analyzed.sensitive;
        embedding = analyzed.embedding;
        const tokens = analyzed.inputTokens + analyzed.outputTokens;
        await deps.store.addBudget(utcDay(now), tokens);
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
        const detail = error instanceof Error ? error.message : "unknown error";
        await deps.store.putAudit({
          ...auditBase,
          id: newId("aud"),
          action: "ai.analyze",
          outcome: "error",
          detail: detail.slice(0, 200),
        });
      }
    }
  }

  const body: SealedBody = {
    text: parsed.text,
    html: parsed.html,
    attachments: parsed.attachments.map((item) => ({
      id: item.id,
      filename: item.filename,
      contentType: item.contentType,
      bytesB64: Buffer.from(item.bytes).toString("base64"),
    })),
    ai: sensitive,
  };
  const envelope = await sealJson(body, deps.publicJwk);
  const fromSelf = parsed.from.email.toLowerCase() === deps.config.mailbox.toLowerCase();
  const message: StoredMessage = {
    id,
    rfcMessageId: parsed.rfcMessageId,
    threadId,
    folder: fromSelf ? "sent" : "inbox",
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    subject: parsed.subject,
    date: parsed.date,
    snippet: deps.config.snippetInClear ? snippetFrom(parsed.text) : "",
    unread: !fromSelf,
    labels,
    attachments: parsed.attachments.map(({ id, filename, contentType, size }) => ({ id, filename, contentType, size })),
    references: parsed.references,
    bulk,
    pgpEncrypted: parsed.pgpEncrypted,
    envelope,
    ai,
    embedding,
    createdAt: now.toISOString(),
  };
  if (parsed.replyTo) message.replyTo = parsed.replyTo;
  if (parsed.inReplyTo) message.inReplyTo = parsed.inReplyTo;

  await deps.store.putMessage(message);
  await deps.store.markImported(parsed.rfcMessageId, message.id);
  await refreshThread(deps.store, threadId, parsed.subject);

  if (
    sensitive?.draftReply &&
    ai &&
    !ai.skipped &&
    ai.category === "personal" &&
    (ai.priority === "now" || ai.priority === "today")
  ) {
    const draftEnvelope = await sealJson({ text: sensitive.draftReply }, deps.publicJwk);
    await deps.store.putDraft({
      id: newId("drf"),
      threadId,
      inReplyTo: parsed.rfcMessageId,
      to: [parsed.from],
      cc: [],
      subject: parsed.subject.toLowerCase().startsWith("re:") ? parsed.subject : `Re: ${parsed.subject}`,
      status: "suggested",
      aiGenerated: true,
      envelope: draftEnvelope,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  }

  return { message, duplicate: false };
}
