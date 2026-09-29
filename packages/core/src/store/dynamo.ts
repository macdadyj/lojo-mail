import { MailError } from "../errors.ts";
import type {
  AuditEvent,
  Contact,
  Draft,
  ListQuery,
  MessagePatch,
  StoredMessage,
  Thread,
} from "../types.ts";
import type { DynamoLike, MailStore, TableNames } from "./types.ts";

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

export class DynamoMailStore implements MailStore {
  constructor(
    private readonly db: DynamoLike,
    private readonly tables: TableNames,
  ) {}

  async putMessage(message: StoredMessage): Promise<void> {
    await this.db.put(this.tables.messages, stripEmpty(message) as Record<string, unknown>);
  }

  async getMessage(id: string): Promise<StoredMessage | null> {
    const item = await this.db.get(this.tables.messages, { id });
    return item ? (item as unknown as StoredMessage) : null;
  }

  async getMessageByRfcId(rfcMessageId: string): Promise<StoredMessage | null> {
    const items = await this.db.scan(this.tables.messages, 500);
    const found = items.find((item) => item.rfcMessageId === rfcMessageId);
    return found ? (found as unknown as StoredMessage) : null;
  }

  async listMessages(query?: ListQuery): Promise<StoredMessage[]> {
    const limit = query?.limit ?? 100;
    let items: Record<string, unknown>[];
    if (query?.folder) {
      items = await this.db.query(this.tables.messages, {
        index: "folder",
        keyName: "folder",
        keyValue: query.folder,
        limit,
        descending: true,
      });
    } else {
      items = await this.db.scan(this.tables.messages, limit);
    }
    let messages = items as unknown as StoredMessage[];
    if (query?.unreadOnly) messages = messages.filter((message) => message.unread);
    if (query?.label) messages = messages.filter((message) => message.labels?.includes(query.label as string));
    return messages.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, limit);
  }

  async updateMessage(id: string, patch: MessagePatch): Promise<StoredMessage> {
    const current = await this.getMessage(id);
    if (!current) throw new MailError(`No message ${id}`, "not_found");
    const next = { ...current, ...patch };
    await this.putMessage(next);
    return next;
  }

  async putThread(thread: Thread): Promise<void> {
    await this.db.put(this.tables.threads, stripEmpty(thread) as Record<string, unknown>);
  }

  async getThread(id: string): Promise<Thread | null> {
    const item = await this.db.get(this.tables.threads, { id });
    return item ? (item as unknown as Thread) : null;
  }

  async listThreads(): Promise<Thread[]> {
    const items = (await this.db.scan(this.tables.threads, 200)) as unknown as Thread[];
    return items.sort((a, b) => (a.lastDate < b.lastDate ? 1 : -1));
  }

  async putDraft(draft: Draft): Promise<void> {
    await this.db.put(this.tables.drafts, stripEmpty(draft) as Record<string, unknown>);
  }

  async getDraft(id: string): Promise<Draft | null> {
    const item = await this.db.get(this.tables.drafts, { id });
    return item ? (item as unknown as Draft) : null;
  }

  async listDrafts(): Promise<Draft[]> {
    const items = (await this.db.scan(this.tables.drafts, 200)) as unknown as Draft[];
    return items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async putAudit(event: AuditEvent): Promise<void> {
    await this.db.put(this.tables.audit, stripEmpty(event) as Record<string, unknown>);
  }

  async listAudit(limit = 100): Promise<AuditEvent[]> {
    const items = (await this.db.scan(this.tables.audit, limit)) as unknown as AuditEvent[];
    return items.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
  }

  async getBudget(day: string): Promise<number> {
    const item = await this.db.get(this.tables.budget, { day });
    const tokens = item?.tokens;
    return typeof tokens === "number" ? tokens : 0;
  }

  async addBudget(day: string, tokens: number): Promise<number> {
    const used = await this.getBudget(day);
    const next = used + tokens;
    await this.db.put(this.tables.budget, { day, tokens: next });
    return next;
  }

  async putContact(contact: Contact): Promise<void> {
    await this.db.put(this.tables.contacts, stripEmpty({ ...contact, email: contact.email.toLowerCase() }) as Record<string, unknown>);
  }

  async getContact(email: string): Promise<Contact | null> {
    const item = await this.db.get(this.tables.contacts, { email: email.toLowerCase() });
    return item ? (item as unknown as Contact) : null;
  }

  async listContacts(): Promise<Contact[]> {
    return (await this.db.scan(this.tables.contacts, 500)) as unknown as Contact[];
  }

  async markImported(key: string, messageId: string): Promise<boolean> {
    return this.db.put(this.tables.imports, { key, messageId, at: new Date().toISOString() }, "key");
  }

  async isImported(key: string): Promise<boolean> {
    const item = await this.db.get(this.tables.imports, { key });
    return item !== null;
  }
}
