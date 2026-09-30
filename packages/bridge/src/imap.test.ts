import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { after, before, describe, it } from "node:test";
import { parseMime } from "@lojo/core";
import { fixture } from "@lojo/core/testing";
import type { ImapFlow } from "imapflow";
import { harness, type Harness } from "./testkit.ts";

async function streamBytes(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function source(client: ImapFlow, uid: number): Promise<Buffer> {
  const download = await client.download(String(uid), undefined, { uid: true });
  assert.ok(download.content, "download has content");
  return streamBytes(download.content);
}

async function uidFor(client: ImapFlow, rfcMessageId: string): Promise<number> {
  const found = await client.search({ header: { "message-id": rfcMessageId } }, { uid: true });
  assert.ok(Array.isArray(found) && found.length === 1, `one message with ${rfcMessageId}`);
  return found[0] as number;
}

describe("IMAP", () => {
  let h: Harness;
  let client: ImapFlow;
  let leaseId: string;

  before(async () => {
    h = await harness({ pollSeconds: 1 });
    leaseId = (await h.t.ingest(fixture("personal.eml"))).message.id;
    await h.t.ingest(fixture("attachment.eml"));
    client = await h.imap();
  });

  after(async () => {
    await h.close();
  });

  it("rejects a wrong app password", async () => {
    await assert.rejects(() => h.imap("wrong-password"));
  });

  it("lists the service folders with special-use attributes", async () => {
    const boxes = await client.list();
    const byName = new Map(boxes.map((box) => [box.path, box.specialUse ?? ""]));
    assert.deepEqual([...byName.keys()].sort(), ["Archive", "Drafts", "INBOX", "Junk", "Sent", "Trash"]);
    assert.equal(byName.get("Archive"), "\\Archive");
    assert.equal(byName.get("Sent"), "\\Sent");
    assert.equal(byName.get("Drafts"), "\\Drafts");
    assert.equal(byName.get("Junk"), "\\Junk");
    assert.equal(byName.get("Trash"), "\\Trash");
  });

  it("serves envelope and flags from metadata and the decrypted source", async () => {
    await client.mailboxOpen("INBOX");
    assert.equal(client.mailbox && client.mailbox.exists, 2);
    const uid = await uidFor(client, "lease-1@example.com");
    const meta = await client.fetchOne(String(uid), { envelope: true, flags: true, size: true, internalDate: true }, { uid: true });
    assert.ok(meta);
    assert.equal(meta.envelope?.subject, "Lease renewal by Friday");
    assert.equal(meta.envelope?.from?.[0]?.address, "mina@example.com");
    assert.equal(meta.envelope?.messageId, "<lease-1@example.com>");
    assert.equal(meta.flags?.has("\\Seen"), false);
    const raw = await source(client, uid);
    assert.equal(meta.size, raw.length);
    const parsed = await parseMime(raw);
    assert.equal(parsed.subject, "Lease renewal by Friday");
    assert.equal(parsed.from.email, "mina@example.com");
    assert.match(parsed.text, /CODEWORD-ZEBRA/);
    assert.equal(parsed.rfcMessageId, "lease-1@example.com");
    assert.equal((await h.t.store.getMessage(leaseId))?.unread, true, "BODY.PEEK leaves it unread");
  });

  it("round-trips an attachment", async () => {
    const uid = await uidFor(client, "att-1@example.com");
    const meta = await client.fetchOne(String(uid), { bodyStructure: true }, { uid: true });
    assert.ok(meta && meta.bodyStructure);
    assert.equal(meta.bodyStructure.type, "multipart/mixed");
    const parsed = await parseMime(await source(client, uid));
    assert.equal(parsed.attachments.length, 1);
    assert.equal(parsed.attachments[0]?.filename, "note.txt");
    assert.equal(Buffer.from(parsed.attachments[0]?.bytes ?? []).toString("utf8").trim(), "hello attachment");
    const part = await client.download(String(uid), "2", { uid: true });
    assert.ok(part.content);
    assert.equal((await streamBytes(part.content)).toString("utf8").trim(), "hello attachment");
  });

  it("marks a message seen when the body is fetched without PEEK", async () => {
    const raw = await h.raw();
    await raw.login(h.address);
    await raw.command("S1", "SELECT INBOX");
    const search = await raw.command("S2", "UID SEARCH HEADER Message-ID lease-1@example.com");
    const uid = /\* SEARCH (\d+)/.exec(search)?.[1];
    assert.ok(uid);
    const reply = await raw.command("S3", `UID FETCH ${uid} (BODY[TEXT])`);
    assert.match(reply, /FLAGS \([^)]*\\Seen/);
    assert.match(reply, /BODY\[TEXT\] \{\d+\}\r\nSGkgSm9u/, "base64 of the decrypted body");
    assert.equal((await h.t.store.getMessage(leaseId))?.unread, false);
    raw.end();
  });

  it("syncs \\Seen, \\Flagged, and keywords to the service", async () => {
    const uid = await uidFor(client, "att-1@example.com");
    const id = (await h.t.store.listMessages({ folder: "inbox", limit: 10 })).find((message) => message.rfcMessageId === "att-1@example.com")?.id;
    assert.ok(id);
    await client.messageFlagsAdd(String(uid), ["\\Seen", "\\Flagged", "$label1", "Junk"], { uid: true });
    let stored = await h.t.store.getMessage(id);
    assert.equal(stored?.unread, false);
    assert.ok(stored?.labels.includes("flagged"));
    assert.ok(stored?.labels.includes("important"));
    assert.ok(stored?.labels.includes("junk"));
    await client.messageFlagsRemove(String(uid), ["\\Seen", "$label1"], { uid: true });
    stored = await h.t.store.getMessage(id);
    assert.equal(stored?.unread, true);
    assert.ok(!stored?.labels.includes("important"));
    assert.ok(stored?.labels.includes("flagged"));
    const meta = await client.fetchOne(String(uid), { flags: true }, { uid: true });
    assert.ok(meta && meta.flags?.has("\\Flagged") && meta.flags.has("Junk") && !meta.flags.has("\\Seen"));
  });

  it("sees newly ingested mail on NOOP and during IDLE", async () => {
    const before = client.mailbox ? client.mailbox.exists : 0;
    await h.t.ingest(fixture("newsletter.eml"));
    await client.noop();
    assert.equal(client.mailbox && client.mailbox.exists, before + 1);

    const watcher = await h.imap();
    await watcher.mailboxOpen("INBOX");
    const count = watcher.mailbox ? watcher.mailbox.exists : 0;
    const seen = new Promise<number>((resolve) => watcher.on("exists", (event: { count: number }) => resolve(event.count)));
    const idling = watcher.idle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await h.t.ingest(fixture("html-only.eml"));
    assert.equal(await seen, count + 1);
    await watcher.noop();
    await idling;
  });

  it("moves to Archive on the service", async () => {
    const uid = await uidFor(client, "att-1@example.com");
    const id = (await h.t.store.listMessages({ folder: "inbox", limit: 10 })).find((message) => message.rfcMessageId === "att-1@example.com")?.id;
    assert.ok(id);
    const moved = await client.messageMove(String(uid), "Archive", { uid: true });
    assert.ok(moved);
    assert.equal((await h.t.store.getMessage(id))?.folder, "archive");
    const status = await client.status("Archive", { messages: true });
    assert.ok(status && status.messages === 1);
  });

  it("deletes by archiving with a hidden label, never trashing", async () => {
    await client.mailboxOpen("INBOX");
    const uid = await uidFor(client, "lease-1@example.com");
    const archivedBefore = await client.status("Archive", { messages: true });
    const inboxBefore = client.mailbox ? client.mailbox.exists : 0;
    assert.ok(await client.messageDelete(String(uid), { uid: true }));
    const stored = await h.t.store.getMessage(leaseId);
    assert.equal(stored?.folder, "archive");
    assert.ok(stored?.labels.includes("thunderbird-deleted"));
    assert.equal(stored?.trashedAt, undefined);
    assert.equal((await h.t.store.listMessages({ folder: "trash", limit: 10 })).length, 0);
    assert.equal(client.mailbox && client.mailbox.exists, inboxBefore - 1);
    const archivedAfter = await client.status("Archive", { messages: true });
    assert.ok(archivedBefore && archivedAfter);
    assert.equal(archivedAfter.messages, archivedBefore.messages, "hidden from Archive too");
  });

  it("moving to Trash behaves like delete", async () => {
    await client.mailboxOpen("INBOX");
    const [first] = await h.t.store.listMessages({ folder: "inbox", limit: 1 });
    assert.ok(first);
    const uid = await uidFor(client, first.rfcMessageId);
    assert.ok(await client.messageMove(String(uid), "Trash", { uid: true }));
    const stored = await h.t.store.getMessage(first.id);
    assert.equal(stored?.folder, "archive");
    assert.ok(stored?.labels.includes("thunderbird-deleted"));
  });

  it("refuses COPY and moves into Sent or Drafts", async () => {
    await client.mailboxOpen("INBOX");
    const raw = await h.raw();
    await raw.login(h.address);
    await raw.command("C1", "SELECT INBOX");
    assert.match(await raw.command("C2", "COPY 1 Archive"), /^C2 NO \[CANNOT\]/m);
    assert.match(await raw.command("C3", "MOVE 1 Sent"), /^C3 NO \[CANNOT\]/m);
    assert.match(await raw.command("C4", "MOVE 1 Nowhere"), /^C4 NO \[TRYCREATE\]/m);
    assert.match(await raw.command("C5", "CREATE Projects"), /^C5 NO \[CANNOT\]/m);
    raw.end();
  });

  it("accepts and drops APPEND to Sent and Drafts, refuses it elsewhere", async () => {
    const messagesBefore = (await h.t.store.listMessages({ limit: 100 })).length;
    const draftsBefore = (await h.t.store.listDrafts()).length;
    const message = Buffer.from(`From: ${h.address}\r\nTo: someone@example.org\r\nSubject: copy\r\n\r\nhello\r\n`);
    assert.ok(await client.append("Sent", message, ["\\Seen"]));
    assert.ok(await client.append("Drafts", message, ["\\Draft"]));
    await assert.rejects(() => client.append("INBOX", message));
    assert.equal((await h.t.store.listMessages({ limit: 100 })).length, messagesBefore);
    assert.equal((await h.t.store.listDrafts()).length, draftsBefore);
  });

  it("answers malformed input with BAD and keeps the connection usable", async () => {
    const raw = await h.raw();
    await raw.until(/^\* OK[^\r\n]*\r\n/m);
    assert.match(await raw.command("B1", "FETCH 1 (FLAGS"), /^B1 (BAD|NO)/m);
    assert.match(await raw.command("B2", "LOGIN"), /^B2 BAD/m);
    assert.match(await raw.command("B3", "SELECT INBOX"), /^B3 NO/m);
    raw.send(`B4 LOGIN {${h.address.length}}\r\n`);
    await raw.until(/^\+ [^\r\n]*\r\n/m);
    raw.send(`${h.address} {30+}\r\ntest-app-password-not-a-secret\r\n`);
    assert.match(await raw.until(/^B4 [^\r\n]*\r\n/m), /^B4 OK/m);
    raw.send("B5 APPEND Sent {999999999}\r\n");
    assert.match(await raw.until(/^B5 [^\r\n]*\r\n/m), /^B5 BAD/m);
    assert.match(await raw.command("B6", 'SEARCH (OR "unclosed'), /^B6 BAD/m);
    assert.match(await raw.command("B7", "NOOP"), /^B7 OK/m);
    raw.end();
  });

  it("serves header fields, partial fetches, and searches", async () => {
    const raw = await h.raw();
    await raw.login(h.address);
    await raw.command("H1", "EXAMINE Archive");
    const reply = await raw.command("H2", "FETCH 1 (UID RFC822.SIZE BODY.PEEK[HEADER.FIELDS (Subject From)] BODY.PEEK[]<0.10> BODYSTRUCTURE)");
    assert.match(reply, /BODY\[HEADER\.FIELDS \(Subject From\)\] \{\d+\}\r\n(Subject|From): /);
    assert.match(reply, /BODY\[\]<0> \{10\}\r\nX-Lojo-Id:/);
    assert.match(reply, /BODYSTRUCTURE \(\(/);
    assert.match(await raw.command("H3", "SEARCH SINCE 1-Jan-2020 NOT DELETED"), /\* SEARCH 1/);
    assert.match(await raw.command("H4", "SEARCH TEXT \"see the file\""), /\* SEARCH 1\r\n/);
    assert.match(await raw.command("H5", "STORE 1 +FLAGS (\\Flagged)"), /^H5 NO \[READ-ONLY\]/m);
    raw.end();
  });
});

describe("IMAP state file", () => {
  it("keeps UIDs across restarts and never stores plaintext", async () => {
    const h = await harness();
    await h.t.ingest(fixture("personal.eml"));
    const client = await h.imap();
    await client.mailboxOpen("INBOX");
    const uid = await uidFor(client, "lease-1@example.com");
    const validity = client.mailbox ? String(client.mailbox.uidValidity) : "";
    assert.match((await source(client, uid)).toString("utf8"), /Lease renewal/);
    await h.close({ keepState: true });
    const state = readFileSync(h.statePath, "utf8");
    rmSync(dirname(h.statePath), { recursive: true, force: true });
    assert.doesNotMatch(state, /CODEWORD-ZEBRA|Lease renewal|mina@example\.com/);
    const parsed = JSON.parse(state) as { mailboxes: Record<string, { uidValidity: number; uids: Record<string, number> }> };
    assert.equal(String(parsed.mailboxes.INBOX?.uidValidity), validity);
    assert.equal(Object.values(parsed.mailboxes.INBOX?.uids ?? {})[0], uid);
  });
});
