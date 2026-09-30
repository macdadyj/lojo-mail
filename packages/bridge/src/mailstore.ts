import { EventEmitter } from "node:events";
import { assertNever, FOLDERS, type EcPrivateJwk, type Folder, type MessageView, type SealedBody } from "@lojo/core";
import { attachmentContext, messageBodyContext, openBytes, openJson } from "@lojo/core/crypto";
import { ApiError, type ApiClient } from "./api.ts";
import { ByteLru } from "./cache.ts";
import { flagsFor, hasFlag, HIDDEN_LABEL, labelsFor, sameSet } from "./flags.ts";
import { errorMessage, type Logger } from "./log.ts";
import { buildMessage, lockedBody, type AttachmentContent, type BodyContent, type BuiltMessage } from "./mime.ts";
import type { UidState } from "./state.ts";

export interface MailboxDef {
  name: string;
  folder: Folder;
  specialUse: string | null;
  /** Archive and Trash hide messages Thunderbird deleted (see HIDDEN_LABEL). */
  hidesDeleted: boolean;
}

export function mailboxFor(folder: Folder): MailboxDef {
  switch (folder) {
    case "inbox":
      return { name: "INBOX", folder, specialUse: null, hidesDeleted: false };
    case "archive":
      return { name: "Archive", folder, specialUse: "\\Archive", hidesDeleted: true };
    case "sent":
      return { name: "Sent", folder, specialUse: "\\Sent", hidesDeleted: false };
    case "drafts":
      return { name: "Drafts", folder, specialUse: "\\Drafts", hidesDeleted: false };
    case "spam":
      return { name: "Junk", folder, specialUse: "\\Junk", hidesDeleted: false };
    case "trash":
      return { name: "Trash", folder, specialUse: "\\Trash", hidesDeleted: true };
    default:
      return assertNever(folder, "folder");
  }
}

const ORDER: Folder[] = ["inbox", "drafts", "sent", "archive", "spam", "trash"];

export const MAILBOXES: MailboxDef[] = [...FOLDERS].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).map(mailboxFor);

export function findMailbox(name: string): MailboxDef | null {
  const wanted = name.toUpperCase() === "INBOX" ? "INBOX" : name;
  return MAILBOXES.find((box) => box.name === wanted) ?? MAILBOXES.find((box) => box.name.toLowerCase() === name.toLowerCase()) ?? null;
}

/** The service cannot do what was asked (IMAP `NO [CANNOT]`). */
export class CannotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CannotError";
  }
}

export interface Entry {
  uid: number;
  id: string;
}

export interface MailStoreOptions {
  folderLimit: number;
  /** The token holds `trash` and bridge.json allows it: delete moves to Trash. */
  canTrash?: boolean;
  cacheBytes?: number;
  concurrency?: number;
}

/**
 * Shared by every IMAP connection: one API client, one view of each folder,
 * one plaintext cache. Emits `changed` after it changes anything on the service.
 */
export class MailStore extends EventEmitter {
  private readonly views = new Map<string, MessageView>();
  private readonly deleted = new Set<string>();
  private readonly listing = new Map<string, Promise<Entry[]>>();
  private readonly building = new Map<string, Promise<BuiltMessage>>();
  private readonly cache: ByteLru<BuiltMessage>;
  private readonly waiting: Array<() => void> = [];
  private active = 0;
  private readonly concurrency: number;

  constructor(
    private readonly api: ApiClient,
    private readonly state: UidState,
    private readonly privateJwk: EcPrivateJwk,
    private readonly logger: Logger,
    private readonly options: MailStoreOptions,
  ) {
    super();
    this.setMaxListeners(100);
    this.cache = new ByteLru(options.cacheBytes ?? 64 * 1024 * 1024);
    this.concurrency = options.concurrency ?? 4;
  }

  uidValidity(box: MailboxDef): number {
    return this.state.uidValidity(box.name);
  }

  uidNext(box: MailboxDef): number {
    return this.state.uidNext(box.name);
  }

  list(box: MailboxDef): Promise<Entry[]> {
    const running = this.listing.get(box.name);
    if (running) return running;
    const next = this.fetchList(box).finally(() => this.listing.delete(box.name));
    this.listing.set(box.name, next);
    return next;
  }

  private async fetchList(box: MailboxDef): Promise<Entry[]> {
    const views = await this.api.listFolder(box.folder, this.options.folderLimit);
    const visible = box.hidesDeleted ? views.filter((view) => !view.labels.includes(HIDDEN_LABEL)) : views;
    for (const view of visible) this.views.set(view.id, view);
    const ordered = [...visible].reverse().map((view) => view.id);
    const uids = this.state.assign(box.name, ordered);
    return ordered.map((id) => ({ id, uid: uids.get(id) ?? 0 })).sort((a, b) => a.uid - b.uid);
  }

  view(id: string): MessageView | undefined {
    return this.views.get(id);
  }

  flags(id: string): string[] {
    const view = this.views.get(id);
    return view ? flagsFor(view, this.deleted.has(id)) : [];
  }

  private requireView(id: string): MessageView {
    const view = this.views.get(id);
    if (!view) throw new CannotError("The message is no longer known to the bridge");
    return view;
  }

