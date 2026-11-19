import assert from "node:assert/strict";
import test from "node:test";
import { MailError } from "./errors.ts";
import { refreshThread } from "./ingest.ts";
import { messagesForThread } from "./mailbox.ts";
import type { MailStore } from "./store/types.ts";
import { DEFAULT_TABLE_NAMES } from "./store/types.ts";
import { fixture, memoryWorld } from "./testing.ts";

/** The thread index is a GSI. This stands in for a query that has not caught up. */
function laggingThreadIndex(store: MailStore): MailStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "listThreadMessages") return () => Promise.resolve([]);
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

const reported = "thr_f9fee2c77944c39118a79237";

test("a listed conversation with no thread row opens, and a real miss stays not found", async () => {
  const w = await memoryWorld();
  const { message } = await w.ingest(fixture("personal.eml"));
  const other = await w.ingest(fixture("newsletter.eml"));
  assert.notEqual(message.threadId, other.message.threadId);
  assert.equal(message.folder, "inbox");
  assert.equal(message.unread, true);
  const before = {
    otherFolder: other.message.folder,
    otherUnread: other.message.unread,
    count: (await w.store.listMessages()).length,
  };

  await w.store.updateMessage(message.id, { threadId: reported });
  assert.equal(await w.store.getThread(reported), null);

  await assert.rejects(w.mailbox.readThread("thr_missing"), (error: unknown) => {
    assert.ok(error instanceof MailError);
    assert.equal(error.code, "not_found");
    assert.equal(error.message, "No thread thr_missing");
    return true;
  });
  assert.equal(await w.store.getThread("thr_missing"), null);
  assert.equal((await w.store.listMessages()).length, before.count);

  const opened = await w.mailbox.readThread(reported);
  assert.deepEqual(
    opened.messages.map((item) => item.id),
    [message.id],
  );
  assert.equal(opened.thread.id, reported);
  assert.equal(opened.messages[0]?.threadId, reported);
  assert.equal(opened.messages[0]?.unread, false);
  assert.equal(opened.messages[0]?.folder, "inbox");
  assert.equal((await w.store.getMessage(message.id))?.folder, "inbox");
  assert.equal((await w.store.getMessage(message.id))?.unread, false);
  assert.equal((await w.store.getMessage(other.message.id))?.folder, before.otherFolder);
  assert.equal((await w.store.getMessage(other.message.id))?.unread, before.otherUnread);
  assert.equal(w.sender.sent.length, 0);

  const previous = await w.mailbox.readThread(message.threadId);
  assert.equal(previous.thread.id, message.threadId);
  assert.deepEqual(previous.messages.map((item) => item.id), []);
});

test("a lagging thread index still records the message just stored", async () => {
  const w = await memoryWorld();
  const { message } = await w.ingest(fixture("personal.eml"));
  const other = await w.ingest(fixture("newsletter.eml"));
  const stored = await w.store.getMessage(message.id);
  assert.ok(stored);
  const hidden = laggingThreadIndex(w.store);

  const rebuilt = await refreshThread(hidden, message.threadId, message.subject, [stored]);
  assert.deepEqual(rebuilt?.messageIds, [message.id]);
  assert.equal((await w.store.getThread(message.threadId))?.messageIds.includes(message.id), true);
  assert.equal((await w.store.getThread(other.message.threadId))?.messageIds.includes(other.message.id), true);

  const missed = await refreshThread(hidden, "thr_absent", "Absent", [stored]);
  assert.equal(missed, null);
  assert.equal(await w.store.getThread("thr_absent"), null);

  const viaRow = await messagesForThread(hidden, message.threadId);
  assert.deepEqual(
    viaRow.messages.map((item) => item.id),
    [message.id],
  );
  assert.equal(viaRow.messages.some((item) => item.id === other.message.id), false);

  await w.store.memory.delete(DEFAULT_TABLE_NAMES.threads, { id: message.threadId }, { exists: ["id"] });
  await assert.rejects(messagesForThread(hidden, message.threadId), (error: unknown) => {
    assert.ok(error instanceof MailError);
    assert.equal(error.message, `No thread ${message.threadId}`);
    return true;
  });
});

test("redelivery restores a missing thread row and does not mark the message read", async () => {
  const w = await memoryWorld();
  const { message } = await w.ingest(fixture("personal.eml"));
  const removed = await w.store.memory.delete(DEFAULT_TABLE_NAMES.threads, { id: message.threadId }, { exists: ["id"] });
  assert.ok(removed);
  assert.equal(await w.store.getThread(message.threadId), null);

  const again = await w.ingest(fixture("personal.eml"));
  assert.equal(again.duplicate, true);
  assert.equal(again.message.id, message.id);
  assert.equal((await w.store.listMessages()).filter((item) => item.id === message.id).length, 1);
  const thread = await w.store.getThread(message.threadId);
  assert.equal(thread?.messageIds.includes(message.id), true);
  assert.equal((await w.store.getMessage(message.id))?.unread, true);
  assert.equal((await w.store.getMessage(message.id))?.folder, message.folder);
});
