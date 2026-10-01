import type { BotRegistry } from "../bots/registry.ts";
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
  /** Returns false when `ifAbsent` is set and the id already exists. */
  putMessage(message: StoredMessage, opts?: { ifAbsent?: boolean }): Promise<boolean>;
  getMessage(id: string): Promise<StoredMessage | null>;
  /** Message-ID is sender-controlled, so several deliveries can share one. */
  getMessagesByRfcId(rfcMessageId: string): Promise<StoredMessage[]>;
  listMessages(query?: ListQuery): Promise<StoredMessage[]>;
  /** Oldest first. */
  listThreadMessages(threadId: string): Promise<StoredMessage[]>;
  /** `remove` drops attributes, for example the trash markers on restore. */
  updateMessage(id: string, patch: MessagePatch, remove?: Array<keyof MessagePatch>): Promise<StoredMessage>;
  /** Every stored vector made by one embedder, from the sparse `vectors` index (id, date, vec only). */
  listVectors(vecModel: string): Promise<Array<{ id: string; vec: string }>>;

  putThread(thread: Thread): Promise<void>;
  getThread(id: string): Promise<Thread | null>;
  listThreads(limit?: number): Promise<Thread[]>;
  /** Drops an emptied thread out of the listing index. Threads are never deleted. */
  retireThread(id: string): Promise<void>;
  /**
   * The only hard delete, used by the trash purge alone: removes the message
   * row only if it is still in trash with exactly this `keepUntil`, so a
   * restore (or a new trash with a new window) in between wins. Returns the
   * deleted row, or null when the condition failed.
   */
  deleteTrashedMessage(id: string, keepUntil: string): Promise<StoredMessage | null>;

  putDraft(draft: Draft): Promise<void>;
  getDraft(id: string): Promise<Draft | null>;
  listDrafts(limit?: number): Promise<Draft[]>;
  /**
   * Atomically moves an approved draft to `sending` and marks the approval used.
   * Returns null when the token hash does not match, the approval was already
   * used, or the draft is not in a sendable state.
   */
  claimDraftForSend(id: string, approvalTokenHash: string, at: string): Promise<Draft | null>;

  putAudit(event: AuditEvent): Promise<void>;
  listAudit(limit?: number): Promise<AuditEvent[]>;

  getBudget(day: string): Promise<number>;
  addBudget(day: string, tokens: number): Promise<number>;
  /** Short-lived shared counters (login failures per source). Kept in the budget table with a TTL. */
  getCounter(key: string): Promise<number>;
  bumpCounter(key: string, expiresAt: Date): Promise<number>;

  /** Jon's bot credentials and the bot envelope key: one item in the budget table, no TTL. */
  getBotRegistry(): Promise<BotRegistry | null>;
  /** Conditional on the stored version (`null`: nothing stored yet). Returns false when another save won. */
  saveBotRegistry(registry: BotRegistry, expectedVersion: number | null): Promise<boolean>;

  /** Returns false when `ifAbsent` is set and the contact already exists. */
  putContact(contact: Contact, opts?: { ifAbsent?: boolean }): Promise<boolean>;
  getContact(email: string): Promise<Contact | null>;
  listContacts(): Promise<Contact[]>;
}

export type Item = Record<string, unknown>;

/** All clauses are ANDed. */
export interface Condition {
  exists?: string[];
  notExists?: string[];
  equals?: Record<string, unknown>;
  oneOf?: Record<string, unknown[]>;
}

export interface QueryOptions {
  index?: string;
  keyName: string;
  keyValue: string;
  /** Stop after this many items. Omit to read every page. */
  limit?: number;
  descending?: boolean;
}

export interface UpdateOptions {
  set?: Item;
  remove?: string[];
  add?: Record<string, number>;
  condition?: Condition;
}

/** The DynamoDB surface the store needs. There is deliberately no scan, and delete always takes a condition. */
export interface DynamoLike {
  get(table: string, key: Record<string, string>): Promise<Item | null>;
  put(table: string, item: Item, opts?: { ifAbsent?: string }): Promise<boolean>;
  /** Paginates internally until `limit` or the last page. */
  query(table: string, opts: QueryOptions): Promise<Item[]>;
  /** Returns the updated item, or null when the condition failed. */
  update(table: string, key: Record<string, string>, opts: UpdateOptions): Promise<Item | null>;
  /** Returns the deleted item, or null when the condition failed. Only the trash purge role may call DeleteItem. */
  delete(table: string, key: Record<string, string>, condition: Condition): Promise<Item | null>;
}

export interface TableNames {
  messages: string;
  threads: string;
  drafts: string;
  audit: string;
  contacts: string;
  budget: string;
}

export const DEFAULT_TABLE_NAMES: TableNames = {
  messages: "lojo-mail-messages",
  threads: "lojo-mail-threads",
  drafts: "lojo-mail-drafts",
  audit: "lojo-mail-audit",
  contacts: "lojo-mail-contacts",
  budget: "lojo-mail-budget",
};

export interface KeySchema {
  hashKey: string;
  rangeKey?: string;
  /** Non-key attributes an INCLUDE index carries. Omitted means ALL. */
  include?: string[];
}

export interface TableSchema extends KeySchema {
  indexes: Record<string, KeySchema>;
}

/** Mirrors infra/terraform/dynamodb.tf. MemoryDynamo refuses queries on anything else. */
export const TABLE_SCHEMAS: Record<keyof TableNames, TableSchema> = {
  messages: {
    hashKey: "id",
    indexes: {
      folder: { hashKey: "folder", rangeKey: "date" },
      thread: { hashKey: "threadId", rangeKey: "date" },
      rfc: { hashKey: "rfcMessageId", rangeKey: "date" },
      vectors: { hashKey: "vecModel", rangeKey: "date", include: ["vec"] },
    },
  },
  threads: { hashKey: "id", indexes: { recent: { hashKey: "kind", rangeKey: "lastDate" } } },
  drafts: { hashKey: "id", indexes: { recent: { hashKey: "kind", rangeKey: "updatedAt" } } },
  audit: { hashKey: "day", rangeKey: "id", indexes: {} },
  contacts: { hashKey: "email", indexes: { all: { hashKey: "kind", rangeKey: "email" } } },
  budget: { hashKey: "day", indexes: {} },
};
