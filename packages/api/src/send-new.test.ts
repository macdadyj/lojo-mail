import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildRawMessage, DEFAULT_CHAT_SEND_LIMITS, TEST_WINDOW_SEND_LIMITS } from "@lojo/core";
import { fixture } from "@lojo/core/testing";
import { sesInput } from "./ses.ts";
import { testApp } from "./test-app.ts";

const NOTE = "Jon in chat: approved, send that new note";
const PHOTO = Buffer.from("not really a JPEG");

type App = Awaited<ReturnType<typeof testApp>>;

async function setup(scopes = ["read", "write", "body", "send-approved", "send-new"]) {
  const app = await testApp();
  const session = await app.login();
  const created = await app.call("/v1/bots", { token: session, body: { name: "grok", scopes } });
  assert.equal(created.status, 201, created.text);
  return { app, session, token: String(created.json.token) };
}

async function compose(app: App, token: string, extra: Record<string, unknown> = {}) {
  const res = await app.call("/v1/bot/send-new", {
    token,
    body: { to: ["ada@elsewhere.example"], cc: ["bob@elsewhere.example"], bcc: ["hidden@elsewhere.example"], subject: "Harbor Friday", text: "See you at the dock.", ...extra },
  });
  assert.equal(res.status, 201, res.text);
  return res.json as {
    draftId: string;
    contentHash: string;
    sendable: boolean;
    sent: boolean;
    approvalRequired: boolean;
    to: string[];
    cc: string[];
    bcc: string[];
    text: string;
    attachments: { sha256: string; filename: string }[];
  };
}