  async setFlags(id: string, flags: readonly string[]): Promise<void> {
    const view = this.requireView(id);
    const seen = hasFlag(flags, "\\Seen");
    if (seen === view.unread) {
      await this.api.setUnread(id, !seen);
      view.unread = !seen;
    }
    if (hasFlag(flags, "\\Deleted")) this.deleted.add(id);
    else this.deleted.delete(id);
    const labels = labelsFor(view.labels, flags);
    if (!sameSet(labels, view.labels)) {
      await this.api.setLabels(id, labels);
      view.labels = labels;
    }
    this.emit("changed");
  }

  isDeleted(id: string): boolean {
    return this.deleted.has(id);
  }

  get deletesToTrash(): boolean {
    return this.options.canTrash === true;
  }

  /**
   * What Thunderbird calls delete. With the `trash` scope the message moves to
   * Trash, where the service keeps it for the retention window. Without it, or
   * when it is already in Trash, the message is labelled and hidden (and archived
   * if needed). Nothing here is ever a hard delete.
   */
  async remove(id: string, from: MailboxDef): Promise<void> {
    const view = this.requireView(id);
    if (this.deletesToTrash && from.folder !== "trash") {
      await this.api.move(id, "trash");
      view.folder = "trash";
      this.deleted.delete(id);
      this.emit("changed");
      return;
    }
    if (!view.labels.includes(HIDDEN_LABEL)) {
      const labels = [...view.labels, HIDDEN_LABEL];
      await this.api.setLabels(id, labels);
      view.labels = labels;
    }
    if (from.folder !== "archive" && from.folder !== "trash") {
      await this.api.archive(id);
      view.folder = "archive";
    }
    this.deleted.delete(id);
    this.emit("changed");
  }

  async moveTo(id: string, from: MailboxDef, to: MailboxDef): Promise<void> {
    switch (to.folder) {
      case "trash":
        await this.remove(id, from);
        return;
      case "sent":
      case "drafts":
        throw new CannotError(`Messages cannot be filed in ${to.name}`);
      case "archive":
        await this.api.archive(id);
        break;
      case "inbox":
      case "spam":
        await this.api.move(id, to.folder);
        break;
      default:
        assertNever(to.folder, "folder");
    }
    const view = this.views.get(id);
    if (view) view.folder = to.folder;
    this.deleted.delete(id);
    this.emit("changed");
  }

  async markSeen(id: string): Promise<void> {
    const view = this.requireView(id);
    if (!view.unread) return;
    await this.api.setUnread(id, false);
    view.unread = false;
    this.emit("changed");
  }

  async size(id: string): Promise<number> {
    return this.state.size(id) ?? (await this.message(id)).raw.length;
  }

  message(id: string): Promise<BuiltMessage> {
    const cached = this.cache.get(id);
    if (cached) return Promise.resolve(cached);
    const running = this.building.get(id);
    if (running) return running;
    const next = this.withSlot(() => this.build(id)).finally(() => this.building.delete(id));
    this.building.set(id, next);
    return next;
  }

  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }

  private async openBody(id: string, view: MessageView): Promise<{ body: BodyContent; complete: boolean }> {
    try {
      const envelope = await this.api.bodyEnvelope(id);
      const sealed = await openJson<SealedBody>(envelope, this.privateJwk, messageBodyContext(id));
      return { body: { text: typeof sealed.text === "string" ? sealed.text : "", html: typeof sealed.html === "string" ? sealed.html : "" }, complete: true };
    } catch (error) {
      if (typeof view.text === "string") return { body: { text: view.text, html: view.html ?? "" }, complete: true };
      const reason = error instanceof ApiError ? `the API answered ${error.status || "nothing"}` : "the envelope key did not open it";
      this.logger.warn("message.locked", { id, reason });
      return { body: lockedBody(reason), complete: false };
    }
  }

  private async openAttachment(id: string, attachmentId: string): Promise<Uint8Array | null> {
    try {
      const payload = await this.api.attachment(id, attachmentId);
      switch (payload.kind) {
        case "bytes":
          return payload.bytes;
        case "envelope":
          return await openBytes(payload.envelope, this.privateJwk, attachmentContext(id, attachmentId));
        default:
          return assertNever(payload, "attachment payload");
      }
    } catch (error) {
      this.logger.warn("attachment.unavailable", { id, attachmentId, reason: errorMessage(error) });
      return null;
    }
  }

  private async build(id: string): Promise<BuiltMessage> {
    let view = this.views.get(id);
    if (!view) {
      view = await this.api.message(id);
      this.views.set(id, view);
    }
    const { body, complete } = await this.openBody(id, view);
    const attachments: AttachmentContent[] = [];
    let allAttachments = complete;
    if (complete) {
      for (const meta of view.attachments) {
        const bytes = await this.openAttachment(id, meta.id);
        if (!bytes) allAttachments = false;
        attachments.push({ filename: meta.filename, contentType: meta.contentType, bytes });
      }
    }
    const built = buildMessage(view, body, attachments);
    this.cache.set(id, built, built.raw.length + built.searchText.length * 2);
    if (allAttachments) this.state.setSize(id, built.raw.length);
    return built;
  }
}
