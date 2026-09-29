import { analyzeMessage, cosine } from "./ai/pipeline.ts";
import type { LlmClient } from "./ai/types.ts";
import { openJson, sealJson } from "./crypto/envelope.ts";
import { MailError } from "./errors.ts";
import { ingestRaw } from "./ingest.ts";
import { newId, sha256, utcDay } from "./ids.ts";
import { encryptText } from "./openpgp/mail.ts";
import type { MailSender, OutboundMessage } from "./send.ts";
import type { MailStore } from "./store/types.ts";
import type {
  ActionItem,
  AiPublic,
  Draft,
  EcPrivateJwk,
  EcPublicJwk,
  Folder,
  LojoConfig,
  MessageView,
  SealedBody,
  StoredMessage,
  Thread,
} from "./types.ts";

export interface MailboxDeps {
  store: MailStore;
  config: LojoConfig;
  publicJwk: EcPublicJwk;
  privateJwk?: EcPrivateJwk;
  llm?: LlmClient | null;
  sender?: MailSender | null;
  styleGuide: string;
}

function viewOf(message: StoredMessage, opened: SealedBody | null): MessageView {
  const view: MessageView = {
    id: message.id,
    threadId: message.threadId,
    folder: message.folder,
    from: message.from,
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    date: message.date,
    snippet: message.snippet,
    unread: message.unread,
    labels: message.labels,
    attachments: message.attachments,
    bulk: message.bulk,
    pgpEncrypted: message.pgpEncrypted,
    ai: message.ai,
    locked: opened === null,
  };
  if (opened) {
    view.text = opened.text;
    view.html = opened.html;
    if (opened.ai) {
      view.summary = opened.ai.summary;
      view.threadSummary = opened.ai.threadSummary;
      view.actionItems = opened.ai.actionItems;
      view.draftReply = opened.ai.draftReply;
      view.phishingReasons = opened.ai.phishingReasons;
    }
  }
  return view;
}

export class Mailbox {
  constructor(private readonly deps: MailboxDeps) {}

  get store(): MailStore {
    return this.deps.store;
  }

  get unlocked(): boolean {
    return Boolean(this.deps.privateJwk);
  }

  unlock(privateJwk: EcPrivateJwk): void {
    this.deps.privateJwk = privateJwk;
  }

  lock(): void {
    this.deps.privateJwk = undefined;
  }

  private requireKey(): EcPrivateJwk {
    if (!this.deps.privateJwk) throw new MailError("Mailbox is locked", "locked");
    return this.deps.privateJwk;
  }

  private requireLlm(): LlmClient {
    if (!this.deps.llm) throw new MailError("No LLM is configured", "invalid");
    return this.deps.llm;
  }

  async openMessage(message: StoredMessage): Promise<SealedBody | null> {
    if (!this.deps.privateJwk) return null;
    return openJson<SealedBody>(message.envelope, this.deps.privateJwk);
  }

  async present(message: StoredMessage): Promise<MessageView> {
    return viewOf(message, await this.openMessage(message));
  }

  async listInbox(limit = 50): Promise<MessageView[]> {
    const messages = await this.deps.store.listMessages({ folder: "inbox", limit });
    return Promise.all(messages.map((message) => this.present(message)));
  }

  async triage(limit = 50): Promise<MessageView[]> {
    const messages = await this.deps.store.listMessages({ folder: "inbox", limit: 200 });
    const ranked = messages.filter((message) => {
      const priority = message.ai?.priority;
      if (message.bulk) return false;
      if (priority === "noise") return false;
      return message.unread || priority === "now" || priority === "today";
    });
    const order = { now: 0, today: 1, later: 2, noise: 3 };
    ranked.sort((a, b) => {
      const ap = order[a.ai?.priority ?? "later"];
      const bp = order[b.ai?.priority ?? "later"];
      if (ap !== bp) return ap - bp;
      return a.date < b.date ? 1 : -1;
    });
    return Promise.all(ranked.slice(0, limit).map((message) => this.present(message)));
  }

