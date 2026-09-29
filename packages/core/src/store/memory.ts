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
import type { MailStore } from "./types.ts";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function matches(message: StoredMessage, query: ListQuery | undefined): boolean {
  if (!query) return true;
  if (query.folder && message.folder !== query.folder) return false;
  if (query.unreadOnly && !message.unread) return false;
  if (query.label && !message.labels.includes(query.label)) return false;
  return true;
}

export interface MemorySnapshot {
  messages: StoredMessage[];
  threads: Thread[];
  drafts: Draft[];
  audit: AuditEvent[];
  contacts: Contact[];
  budget: Record<string, number>;
  imports: Record<string, string>;
}

export class MemoryStore implements MailStore {
  private messages = new Map<string, StoredMessage>();
  private threads = new Map<string, Thread>();
  private drafts = new Map<string, Draft>();
  private audit: AuditEvent[] = [];
  private contacts = new Map<string, Contact>();
  private budget = new Map<string, number>();
  private imports = new Map<string, string>();

  async putMessage(message: StoredMessage): Promise<void> {
    this.messages.set(message.id, clone(message));
  }

  async getMessage(id: string): Promise<StoredMessage | null> {
    const found = this.messages.get(id);
    return found ? clone(found) : null;
  }

  async getMessageByRfcId(rfcMessageId: string): Promise<StoredMessage | null> {
    for (const message of this.messages.values()) {
      if (message.rfcMessageId === rfcMessageId) return clone(message);
    }
    return null;
  }

  async listMessages(query?: ListQuery): Promise<StoredMessage[]> {
    const limit = query?.limit ?? 200;
    return [...this.messages.values()]
      .filter((message) => matches(message, query))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, limit)
      .map((message) => clone(message));
  }

  async updateMessage(id: string, patch: MessagePatch): Promise<StoredMessage> {
    const current = this.messages.get(id);
    if (!current) throw new MailError(`No message ${id}`, "not_found");
    const next: StoredMessage = { ...current, ...clone(patch) };
    this.messages.set(id, next);
    return clone(next);
  }

  async putThread(thread: Thread): Promise<void> {
    this.threads.set(thread.id, clone(thread));
  }

  async getThread(id: string): Promise<Thread | null> {
    const found = this.threads.get(id);
    return found ? clone(found) : null;
  }

  async listThreads(): Promise<Thread[]> {
    return [...this.threads.values()]
      .sort((a, b) => (a.lastDate < b.lastDate ? 1 : -1))
      .map((thread) => clone(thread));
  }

  async putDraft(draft: Draft): Promise<void> {
    this.drafts.set(draft.id, clone(draft));
  }

  async getDraft(id: string): Promise<Draft | null> {
    const found = this.drafts.get(id);
    return found ? clone(found) : null;
  }

  async listDrafts(): Promise<Draft[]> {
    return [...this.drafts.values()]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((draft) => clone(draft));
  }

  async putAudit(event: AuditEvent): Promise<void> {
    this.audit.push(clone(event));
  }

  async listAudit(limit = 100): Promise<AuditEvent[]> {
    return this.audit.slice(-limit).reverse().map((event) => clone(event));
  }

  async getBudget(day: string): Promise<number> {
    return this.budget.get(day) ?? 0;
  }

  async addBudget(day: string, tokens: number): Promise<number> {
    const next = (this.budget.get(day) ?? 0) + tokens;
    this.budget.set(day, next);
    return next;
  }

  async putContact(contact: Contact): Promise<void> {
    this.contacts.set(contact.email.toLowerCase(), clone({ ...contact, email: contact.email.toLowerCase() }));
  }

  async getContact(email: string): Promise<Contact | null> {
    const found = this.contacts.get(email.toLowerCase());
    return found ? clone(found) : null;
  }

  async listContacts(): Promise<Contact[]> {
    return [...this.contacts.values()].map((contact) => clone(contact));
  }

  async markImported(key: string, messageId: string): Promise<boolean> {
    if (this.imports.has(key)) return false;
    this.imports.set(key, messageId);
    return true;
  }

  async isImported(key: string): Promise<boolean> {
    return this.imports.has(key);
  }

  snapshot(): MemorySnapshot {
    return {
      messages: [...this.messages.values()].map((message) => clone(message)),
      threads: [...this.threads.values()].map((thread) => clone(thread)),
      drafts: [...this.drafts.values()].map((draft) => clone(draft)),
      audit: this.audit.map((event) => clone(event)),
      contacts: [...this.contacts.values()].map((contact) => clone(contact)),
      budget: Object.fromEntries(this.budget),
      imports: Object.fromEntries(this.imports),
    };
  }

  static fromSnapshot(snapshot: MemorySnapshot): MemoryStore {
    const store = new MemoryStore();
    for (const message of snapshot.messages) store.messages.set(message.id, clone(message));
    for (const thread of snapshot.threads) store.threads.set(thread.id, clone(thread));
    for (const draft of snapshot.drafts) store.drafts.set(draft.id, clone(draft));
    store.audit = snapshot.audit.map((event) => clone(event));
    for (const contact of snapshot.contacts) store.contacts.set(contact.email.toLowerCase(), clone(contact));
    for (const [day, tokens] of Object.entries(snapshot.budget)) store.budget.set(day, tokens);
    for (const [key, messageId] of Object.entries(snapshot.imports)) store.imports.set(key, messageId);
    return store;
  }
}
