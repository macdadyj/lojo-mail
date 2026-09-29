import type {
  AuditEvent,
  Contact,
  Draft,
  ListQuery,
  MessagePatch,
  StoredMessage,
  Thread,
} from "../types.ts";

export interface MailStore {
  putMessage(message: StoredMessage): Promise<void>;
  getMessage(id: string): Promise<StoredMessage | null>;
  getMessageByRfcId(rfcMessageId: string): Promise<StoredMessage | null>;
  listMessages(query?: ListQuery): Promise<StoredMessage[]>;
  updateMessage(id: string, patch: MessagePatch): Promise<StoredMessage>;

  putThread(thread: Thread): Promise<void>;
  getThread(id: string): Promise<Thread | null>;
  listThreads(): Promise<Thread[]>;

  putDraft(draft: Draft): Promise<void>;
  getDraft(id: string): Promise<Draft | null>;
  listDrafts(): Promise<Draft[]>;

  putAudit(event: AuditEvent): Promise<void>;
  listAudit(limit?: number): Promise<AuditEvent[]>;

  getBudget(day: string): Promise<number>;
  addBudget(day: string, tokens: number): Promise<number>;

  putContact(contact: Contact): Promise<void>;
  getContact(email: string): Promise<Contact | null>;
  listContacts(): Promise<Contact[]>;

  /** Returns false when the key was already imported. */
  markImported(key: string, messageId: string): Promise<boolean>;
  isImported(key: string): Promise<boolean>;
}

export interface DynamoLike {
  get(table: string, key: Record<string, string>): Promise<Record<string, unknown> | null>;
  put(table: string, item: Record<string, unknown>, ifAbsentKey?: string): Promise<boolean>;
  query(table: string, opts: {
    index?: string;
    keyName: string;
    keyValue: string;
    limit?: number;
    descending?: boolean;
  }): Promise<Record<string, unknown>[]>;
  scan(table: string, limit?: number): Promise<Record<string, unknown>[]>;
  update(table: string, key: Record<string, string>, patch: Record<string, unknown>): Promise<void>;
}

export interface TableNames {
  messages: string;
  threads: string;
  drafts: string;
  audit: string;
  contacts: string;
  budget: string;
  imports: string;
}