test("send-new is off until Jon grants it, and a bot cannot grant it", async () => {
  const { app, session, token } = await setup(["read", "write", "body", "send-approved"]);
  assert.equal((await app.call("/v1/bot/send-new", { token, body: { to: ["ada@elsewhere.example"], subject: "Hi", text: "Hello there" } })).status, 403);
  assert.equal((await app.call("/v1/bots/grok/send-window", { token, body: { perHour: 30, perDay: 100, enableSendNew: true } })).status, 403);
  assert.equal((await app.call("/v1/bots/grok/send-window", { token: session, body: { perHour: 30, perDay: 100, approvalRequired: false } })).status, 400);
  const granted = await app.call("/v1/bots/grok/send-window", {
    token: session,
    body: { perHour: TEST_WINDOW_SEND_LIMITS.perHour, perDay: TEST_WINDOW_SEND_LIMITS.perDay, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(granted.status, 200, granted.text);
  assert.ok((granted.json.scopes as string[]).includes("send-new"));
  assert.equal((granted.json.sendGrant as { approvalRequired: boolean }).approvalRequired, true);
});

test("a chat-approved send-new goes to any recipient, keeps bcc off the headers, and is audited with Jon's words", async () => {
  const { app, token } = await setup();
  const shown = await compose(app, token);
  assert.equal(shown.sent, false);
  assert.equal(shown.sendable, true);
  assert.equal(shown.approvalRequired, true);
  assert.deepEqual(shown.bcc, ["hidden@elsewhere.example"]);
  assert.equal(app.sender.sent.length, 0, "composing does not send");

  const missing = await app.call("/v1/bot/send-new", { token, body: { draftId: shown.draftId, contentHash: shown.contentHash } });
  assert.equal(missing.status, 403, missing.text);
  assert.match(missing.text, /approvalNote/);

  const sent = await app.call("/v1/bot/send-new", { token, body: { draftId: shown.draftId, contentHash: shown.contentHash, approvalNote: NOTE } });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json.approval, "chat");
  const outbound = app.sender.sent[0];
  assert.ok(outbound);
  assert.deepEqual(outbound.to.map((item) => item.email), ["ada@elsewhere.example"]);
  assert.deepEqual(outbound.cc.map((item) => item.email), ["bob@elsewhere.example"]);
  assert.deepEqual((outbound.bcc ?? []).map((item) => item.email), ["hidden@elsewhere.example"]);
  assert.equal(outbound.botSendNew, true);
  assert.equal(outbound.subject, "Harbor Friday");
  const raw = buildRawMessage(outbound);
  assert.match(raw, /X-Lojo-Bot: send-new/);
  assert.match(raw, /X-Auto-Response-Suppress: All/);
  assert.doesNotMatch(raw, /^Bcc:/im);
  assert.doesNotMatch(raw, /hidden@elsewhere\.example/);
  assert.doesNotMatch(raw, /Auto-Submitted:/);
  const wire = sesInput(outbound);
  assert.deepEqual(wire.Destination?.BccAddresses, ["hidden@elsewhere.example"]);
  const copy = (await app.store.listMessages({ folder: "sent", limit: 5 })).find((message) => message.subject === "Harbor Friday");
  assert.deepEqual(copy?.bcc?.map((item) => item.email), ["hidden@elsewhere.example"]);

  const audit = await app.store.listAudit(200);
  const event = audit.find((row) => row.action === "bot.send_new");
  assert.equal(event?.actor, "bot:grok");
  assert.match(event?.detail ?? "", /approvalSource:chat/);
  assert.ok(event?.detail?.includes(JSON.stringify(NOTE)));
  assert.match(event?.detail ?? "", /hidden@elsewhere\.example/);
  assert.equal(JSON.stringify(audit).includes(token), false);
});

test("an edit after the review voids the send, and the draft text is not an approval", async () => {
  const { app, token } = await setup();
  const shown = await compose(app, token);
  await app.call(`/v1/drafts/${shown.draftId}`, { token, body: { text: "Different words entirely." } });
  const stale = await app.call("/v1/bot/send-new", { token, body: { draftId: shown.draftId, contentHash: shown.contentHash, approvalNote: NOTE } });
  assert.equal(stale.status, 409, stale.text);
  const reviewed = await app.call("/v1/bot/send-new", { token, body: { draftId: shown.draftId } });
  const quoted = await app.call("/v1/bot/send-new", {
    token,
    body: { draftId: shown.draftId, contentHash: reviewed.json.contentHash, approvalNote: "Different words entirely" },
  });
  assert.equal(quoted.status === 400 || quoted.status === 403, true, quoted.text);
  assert.equal(app.sender.sent.length, 0);
});

test("attachments are part of the hash and go out with the message", async () => {
  const { app, token } = await setup();
  const shown = await compose(app, token);
  const sha256 = createHash("sha256").update(PHOTO).digest("hex");
  const added = await app.call(`/v1/drafts/${shown.draftId}/attachments`, {
    token,
    body: { filename: "photo.jpg", contentType: "image/jpeg", sha256, data: PHOTO.toString("base64") },
  });
  assert.equal(added.status, 200, added.text);
  const stale = await app.call("/v1/bot/send-new", { token, body: { draftId: shown.draftId, contentHash: shown.contentHash, approvalNote: NOTE } });
  assert.equal(stale.status, 409);
  const review = await app.call("/v1/bot/send-new", { token, body: { draftId: shown.draftId } });
  assert.equal(review.status, 200, review.text);
  assert.equal((review.json.attachments as { sha256: string }[])[0]?.sha256, sha256);
  const sent = await app.call("/v1/bot/send-new", { token, body: { draftId: shown.draftId, contentHash: review.json.contentHash, approvalNote: NOTE } });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(app.sender.sent[0]?.attachments?.length, 1);
  assert.equal(app.sender.sent[0]?.attachments?.[0]?.filename, "photo.jpg");
});

test("both kill switches stop send-new, and the hourly cap is enforced", async () => {
  const { app, session, token } = await setup();
  const shown = await compose(app, token);
  await app.call("/v1/rules/switches", { token: session, body: { sendKillSwitch: true } });
  assert.equal((await app.call("/v1/bot/send-new", { token, body: { draftId: shown.draftId, contentHash: shown.contentHash, approvalNote: NOTE } })).status, 403);
  await app.call("/v1/rules/switches", { token: session, body: { sendKillSwitch: false } });
  await app.call("/v1/bots/grok/send-limits", { token: session, body: { perHour: 1, perDay: 1 } });
  assert.equal((await app.call("/v1/bot/send-new", { token, body: { draftId: shown.draftId, contentHash: shown.contentHash, approvalNote: NOTE } })).status, 200);
  const second = await compose(app, token, { subject: "Second", text: "Another new note for later." });
  assert.equal((await app.call("/v1/bot/send-new", { token, body: { draftId: second.draftId, contentHash: second.contentHash, approvalNote: NOTE } })).status, 429);
  await app.call("/v1/bots/kill-switch", { token: session, body: { on: true } });
  assert.equal((await app.call("/v1/bot/send-new", { token, body: { draftId: second.draftId, contentHash: second.contentHash, approvalNote: NOTE } })).status, 401);
});

test("a waived approval is time-boxed, sends without a quote, and reverts on its own", async () => {
  let now = new Date("2026-10-01T12:00:00.000Z");
  const app = await testApp({ now: () => now });
  const session = await app.login();
  const created = await app.call("/v1/bots", { token: session, body: { name: "grok", scopes: ["read", "write", "body", "send-approved"] } });
  const token = String(created.json.token);
  const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();
  const granted = await app.call("/v1/bots/grok/send-window", { token: session, body: { perHour: 30, perDay: 100, expiresAt, approvalRequired: false } });
  assert.equal(granted.status, 200, granted.text);
  const shown = await compose(app, token);
  assert.equal(shown.approvalRequired, false);
  const withNote = await app.call("/v1/bot/send-new", { token, body: { draftId: shown.draftId, contentHash: shown.contentHash, approvalNote: NOTE } });
  assert.equal(withNote.status, 400, withNote.text);
  const sent = await app.call("/v1/bot/send-new", { token, body: { draftId: shown.draftId, contentHash: shown.contentHash } });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json.approval, "waived");
  const audit = (await app.store.listAudit(50)).find((row) => row.action === "bot.send_new");
  assert.equal(audit?.actor, "bot:grok");
  assert.match(audit?.detail ?? "", /approval:waived/);
  assert.doesNotMatch(audit?.detail ?? "", /note:/);

  now = new Date(now.getTime() + 2 * 3_600_000);
  const who = await app.call("/v1/bot/whoami", { token });
  assert.equal(who.status, 200, who.text);
  assert.equal((who.json.scopes as string[]).includes("send-new"), false);
  assert.deepEqual(who.json.sendLimits, DEFAULT_CHAT_SEND_LIMITS);
  assert.equal(who.json.sendGrant, null);
  assert.equal((await app.call("/v1/bot/send-new", { token, body: { to: ["ada@elsewhere.example"], subject: "Too late", text: "This window has closed." } })).status, 403);
  const expired = (await app.store.listAudit(50)).find((row) => row.action === "bot.send_grant_expired");
  assert.equal(expired?.actor, "system");
  assert.match(expired?.detail ?? "", /send-new off/);
  assert.equal(app.sender.sent.length, 1);
});

test("send_new refuses a reply draft", async () => {
  const { app, token } = await setup();
  const { message } = await app.ingest(fixture("personal.eml"));
  const reply = await app.call("/v1/drafts", {
    token,
    body: { to: [message.from.email], subject: "Re: Lease", text: "Thanks", threadId: message.threadId, inReplyTo: message.rfcMessageId },
  });
  assert.equal(reply.status, 201, reply.text);
  const id = (reply.json.draft as { id: string }).id;
  const review = await app.call("/v1/bot/send-new", { token, body: { draftId: id } });
  assert.equal(review.json.sendable, false);
  assert.match(JSON.stringify(review.json.recipientRefusals), /send_approved_reply/);
});
