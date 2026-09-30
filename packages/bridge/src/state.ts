import { readFileSync } from "node:fs";
import { writePrivateFile } from "./config.ts";
import type { Logger } from "./log.ts";

interface MailboxState {
  uidValidity: number;
  uidNext: number;
  uids: Record<string, number>;
}

/** Message ids, UIDs, and sizes only. Nothing derived from message content beyond its byte length. */
interface StateFile {
  version: 1;
  mailboxes: Record<string, MailboxState>;
  sizes: Record<string, number>;
}

function isStateFile(value: unknown): value is StateFile {
  if (typeof value !== "object" || value === null) return false;
  const file = value as Partial<StateFile>;
  return file.version === 1 && typeof file.mailboxes === "object" && file.mailboxes !== null && typeof file.sizes === "object" && file.sizes !== null;
}

export class UidState {
  private data: StateFile;
  private timer: NodeJS.Timeout | null = null;
  private lastValidity = 0;

  constructor(
    private readonly path: string | null,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.data = { version: 1, mailboxes: {}, sizes: {} };
    if (!path) return;
    let text: string | null = null;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      text = null;
    }
    if (text === null) return;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isStateFile(parsed)) this.data = parsed;
      else logger.warn("state.unreadable", { reason: "shape" });
    } catch {
      logger.warn("state.unreadable", { reason: "json" });
    }
    for (const box of Object.values(this.data.mailboxes)) this.lastValidity = Math.max(this.lastValidity, box.uidValidity);
  }

  /** A mailbox with no saved state gets a new UIDVALIDITY, so clients drop any UIDs they cached before the state was lost. */
  private box(name: string): MailboxState {
    let box = this.data.mailboxes[name];
    if (!box) {
      const validity = Math.max(Math.floor(this.now() / 1000), this.lastValidity + 1) >>> 0 || 1;
      this.lastValidity = validity;
      box = { uidValidity: validity, uidNext: 1, uids: {} };
      this.data.mailboxes[name] = box;
      this.scheduleSave();
    }
    return box;
  }

  uidValidity(name: string): number {
    return this.box(name).uidValidity;
  }

  uidNext(name: string): number {
    return this.box(name).uidNext;
  }

  /**
   * `ids` is the mailbox as listed now, oldest first. Ids that left the mailbox
   * lose their UID, so a message that comes back gets a new, higher one.
   */
  assign(name: string, ids: string[]): Map<string, number> {
    const box = this.box(name);
    const present = new Set(ids);
    let changed = false;
    for (const id of Object.keys(box.uids)) {
      if (present.has(id)) continue;
      delete box.uids[id];
      changed = true;
    }
    const out = new Map<string, number>();
    for (const id of ids) {
      let uid = box.uids[id];
      if (uid === undefined) {
        uid = box.uidNext;
        box.uidNext += 1;
        box.uids[id] = uid;
        changed = true;
      }
      out.set(id, uid);
    }
    if (changed) this.scheduleSave();
    return out;
  }

  size(id: string): number | undefined {
    return this.data.sizes[id];
  }

  setSize(id: string, size: number): void {
    if (this.data.sizes[id] === size) return;
    this.data.sizes[id] = size;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (!this.path || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 200);
    this.timer.unref();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.path) return;
    const known = new Set(Object.values(this.data.mailboxes).flatMap((box) => Object.keys(box.uids)));
    for (const id of Object.keys(this.data.sizes)) if (!known.has(id)) delete this.data.sizes[id];
    try {
      writePrivateFile(this.path, JSON.stringify(this.data));
    } catch (error) {
      this.logger.error("state.write_failed", { reason: error instanceof Error ? error.name : "unknown" });
    }
  }
}
