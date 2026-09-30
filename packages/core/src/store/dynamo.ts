import { MailError } from "../errors.ts";
import { utcDay } from "../ids.ts";
import {
  FOLDERS,
  type AuditEvent,
  type Contact,
  type Draft,
  type DraftStatus,
  type ListQuery,
  type MessagePatch,
  type StoredMessage,
  type Thread,
} from "../types.ts";
import type { DynamoLike, Item, MailStore, TableNames } from "./types.ts";

const AUDIT_DAYS = 7;
const SENDABLE: DraftStatus[] = ["suggested", "edited", "pending_approval"];

function stripEmpty(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripEmpty(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (inner === undefined || inner === "") continue;
      out[key] = stripEmpty(inner);
    }
    return out;
  }
  return value;
}

function asItem(value: unknown): Item {
  return stripEmpty(value) as Item;
}

function withoutKind<T>(item: Item): T {
  const { kind: _kind, ...rest } = item;
  return rest as T;
}

function byDateDesc(a: StoredMessage, b: StoredMessage): number {
  return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
}

export class DynamoMailStore implements MailStore {
  constructor(
    private readonly db: DynamoLike,
    private readonly tables: TableNames,
  ) {}

  async putMessage(message: StoredMessage, opts?: { ifAbsent?: boolean }): Promise<boolean> {
    return this.db.put(this.tables.messages, asItem(message), opts?.ifAbsent ? { ifAbsent: "id" } : undefined);
  }

  async getMessage(id: string): Promise<StoredMessage | null> {
    const item = await this.db.get(this.tables.messages, { id });
    return item ? (item as unknown as StoredMessage) : null;
  }

  async getMessagesByRfcId(rfcMessageId: string): Promise<StoredMessage[]> {
    const items = await this.db.query(this.tables.messages, { index: "rfc", keyName: "rfcMessageId", keyValue: rfcMessageId, limit: 50 });
    return items as unknown as StoredMessage[];
  }

  async listMessages(query?: ListQuery): Promise<StoredMessage[]> {
    const limit = query?.limit ?? 100;
    const filtered = Boolean(query?.unreadOnly || query?.label);
    const perFolder = filtered ? undefined : limit;
    const folders = query?.folder ? [query.folder] : FOLDERS;
    const batches = await Promise.all(
      folders.map((folder) =>
        this.db.query(this.tables.messages, { index: "folder", keyName: "folder", keyValue: folder, limit: perFolder, descending: true }),
      ),
    );
    let messages = batches.flat() as unknown as StoredMessage[];
    if (query?.unreadOnly) messages = messages.filter((message) => message.unread);
    if (query?.label) messages = messages.filter((message) => message.labels?.includes(query.label as string));
    return messages.sort(byDateDesc).slice(0, limit);
  }

  async listThreadMessages(threadId: string): Promise<StoredMessage[]> {
    const items = await this.db.query(this.tables.messages, { index: "thread", keyName: "threadId", keyValue: threadId });
    return items as unknown as StoredMessage[];
  }