  async readThread(threadId: string): Promise<{ thread: Thread; messages: MessageView[] }> {
    const thread = await this.deps.store.getThread(threadId);
    if (!thread) throw new MailError(`No thread ${threadId}`, "not_found");
    const messages = (await this.deps.store.listMessages({ limit: 500 }))
      .filter((message) => message.threadId === threadId)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    for (const message of messages) {
      if (message.unread) await this.deps.store.updateMessage(message.id, { unread: false });
    }
    const views = await Promise.all(
      messages.map(async (message) => this.present({ ...message, unread: false })),
    );
    return { thread: { ...thread, unreadCount: 0 }, messages: views };
  }

  async search(query: string, mode: "keyword" | "semantic" = "keyword"): Promise<MessageView[]> {
    const messages = await this.deps.store.listMessages({ limit: 1000 });
    if (mode === "semantic") {
      const llm = this.deps.llm;
      if (!llm?.embed) throw new MailError("This provider has no embeddings", "invalid");
      const used = await this.deps.store.getBudget(utcDay());
      if (used >= this.deps.config.dailyTokenBudget) throw new MailError("Daily token budget is spent", "budget");
      const embedded = await llm.embed(query);
      await this.deps.store.addBudget(utcDay(), embedded.tokens);
      await this.deps.store.putAudit({
        id: newId("aud"),
        day: utcDay(),
        at: new Date().toISOString(),
        action: "ai.embed_query",
        provider: llm.name,
        model: llm.model,
        inputTokens: embedded.tokens,
        outputTokens: 0,
        outcome: "ok",
      });
      const ranked = messages
        .filter((message) => message.embedding && message.embedding.length > 0)
        .map((message) => ({ message, score: cosine(embedded.vector, message.embedding ?? []) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);
      return Promise.all(ranked.map((item) => this.present(item.message)));
    }
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits: StoredMessage[] = [];
    for (const message of messages) {
      const opened = await this.openMessage(message);
      const haystack = [
        message.subject,
        message.from.email,
        message.from.name ?? "",
        message.snippet,
        message.labels.join(" "),
        opened?.text ?? "",
        opened?.ai?.summary ?? "",
      ]
        .join("\n")
        .toLowerCase();
      if (terms.every((term) => haystack.includes(term))) hits.push(message);
    }
    return Promise.all(hits.slice(0, 50).map((message) => this.present(message)));
  }

  async summarizeThread(threadId: string): Promise<string> {
    const { messages } = await this.readThread(threadId);
    if (messages.some((message) => message.locked)) throw new MailError("Unlock the mailbox to summarize", "locked");
    const llm = this.requireLlm();
    const transcript = messages
      .map((message) => `From ${message.from.email} at ${message.date}\nSubject: ${message.subject}\n${message.text ?? ""}`)
      .join("\n\n");
    const system = "Summarize this email thread for Jon in a short paragraph plus bullet action items. Do not invent facts.";
    const user = transcript.slice(0, this.deps.config.maxBodyChars);
    const completion = await llm.complete({ system, user, maxTokens: 400 });
    await this.deps.store.addBudget(utcDay(), completion.inputTokens + completion.outputTokens);
    await this.deps.store.putAudit({
      id: newId("aud"),
      day: utcDay(),
      at: new Date().toISOString(),
      action: "ai.summarize_thread",
      messageId: threadId,
      provider: llm.name,
      model: llm.model,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      outcome: "ok",
      promptSha256: sha256(`${system}\n${user}`),
    });
    return completion.text.trim();
  }

  async createDraft(input: { to: string[]; cc?: string[]; subject: string; text: string; threadId?: string; inReplyTo?: string }): Promise<Draft> {
    const envelope = await sealJson({ text: input.text }, this.deps.publicJwk);
    const now = new Date().toISOString();
    const draft: Draft = {
      id: newId("drf"),
      to: input.to.map((email) => ({ email })),
      cc: (input.cc ?? []).map((email) => ({ email })),
      subject: input.subject,
      status: "edited",
      aiGenerated: false,
      envelope,
      createdAt: now,
      updatedAt: now,
    };
    if (input.threadId) draft.threadId = input.threadId;
    if (input.inReplyTo) draft.inReplyTo = input.inReplyTo;
    await this.deps.store.putDraft(draft);
    return draft;
  }

  async draftReply(messageId: string): Promise<Draft> {
    const message = await this.requireMessage(messageId);
    const opened = await this.openMessage(message);
    if (!opened) throw new MailError("Unlock the mailbox to draft a reply", "locked");
    const llm = this.requireLlm();
    const analyzed = await analyzeMessage(llm, {
      subject: message.subject,
      from: message.from,
      to: message.to.map((item) => item.email).join(", "),
      text: opened.text,
      threadContext: "",
      styleGuide: this.deps.styleGuide,
      maxBodyChars: this.deps.config.maxBodyChars,
    });
    await this.deps.store.addBudget(utcDay(), analyzed.inputTokens + analyzed.outputTokens);
    await this.deps.store.putAudit({
      id: newId("aud"),
      day: utcDay(),
      at: new Date().toISOString(),
      action: "ai.draft_reply",
      messageId,
      provider: llm.name,
      model: llm.model,
      inputTokens: analyzed.inputTokens,
      outputTokens: analyzed.outputTokens,
      outcome: "ok",
      promptSha256: analyzed.promptSha256,
    });
    const envelope = await sealJson({ text: analyzed.sensitive.draftReply }, this.deps.publicJwk);
    const now = new Date().toISOString();
    const draft: Draft = {
      id: newId("drf"),
      threadId: message.threadId,
      inReplyTo: message.rfcMessageId,
      to: [message.from],
      cc: [],
      subject: message.subject.toLowerCase().startsWith("re:") ? message.subject : `Re: ${message.subject}`,
      status: "suggested",
      aiGenerated: true,
      envelope,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.store.putDraft(draft);
    return draft;
  }

  async readDraft(draft: Draft): Promise<{ draft: Draft; text: string }> {
    const key = this.requireKey();
    const opened = await openJson<{ text: string }>(draft.envelope, key);
    return { draft, text: opened.text };
  }

  async listDrafts(): Promise<Array<{ draft: Draft; text: string | null }>> {
    const drafts = await this.deps.store.listDrafts();
    const out = [];
    for (const draft of drafts) {
      if (!this.deps.privateJwk) {
        out.push({ draft, text: null });
        continue;
      }
      const opened = await openJson<{ text: string }>(draft.envelope, this.deps.privateJwk);
      out.push({ draft, text: opened.text });
    }
    return out;
  }

  async rewrite(draftId: string, instruction: string): Promise<{ draft: Draft; text: string }> {
    const draft = await this.requireDraft(draftId);
    const current = await this.readDraft(draft);
    const llm = this.requireLlm();
    const completion = await llm.complete({
      system: `Rewrite the email in Jon's voice. Return only the new email body.\n\n${this.deps.styleGuide}`,
      user: `Instruction: ${instruction}\n\nCurrent draft:\n${current.text}`,
      maxTokens: 600,
    });
    await this.deps.store.addBudget(utcDay(), completion.inputTokens + completion.outputTokens);
    await this.deps.store.putAudit({
      id: newId("aud"),
      day: utcDay(),
      at: new Date().toISOString(),
      action: "ai.rewrite",
      messageId: draftId,
      provider: llm.name,
      model: llm.model,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      outcome: "ok",
    });
    const text = completion.text.trim();
    const updated: Draft = {
      ...draft,
      status: "edited",
      envelope: await sealJson({ text }, this.deps.publicJwk),
      updatedAt: new Date().toISOString(),
    };
    await this.deps.store.putDraft(updated);
    return { draft: updated, text };
  }

  /**
   * The only path that calls MailSender. The AI pipeline cannot reach this
   * without a caller that already decided to send.
   */
  async approveAndSend(draftId: string): Promise<{ messageId: string }> {
    const sender = this.deps.sender;
    if (!sender) throw new MailError("No sender is configured", "invalid");
    const draft = await this.requireDraft(draftId);
    if (draft.status === "sent" || draft.status === "discarded") {
      throw new MailError(`Draft is ${draft.status}`, "invalid");
    }
    const { text } = await this.readDraft(draft);
    const outbound: OutboundMessage = {
      from: { email: this.deps.config.mailbox, name: "Jon Hebert" },
      to: draft.to,
      cc: draft.cc,
      subject: draft.subject,
      text,
    };
    const recipient = draft.to[0];
    if (recipient) {
      const contact = await this.deps.store.getContact(recipient.email);
      if (contact?.pgpPublicKey) {
        outbound.armored = await encryptText(text, contact.pgpPublicKey);
        outbound.text = outbound.armored;
      }
    }
    const sent = await sender.send(outbound);
    const updated: Draft = { ...draft, status: "sent", sentMessageId: sent.messageId, updatedAt: new Date().toISOString() };
    await this.deps.store.putDraft(updated);
    await this.deps.store.putAudit({
      id: newId("aud"),
      day: utcDay(),
      at: new Date().toISOString(),
      action: "send.approved",
      messageId: draftId,
      outcome: "sent",
      detail: sent.messageId,
    });
    const raw = [
      `From: ${outbound.from.email}`,
      `To: ${outbound.to.map((item) => item.email).join(", ")}`,
      `Subject: ${outbound.subject}`,
      `Message-ID: <${sent.messageId}>`,
      `Date: ${new Date().toUTCString()}`,
      "",
      outbound.text,
    ].join("\n");
    await ingestRaw(raw, { ...this.deps, llm: null });
    return sent;
  }

  async setLabels(messageId: string, labels: string[]): Promise<StoredMessage> {
    const cleaned = [...new Set(labels.map((label) => label.trim().toLowerCase()).filter(Boolean))];
    return this.deps.store.updateMessage(messageId, { labels: cleaned });
  }

  async archive(messageId: string): Promise<StoredMessage> {
    return this.move(messageId, "archive");
  }

  async move(messageId: string, folder: Folder): Promise<StoredMessage> {
    await this.requireMessage(messageId);
    const patch: { folder: Folder; unread?: boolean } = { folder };
    if (folder !== "inbox") patch.unread = false;
    const updated = await this.deps.store.updateMessage(messageId, patch);
    const messages = (await this.deps.store.listMessages({ limit: 1000 })).filter((message) => message.threadId === updated.threadId);
    const thread = await this.deps.store.getThread(updated.threadId);
    if (thread) {
      await this.deps.store.putThread({
        ...thread,
        folder: messages.some((message) => message.folder === "inbox") ? "inbox" : folder,
        unreadCount: messages.filter((message) => message.unread && message.id !== updated.id).length + (updated.unread ? 1 : 0),
      });
    }
    return updated;
  }

  async actionItems(): Promise<Array<{ messageId: string; subject: string; items: ActionItem[] }>> {
    this.requireKey();
    const messages = await this.deps.store.listMessages({ folder: "inbox", limit: 200 });
    const out = [];
    for (const message of messages) {
      const opened = await this.openMessage(message);
      const items = opened?.ai?.actionItems ?? [];
      if (items.length > 0) out.push({ messageId: message.id, subject: message.subject, items });
    }
    return out;
  }

  async exportAll(): Promise<string> {
    const messages = await this.deps.store.listMessages({ limit: 5000 });
    const views = await Promise.all(messages.map((message) => this.present(message)));
    return JSON.stringify({ exportedAt: new Date().toISOString(), mailbox: this.deps.config.mailbox, messages: views }, null, 2);
  }

  async listAudit(limit = 50) {
    return this.deps.store.listAudit(limit);
  }

  async labels(): Promise<string[]> {
    const messages = await this.deps.store.listMessages({ limit: 1000 });
    return [...new Set(messages.flatMap((message) => message.labels))].sort();
  }

  private async requireMessage(id: string): Promise<StoredMessage> {
    const message = await this.deps.store.getMessage(id);
    if (!message) throw new MailError(`No message ${id}`, "not_found");
    return message;
  }

  private async requireDraft(id: string): Promise<Draft> {
    const draft = await this.deps.store.getDraft(id);
    if (!draft) throw new MailError(`No draft ${id}`, "not_found");
    return draft;
  }
}

export function publicAi(message: StoredMessage): AiPublic | null {
  return message.ai;
}
