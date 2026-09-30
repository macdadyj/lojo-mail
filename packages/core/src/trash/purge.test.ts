import assert from "node:assert/strict";
import test from "node:test";
import { bodyKey } from "../blob/store.ts";
import type { MailStore } from "../store/types.ts";
import { fixture, memoryWorld } from "../testing.ts";
import type { StoredMessage } from "../types.ts";
import { isPurgeDue, ownedBlobKeys, purgeExpiredTrash, purgeModeFrom } from "./purge.ts";

const DAY = 86_400_000;
/** Audit listing reads the last few days before the real clock, so the purge runs land "now". */
const T0 = new Date(Date.now() - 31 * DAY);

async function world() {
  let now = T0;
  const w = await memoryWorld({ now: () => now });
  return { ...w, at: (days: number) => (now = new Date(T0.getTime() + days * DAY)) };
}

async function audit(store: MailStore, action: string) {
  return (await store.listAudit(500)).filter((event) => event.action === action);
}

test("the mode defaults to report; only the exact word purge deletes", () => {
  assert.equal(purgeModeFrom(undefined), "report");
  assert.equal(purgeModeFrom("PURGE"), "report");
  assert.equal(purgeModeFrom("yes"), "report");
  assert.equal(purgeModeFrom("off"), "off");
  assert.equal(purgeModeFrom("purge"), "purge");
});

test("report mode audits what is due and deletes nothing", async () => {
  const w = await world();
  const { message } = await w.ingest(fixture("attachment.eml"));
  await w.mailbox.trash(message.id, "human");
  const result = await purgeExpiredTrash({ store: w.store, blobs: w.blobs, now: new Date(T0.getTime() + 31 * DAY), mode: "report" });
  assert.equal(result.due, 1);
  assert.equal(result.purged, 0);
  assert.ok(await w.store.getMessage(message.id));
  assert.ok(await w.blobs.get(bodyKey(message.id)));
  assert.match((await audit(w.store, "trash.purge_report"))[0]?.detail ?? "", /due:1/);
});

test("purge deletes only after the window: row, sealed body, attachments, thread, all audited", async () => {
  const w = await world();
  const { message } = await w.ingest(fixture("attachment.eml"));
  const { message: kept } = await w.ingest(fixture("personal.eml"));
  const keys = ownedBlobKeys(message);
  assert.ok(keys.length >= 2, "body and attachment");
  await w.mailbox.trash(message.id, "bridge");

  const early = await purgeExpiredTrash({ store: w.store, blobs: w.blobs, now: new Date(T0.getTime() + 29 * DAY), mode: "purge" });
  assert.equal(early.purged, 0);
  assert.ok(await w.store.getMessage(message.id), "still restorable inside the window");

  const late = await purgeExpiredTrash({ store: w.store, blobs: w.blobs, now: new Date(T0.getTime() + 31 * DAY), mode: "purge" });
  assert.equal(late.purged, 1);
  assert.equal(await w.store.getMessage(message.id), null);
  for (const key of keys) assert.equal(await w.blobs.get(key), null, key);
  assert.equal((await w.store.getThread(message.threadId))?.messageIds.length ?? 0, 0);
  const purged = await audit(w.store, "trash.purged");
  assert.equal(purged.length, 1);
  assert.equal(purged[0]?.messageId, message.id);
  assert.match(purged[0]?.detail ?? "", /trashedBy:bridge/);
  assert.doesNotMatch(JSON.stringify(await w.store.listAudit(500)), /Lease|attachment\.txt|note\.txt/, "audit carries ids and dates, not content");
  assert.ok(await w.store.getMessage(kept.id), "mail outside trash is untouched");
  assert.ok(await w.blobs.get(bodyKey(kept.id)));
});

test("the 7-day floor holds even if keepUntil says otherwise", async () => {
  const w = await world();
  const { message } = await w.ingest(fixture("personal.eml"));
  await w.store.updateMessage(message.id, { folder: "trash", trashedAt: new Date(T0.getTime() - 2 * DAY).toISOString(), keepUntil: new Date(T0.getTime() - DAY).toISOString() });
  const stored = (await w.store.getMessage(message.id)) as StoredMessage;
  assert.equal(isPurgeDue(stored, T0), false);
  const result = await purgeExpiredTrash({ store: w.store, blobs: w.blobs, now: T0, mode: "purge" });
  assert.equal(result.purged, 0);
  assert.ok(await w.store.getMessage(message.id));
});

test("mail in trash without a window is never purged", async () => {
  const w = await world();
  const { message } = await w.ingest(fixture("personal.eml"));
  await w.store.updateMessage(message.id, { folder: "trash" });
  const result = await purgeExpiredTrash({ store: w.store, blobs: w.blobs, now: new Date(T0.getTime() + 400 * DAY), mode: "purge" });
  assert.equal(result.unmarked, 1);
  assert.equal(result.purged, 0);
  assert.ok(await w.store.getMessage(message.id));
});

test("a restore between listing and delete wins", async () => {
  const w = await world();
  const { message } = await w.ingest(fixture("personal.eml"));
  await w.mailbox.trash(message.id, "human");
  const racing: MailStore = Object.create(w.store) as MailStore;
  racing.listMessages = async (query) => {
    const listed = await w.store.listMessages(query);
    await w.mailbox.restore(message.id);
    return listed;
  };
  const result = await purgeExpiredTrash({ store: racing, blobs: w.blobs, now: new Date(T0.getTime() + 31 * DAY), mode: "purge" });
  assert.equal(result.changed, 1);
  assert.equal(result.purged, 0);
  assert.equal((await w.store.getMessage(message.id))?.folder, "inbox");
  assert.ok(await w.blobs.get(bodyKey(message.id)));
});

test("one run deletes at most maxPerRun and audits the backlog", async () => {
  const w = await world();
  const ids: string[] = [];
  for (const name of ["personal.eml", "attachment.eml", "newsletter.eml"]) {
    const { message } = await w.ingest(fixture(name));
    await w.mailbox.trash(message.id, "human");
    ids.push(message.id);
  }
  const result = await purgeExpiredTrash({ store: w.store, blobs: w.blobs, now: new Date(T0.getTime() + 31 * DAY), mode: "purge", maxPerRun: 2 });
  assert.equal(result.purged, 2);
  assert.match((await audit(w.store, "trash.purge_run"))[0]?.detail ?? "", /backlog:1/);
});

test("off does nothing, and a tampered row cannot aim the purge at another object", async () => {
  const w = await world();
  const { message } = await w.ingest(fixture("attachment.eml"));
  const off = await purgeExpiredTrash({ store: w.store, blobs: w.blobs, now: new Date(T0.getTime() + 400 * DAY), mode: "off" });
  assert.equal(off.inTrash, 0);
  const tampered: StoredMessage = {
    ...message,
    aiContextKey: "rules/current.bin",
    attachments: [{ ...(message.attachments[0] as StoredMessage["attachments"][number]), blobKey: "objects/other-id/a.bin" }],
  };
  assert.deepEqual(ownedBlobKeys(tampered), [bodyKey(message.id)]);
});
