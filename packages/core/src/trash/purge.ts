import { aiContextKey, bodyKey, botCopyKey, type BlobStore } from "../blob/store.ts";
import { newId, utcDay } from "../ids.ts";
import { refreshThread } from "../ingest.ts";
import type { MailStore } from "../store/types.ts";
import type { StoredMessage } from "../types.ts";

/**
 * `report` (the default) only audits what is due. `purge` hard deletes. Terraform's
 * `trash_purge_mode` sets LOJO_TRASH_PURGE and grants the delete permissions only for `purge`.
 */
export type PurgeMode = "off" | "report" | "purge";

/** Independent of `keepUntil`: nothing trashed less than this long ago is ever deleted, whatever its window says. */
export const PURGE_MIN_AGE_DAYS = 7;
export const PURGE_MAX_PER_RUN = 100;
/** How much of trash one run reads. More than this waits for later runs. */
const TRASH_SCAN_LIMIT = 5000;
const DAY_MS = 86_400_000;

export function purgeModeFrom(value: string | undefined): PurgeMode {
  switch (value) {
    case "off":
    case "purge":
      return value;
    default:
      return "report";
  }
}

export interface PurgeDeps {
  store: MailStore;
  blobs: BlobStore;
  now: Date;
  mode: PurgeMode;
  maxPerRun?: number;
}

export interface PurgeResult {
  mode: PurgeMode;
  inTrash: number;
  due: number;
  /** In trash without trashedAt/keepUntil. Never purged; move out and back in to start a window. */
  unmarked: number;
  purged: number;
  /** Restored or re-trashed between the listing and the delete. */
  changed: number;
  blobFailures: number;
}

export function isPurgeDue(message: StoredMessage, now: Date): boolean {
  if (message.folder !== "trash" || !message.keepUntil || !message.trashedAt) return false;
  const keepUntil = Date.parse(message.keepUntil);
  const trashedAt = Date.parse(message.trashedAt);
  if (!Number.isFinite(keepUntil) || !Number.isFinite(trashedAt)) return false;
  return keepUntil <= now.getTime() && now.getTime() - trashedAt >= PURGE_MIN_AGE_DAYS * DAY_MS;
}

/** Only keys this message owns: a tampered row cannot point the purge at another object. */
export function ownedBlobKeys(message: StoredMessage): string[] {
  const keys = new Set<string>([bodyKey(message.id)]);
  if (message.aiContextKey === aiContextKey(message.id)) keys.add(message.aiContextKey);
  for (const attachment of message.attachments ?? []) {
    if (attachment.blobKey.startsWith(`objects/${message.id}/`) && !attachment.blobKey.includes("..")) keys.add(attachment.blobKey);
  }
  if (message.botKeyId && message.botBodyKey === botCopyKey(message.id, message.botKeyId) && !message.botBodyKey.includes("..")) keys.add(message.botBodyKey);
  return [...keys];
}

/**
 * Empties trash after the retention window. The only code that hard deletes mail,
 * run on a schedule by its own Lambda role. Each delete is conditional on the row
 * still being in trash with the same window, the thread is refreshed, and every
 * step is audited (message ids and dates only, never content).
 */
export async function purgeExpiredTrash(deps: PurgeDeps): Promise<PurgeResult> {
  const { store, now, mode } = deps;
  const result: PurgeResult = { mode, inTrash: 0, due: 0, unmarked: 0, purged: 0, changed: 0, blobFailures: 0 };
  if (mode === "off") return result;
  const audit = (action: string, outcome: string, extra: { messageId?: string; detail?: string } = {}) =>
    store.putAudit({ id: newId("aud"), day: utcDay(now), at: now.toISOString(), action, outcome, ...extra });

  const trash = await store.listMessages({ folder: "trash", limit: TRASH_SCAN_LIMIT });
  result.inTrash = trash.length;
  result.unmarked = trash.filter((message) => !message.keepUntil || !message.trashedAt).length;
  const due = trash.filter((message) => isPurgeDue(message, now)).sort((a, b) => ((a.keepUntil ?? "") < (b.keepUntil ?? "") ? -1 : 1));
  result.due = due.length;

  if (mode === "report") {
    await audit("trash.purge_report", "report", { detail: `inTrash:${result.inTrash} due:${result.due} unmarked:${result.unmarked}` });
    return result;
  }

  const batch = due.slice(0, deps.maxPerRun ?? PURGE_MAX_PER_RUN);
  for (const message of batch) {
    const deleted = await store.deleteTrashedMessage(message.id, message.keepUntil ?? "");
    if (!deleted) {
      result.changed += 1;
      await audit("trash.purge_skipped", "changed", { messageId: message.id });
      continue;
    }
    for (const key of ownedBlobKeys(deleted)) {
      try {
        await deps.blobs.delete(key);
      } catch (error) {
        result.blobFailures += 1;
        await audit("trash.purge_blob_failed", "error", { messageId: message.id, detail: `${key} ${error instanceof Error ? error.name : "error"}` });
      }
    }
    await refreshThread(store, deleted.threadId, "");
    result.purged += 1;
    await audit("trash.purged", "deleted", {
      messageId: message.id,
      detail: `trashedBy:${deleted.trashedBy ?? ""} trashedAt:${deleted.trashedAt ?? ""} keepUntil:${deleted.keepUntil ?? ""}`,
    });
  }
  await audit("trash.purge_run", result.blobFailures > 0 ? "partial" : "ok", {
    detail: `inTrash:${result.inTrash} due:${result.due} purged:${result.purged} changed:${result.changed} unmarked:${result.unmarked} backlog:${result.due - batch.length}`,
  });
  return result;
}
