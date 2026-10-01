import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { draftAttachmentKey, parseMime } from "@lojo/core";
import { fixture } from "@lojo/core/testing";
import type { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { BOT_DRAFT_LABEL, SERVER_FILES_LABEL } from "./drafts.ts";
import { APP_PASSWORD, harness, type Harness, type HarnessOptions } from "./testkit.ts";

const LIMITS = { maxBytes: 4_000_000, maxRecipients: 50, perDay: 200, recipientsPerDay: 500, perTenMinutes: 30 };

function transport(h: Harness) {
  return createTransport({ host: "127.0.0.1", port: h.bridge.smtpPort, secure: false, ignoreTLS: true, auth: { user: h.address, pass: APP_PASSWORD } });
}

async function streamBytes(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function source(client: ImapFlow, uid: number): Promise<Buffer> {
  const download = await client.download(String(uid), undefined, { uid: true });
  assert.ok(download.content);
  return streamBytes(download.content);
}

async function uidsIn(client: ImapFlow, mailbox: string): Promise<number[]> {
  await client.mailboxOpen(mailbox);
  const found = await client.search({ all: true }, { uid: true });
  return Array.isArray(found) ? found : [];
}

async function withHarness(options: HarnessOptions, body: (h: Harness) => Promise<void>): Promise<void> {
  const h = await harness({ bridgeSend: true, ...options });
  try {
    await body(h);
  } finally {
    await h.close();
  }
}

describe("Thunderbird as the mail client: SMTP send", () => {
  it("sends immediately with To, Cc, Bcc and an attachment, and files the Sent copy Thunderbird can open", () =>
    withHarness({}, async (h) => {
      const info = await transport(h).sendMail({
        from: h.address,
        to: "mina@example.com",
        cc: "other@example.net",
        bcc: "hidden@example.org",
        subject: "Signed lease",
        text: "Attached.",
        attachments: [{ filename: "lease.txt", content: "signed lease text" }],
      });
      assert.match(info.response, /Sent through lojo-mail/);
      assert.equal(h.t.sender.rawSent.length, 1);
      const [sent] = h.t.sender.rawSent;
      assert.deepEqual([...(sent?.destinations ?? [])].sort(), ["hidden@example.org", "mina@example.com", "other@example.net"]);
      const wire = Buffer.from(sent?.raw ?? []).toString("utf8");
      assert.doesNotMatch(wire, /^Bcc:/im, "Bcc never leaves in the headers");
      const parsed = await parseMime(Buffer.from(sent?.raw ?? []));
      assert.equal(parsed.attachments[0]?.filename, "lease.txt");
      assert.equal(h.t.sender.sent.length, 0, "no approval-queue send happened");
      assert.equal((await h.t.store.listDrafts()).filter((draft) => draft.origin === "client").length, 0, "no draft was queued");

      const client = await h.imap();
      const [uid] = await uidsIn(client, "Sent");
      assert.ok(uid, "the Sent copy is in IMAP Sent");
      const copy = await parseMime(await source(client, uid));
      assert.equal(copy.subject, "Signed lease");
      assert.equal(copy.attachments[0]?.filename, "lease.txt");
      assert.match((await source(client, uid)).toString("utf8"), /^Bcc: hidden@example\.org/im, "Jon still sees his own Bcc");
      const bccSearch = await client.search({ bcc: "hidden@example.org" }, { uid: true });
      assert.deepEqual(bccSearch, [uid]);
    }));

  it("threads replies and forwards with In-Reply-To and References", () =>
    withHarness({}, async (h) => {
      const parent = (await h.t.ingest(fixture("personal.eml"))).message;
      await transport(h).sendMail({
        from: h.address,
        to: "mina@example.com",
        subject: "Re: Lease renewal by Friday",
        text: "Friday works.",
        inReplyTo: "<lease-1@example.com>",
        references: ["<lease-1@example.com>"],
      });
      const wire = Buffer.from(h.t.sender.rawSent[0]?.raw ?? []).toString("utf8");
      assert.match(wire, /^In-Reply-To: <lease-1@example\.com>/im);
      assert.match(wire, /^References: <lease-1@example\.com>/im);
      const copy = (await h.t.store.listMessages({ folder: "sent", limit: 5 }))[0];
      assert.equal(copy?.threadId, parent.threadId);

      await transport(h).sendMail({
        from: h.address,
        to: "friend@example.org",
        subject: "Fwd: Lease renewal by Friday",
        text: "FYI",
        references: ["<lease-1@example.com>"],
        attachments: [{ filename: "original.eml", content: fixture("personal.eml"), contentType: "message/rfc822" }],
      });
      const forward = Buffer.from(h.t.sender.rawSent[1]?.raw ?? []).toString("utf8");
      assert.match(forward, /^References: <lease-1@example\.com>/im);
      assert.match(forward, /message\/rfc822/);
    }));

  it("sends as a configured extra address and refuses anything else", () =>
    withHarness({ sendFrom: "jon@cyberphysical.us" }, async (h) => {
      await transport(h).sendMail({ from: "jon@cyberphysical.us", to: "a@example.org", subject: "alias", text: "x" });
      assert.equal(h.t.sender.rawSent[0]?.from, "jon@cyberphysical.us");
      await assert.rejects(() => transport(h).sendMail({ from: "someone@example.com", to: "a@example.org", subject: "x", text: "x" }), /550/);
      assert.equal(h.t.sender.rawSent.length, 1);
    }));

  it("refuses oversize messages, and stops everything while the kill switch is on", () =>
    withHarness({ clientSendLimits: { ...LIMITS, maxBytes: 4000 } }, async (h) => {
      await assert.rejects(
        () => transport(h).sendMail({ from: h.address, to: "a@example.org", subject: "big", text: "x", attachments: [{ filename: "big.bin", content: Buffer.alloc(8000, 1) }] }),
        /554/,
      );
      const session = await h.t.login();
      assert.equal((await h.t.call("/v1/rules/switches", { token: session, body: { sendKillSwitch: true } })).status, 200);
      await assert.rejects(() => transport(h).sendMail({ from: h.address, to: "a@example.org", subject: "x", text: "x" }), /550[\s\S]*kill switch/);
      assert.equal(h.t.sender.rawSent.length, 0);
    }));

  it("answers a rate limit with a temporary failure so Thunderbird can retry later", () =>
    withHarness({ clientSendLimits: { ...LIMITS, perTenMinutes: 1 } }, async (h) => {
      await transport(h).sendMail({ from: h.address, to: "a@example.org", subject: "one", text: "x" });
      await assert.rejects(() => transport(h).sendMail({ from: h.address, to: "a@example.org", subject: "two", text: "x" }), /451/);
      assert.equal(h.t.sender.rawSent.length, 1);
    }));

  it("without client-send the bridge keeps queueing for approval", () =>
    withHarness({ bridgeSend: false }, async (h) => {
      const info = await transport(h).sendMail({ from: h.address, to: "a@example.org", subject: "queued", text: "x" });
      assert.match(info.response, /approval/);
      assert.equal(h.t.sender.rawSent.length, 0);
    }));
});

describe("Thunderbird as the mail client: new mail", () => {
  it("IDLE announces new mail within seconds, long before the full poll", () =>
    withHarness({ pollSeconds: 3600, newMailSeconds: 1 }, async (h) => {
      const watcher = await h.imap();
      await watcher.mailboxOpen("INBOX");
      const count = watcher.mailbox ? watcher.mailbox.exists : 0;
      const seen = new Promise<number>((resolve) => watcher.on("exists", (event: { count: number }) => resolve(event.count)));
      const idling = watcher.idle();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await h.t.ingest(fixture("attachment.eml"));
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no EXISTS within 5s")), 5000));
      assert.equal(await Promise.race([seen, timeout]), count + 1);
      await watcher.noop();
      await idling;
      const [uid] = await uidsIn(watcher, "INBOX");
      assert.ok(uid);
      const parsed = await parseMime(await source(watcher, uid));
      assert.equal(parsed.attachments[0]?.filename, "note.txt", "the attachment is decrypted locally and downloadable");
    }));
});

describe("Thunderbird as the mail client: Drafts and bot drafts", () => {
  async function botDraft(h: Harness): Promise<string> {
    const { message } = await h.t.ingest(fixture("personal.eml"));
    const created = await h.t.call("/v1/drafts", {
      token: "agent-token",
      body: { to: [message.from.email], subject: `Re: ${message.subject}`, text: "Yes, Friday works.", inReplyTo: message.rfcMessageId },
    });
    assert.equal(created.status, 201, created.text);
    return (created.json.draft as { id: string }).id;
  }

  async function draftUid(client: ImapFlow, draftId: string): Promise<number> {
    for (const uid of await uidsIn(client, "Drafts")) {
      if ((await source(client, uid)).toString("utf8").includes(`X-Lojo-Draft-Id: ${draftId}`)) return uid;
    }
    throw new Error(`draft ${draftId} is not in Drafts`);
  }

  it("a draft with files attached through the API is tagged, and sending it without them is not 'unchanged'", () =>
    withHarness({}, async (h) => {
      const draftId = await botDraft(h);
      const bytes = Buffer.from("quarterly numbers");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const added = await h.t.call(`/v1/drafts/${draftId}/attachments`, {
        token: "agent-token",
        body: { filename: "numbers.csv", contentType: "text/csv", sha256, data: bytes.toString("base64") },
      });
      assert.equal(added.status, 200, added.text);
      const client = await h.imap();
      const uid = await draftUid(client, draftId);
      const meta = await client.fetchOne(String(uid), { flags: true }, { uid: true });
      assert.ok(meta && meta.flags?.has(SERVER_FILES_LABEL));
      await transport(h).sendMail({ envelope: { from: h.address, to: ["mina@example.com"] }, raw: await source(client, uid) });
      const draft = await h.t.store.getDraft(draftId);
      assert.equal(draft?.status, "sent");
      assert.equal(draft?.clientSent?.unchanged, false);
      assert.equal(h.t.blobs.objects.has(draftAttachmentKey(draftId, draft?.attachments?.[0]?.id ?? "")), false, "the sealed file is cleaned up");
    }));

  it("a bot draft appears in Drafts, and sending it unchanged from Thunderbird is the approval", () =>
    withHarness({}, async (h) => {
      const draftId = await botDraft(h);
      const client = await h.imap();
      const uid = await draftUid(client, draftId);
      const meta = await client.fetchOne(String(uid), { flags: true, envelope: true }, { uid: true });
      assert.ok(meta && meta.flags?.has("\\Draft") && meta.flags.has(BOT_DRAFT_LABEL));
      assert.equal(meta.envelope?.inReplyTo, "<lease-1@example.com>");
      const raw = await source(client, uid);

      await transport(h).sendMail({ envelope: { from: h.address, to: ["mina@example.com"] }, raw });
      const draft = await h.t.store.getDraft(draftId);
      assert.equal(draft?.status, "sent");
      assert.equal(draft?.clientSent?.unchanged, true);
      const wire = Buffer.from(h.t.sender.rawSent[0]?.raw ?? []).toString("utf8");
      assert.doesNotMatch(wire, /X-Lojo-Draft-Id/i, "internal headers are stripped");
      assert.match(wire, /^In-Reply-To: <lease-1@example\.com>/im);

      await client.noop();
      const again = await uidsIn(client, "Drafts");
      assert.ok(!again.includes(uid), "the sent draft leaves Drafts");
    }));

  it("an edited bot draft still sends, and records that Jon changed it", () =>
    withHarness({}, async (h) => {
      const draftId = await botDraft(h);
      const client = await h.imap();
      const opened = await parseMime(await source(client, await draftUid(client, draftId)));
      assert.equal(opened.text.trim(), "Yes, Friday works.");
      await transport(h).sendMail({
        from: h.address,
        to: "mina@example.com",
        subject: opened.subject,
        text: "Friday at 3pm works.",
        inReplyTo: "<lease-1@example.com>",
        headers: { "X-Lojo-Draft-Id": draftId },
      });
      const draft = await h.t.store.getDraft(draftId);
      assert.equal(draft?.status, "sent");
      assert.equal(draft?.clientSent?.unchanged, false);
    }));

  it("deleting a bot draft in Thunderbird discards it", () =>
    withHarness({}, async (h) => {
      const draftId = await botDraft(h);
      const client = await h.imap();
      const uid = await draftUid(client, draftId);
      assert.ok(await client.messageDelete(String(uid), { uid: true }));
      assert.equal((await h.t.store.getDraft(draftId))?.status, "discarded");
      assert.equal(h.t.sender.rawSent.length, 0);
    }));

  it("Thunderbird's own saved drafts round-trip by Message-ID; attachments are refused", () =>
    withHarness({}, async (h) => {
      const client = await h.imap();
      const saved = [
        "From: lojo@cyberphysical.us",
        "To: a@example.org",
        "Subject: half written",
        "Message-ID: <tb-draft-1@cyberphysical.us>",
        "X-Mozilla-Draft-Info: internal/draft; vcard=0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Still thinking.",
        "",
      ].join("\r\n");
      await client.append("Drafts", saved, ["\\Draft", "\\Seen"]);
      const draft = (await h.t.store.listDrafts()).find((item) => item.subject === "half written");
      assert.equal(draft?.origin, "client");
      assert.equal(draft?.clientMessageId, "tb-draft-1@cyberphysical.us");

      await client.mailboxOpen("Drafts");
      const found = await client.search({ header: { "message-id": "tb-draft-1@cyberphysical.us" } }, { uid: true });
      assert.ok(Array.isArray(found) && found.length === 1, "Thunderbird finds its draft again");
      const meta = await client.fetchOne(String(found[0]), { flags: true }, { uid: true });
      assert.ok(meta && meta.flags?.has("\\Draft") && !meta.flags.has(BOT_DRAFT_LABEL));
      assert.ok(await client.messageDelete(String(found[0]), { uid: true }));
      assert.equal((await h.t.store.getDraft(draft?.id ?? ""))?.status, "discarded");

      const withAttachment = [
        "From: lojo@cyberphysical.us",
        "To: a@example.org",
        "Subject: with file",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "see file",
        "--b",
        'Content-Type: text/plain; name="a.txt"',
        'Content-Disposition: attachment; filename="a.txt"',
        "",
        "hello",
        "--b--",
        "",
      ].join("\r\n");
      await assert.rejects(() => client.append("Drafts", withAttachment, ["\\Draft"]));
    }));

  it("COPY to another folder moves the message on the service", () =>
    withHarness({}, async (h) => {
      const { message } = await h.t.ingest(fixture("attachment.eml"));
      const client = await h.imap();
      const [uid] = await uidsIn(client, "INBOX");
      assert.ok(uid);
      assert.ok(await client.messageCopy(String(uid), "Archive", { uid: true }));
      assert.equal((await h.t.store.getMessage(message.id))?.folder, "archive");
    }));
});