  async updateMessage(id: string, patch: MessagePatch, remove: Array<keyof MessagePatch> = []): Promise<StoredMessage> {
    const set: Item = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) set[key] = stripEmpty(value);
    }
    const updated = await this.db.update(this.tables.messages, { id }, { set, ...(remove.length > 0 ? { remove } : {}), condition: { exists: ["id"] } });
    if (!updated) throw new MailError(`No message ${id}`, "not_found");
    return updated as unknown as StoredMessage;
  }

  async listVectors(vecModel: string): Promise<Array<{ id: string; vec: string }>> {
    const items = await this.db.query(this.tables.messages, { index: "vectors", keyName: "vecModel", keyValue: vecModel });
    const rows: Array<{ id: string; vec: string }> = [];
    for (const item of items) {
      if (typeof item.id === "string" && typeof item.vec === "string") rows.push({ id: item.id, vec: item.vec });
    }
    return rows;
  }

  async putThread(thread: Thread): Promise<void> {
    await this.db.put(this.tables.threads, asItem({ ...thread, kind: "thread" }));
  }

  async getThread(id: string): Promise<Thread | null> {
    const item = await this.db.get(this.tables.threads, { id });
    return item ? withoutKind<Thread>(item) : null;
  }

  async listThreads(limit = 200): Promise<Thread[]> {
    const items = await this.db.query(this.tables.threads, { index: "recent", keyName: "kind", keyValue: "thread", limit, descending: true });
    return items.map((item) => withoutKind<Thread>(item));
  }

  async retireThread(id: string): Promise<void> {
    await this.db.update(this.tables.threads, { id }, { remove: ["kind"], set: { messageIds: [], unreadCount: 0 }, condition: { exists: ["id"] } });
  }

  async deleteTrashedMessage(id: string, keepUntil: string): Promise<StoredMessage | null> {
    const deleted = await this.db.delete(this.tables.messages, { id }, { equals: { folder: "trash", keepUntil } });
    return deleted ? (deleted as unknown as StoredMessage) : null;
  }

  async putDraft(draft: Draft): Promise<void> {
    await this.db.put(this.tables.drafts, asItem({ ...draft, kind: "draft" }));
  }

  async getDraft(id: string): Promise<Draft | null> {
    const item = await this.db.get(this.tables.drafts, { id });
    return item ? withoutKind<Draft>(item) : null;
  }

  async listDrafts(limit = 200): Promise<Draft[]> {
    const items = await this.db.query(this.tables.drafts, { index: "recent", keyName: "kind", keyValue: "draft", limit, descending: true });
    return items.map((item) => withoutKind<Draft>(item));
  }

  async claimDraftForSend(id: string, approvalTokenHash: string, at: string): Promise<Draft | null> {
    const updated = await this.db.update(
      this.tables.drafts,
      { id },
      {
        set: { status: "sending", approvalUsedAt: at, updatedAt: at },
        condition: {
          exists: ["id"],
          notExists: ["approvalUsedAt"],
          equals: { approvalTokenHash },
          oneOf: { status: SENDABLE },
        },
      },
    );
    return updated ? withoutKind<Draft>(updated) : null;
  }

  async putAudit(event: AuditEvent): Promise<void> {
    await this.db.put(this.tables.audit, asItem(event));
  }

  async listAudit(limit = 100): Promise<AuditEvent[]> {
    const now = Date.now();
    const days = Array.from({ length: AUDIT_DAYS }, (_, i) => utcDay(new Date(now - i * 86_400_000)));
    const batches = await Promise.all(days.map((day) => this.db.query(this.tables.audit, { keyName: "day", keyValue: day })));
    const events = batches.flat() as unknown as AuditEvent[];
    return events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
  }

  async getBudget(day: string): Promise<number> {
    const item = await this.db.get(this.tables.budget, { day });
    const tokens = item?.tokens;
    return typeof tokens === "number" ? tokens : 0;
  }

  async addBudget(day: string, tokens: number): Promise<number> {
    const updated = await this.db.update(this.tables.budget, { day }, { add: { tokens } });
    const next = updated?.tokens;
    return typeof next === "number" ? next : tokens;
  }

  async getCounter(key: string): Promise<number> {
    const item = await this.db.get(this.tables.budget, { day: `counter:${key}` });
    const count = item?.count;
    return typeof count === "number" ? count : 0;
  }

  /** `expiresAt` is epoch seconds, the table's TTL attribute; DynamoDB deletes the row some time after. */
  async bumpCounter(key: string, expiresAt: Date): Promise<number> {
    const updated = await this.db.update(
      this.tables.budget,
      { day: `counter:${key}` },
      { add: { count: 1 }, set: { expiresAt: Math.floor(expiresAt.getTime() / 1000) } },
    );
    const next = updated?.count;
    return typeof next === "number" ? next : 1;
  }

  async putContact(contact: Contact, opts?: { ifAbsent?: boolean }): Promise<boolean> {
    const item = asItem({ ...contact, email: contact.email.toLowerCase(), kind: "contact" });
    return this.db.put(this.tables.contacts, item, opts?.ifAbsent ? { ifAbsent: "email" } : undefined);
  }

  async getContact(email: string): Promise<Contact | null> {
    const item = await this.db.get(this.tables.contacts, { email: email.toLowerCase() });
    return item ? withoutKind<Contact>(item) : null;
  }

  async listContacts(): Promise<Contact[]> {
    const items = await this.db.query(this.tables.contacts, { index: "all", keyName: "kind", keyValue: "contact" });
    return items.map((item) => withoutKind<Contact>(item));
  }
}
