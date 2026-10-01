import assert from "node:assert/strict";
import test from "node:test";
import { autoSendRefusals, emptyRules } from "@lojo/core";
import { fixture } from "@lojo/core/testing";
import { testApp } from "./test-app.ts";

const JON = "lojo@cyberphysical.us";

function mime(headers: Record<string, string>, body = "Hello there.\r\n"): string {
  const lines = Object.entries({ Date: "Wed, 30 Sep 2026 12:00:00 +0000", "Message-ID": "<tb-1@thunderbird.local>", "MIME-Version": "1.0", ...headers }).map(
    ([key, value]) => `${key}: ${value}`,
  );
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}

function sendBody(raw: string, recipients: string[], envelopeFrom = JON) {
  return { raw: Buffer.from(raw).toString("base64"), envelopeFrom, recipients };
}

test("only the bridge token with client-send can send directly; agents, send tokens, admin, and Jon's web session cannot", async () => {
  const t = await testApp({ bridgeSend: true });
  const session = await t.login();
  const body = sendBody(mime({ From: JON, To: "friend@example.org", Subject: "Hi" }), ["friend@example.org"]);
  for (const token of ["agent-token", "agent-trash-token", "send-token", "admin-token", "write-token", session]) {
    assert.equal((await t.call("/v1/client/send", { token, body })).status, 403, token);
  }
  assert.equal(t.sender.rawSent.length, 0);
  const res = await t.call("/v1/client/send", { token: "bridge-token", body });
  assert.equal(res.status, 200, res.text);
  assert.equal(t.sender.rawSent.length, 1);

  const queued = await testApp({ bridgeSend: false });
  assert.equal((await queued.call("/v1/client/send", { token: "bridge-token", body })).status, 403, "LOJO_BRIDGE_SEND off keeps the bridge in approval-queue mode");
  assert.equal(queued.sender.rawSent.length, 0);
});

test("a direct send delivers to To, Cc and Bcc, strips Bcc from the message, and files a sealed Sent copy that remembers Bcc", async () => {
  const t = await testApp({ bridgeSend: true });
  const raw = mime(
    { From: `Jon Hebert <${JON}>`, To: "a@example.org", Cc: "b@example.org", Bcc: "hidden@example.org", Subject: "Plans", "X-Lojo-Draft-Id": "drf_nope" },
    "See you Friday.\r\n",
  );
  const res = await t.call("/v1/client/send", { token: "bridge-token", body: sendBody(raw, ["a@example.org", "b@example.org", "hidden@example.org"]) });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.bcc, 1);
  const [sent] = t.sender.rawSent;
  assert.ok(sent);
  assert.deepEqual(sent.destinations, ["a@example.org", "b@example.org", "hidden@example.org"]);
  assert.equal(sent.from, JON);
  const wire = Buffer.from(sent.raw).toString("utf8");
  assert.doesNotMatch(wire, /^Bcc:/im, "Bcc never reaches recipients");
  assert.doesNotMatch(wire, /hidden@example\.org/);
  assert.doesNotMatch(wire, /^X-Lojo-/im);
  assert.match(wire, /^Subject: Plans$/m);

  const copy = await t.store.getMessage(String(res.json.sentId));
  assert.equal(copy?.folder, "sent");
  assert.equal(copy?.origin, "sent");
  assert.equal(copy?.rfcMessageId, "raw-1@memory", "the Sent copy carries the Message-ID SES used");
  assert.deepEqual(copy?.bcc, [{ email: "hidden@example.org" }]);
  assert.ok(copy?.bodyKey && (await t.blobs.get(copy.bodyKey)), "body sealed at rest");
  const audit = (await t.store.listAudit()).find((event) => event.action === "send.client" && event.outcome === "sent");
  assert.match(audit?.detail ?? "", /rcpt:3 bcc:1/);
});

test("replies keep In-Reply-To and References, and the Sent copy joins the thread", async () => {
  const t = await testApp({ bridgeSend: true });
  const { message } = await t.ingest(fixture("personal.eml"));
  const raw = mime({
    From: JON,
    To: message.from.email,
    Subject: `Re: ${message.subject}`,
    "In-Reply-To": `<${message.rfcMessageId}>`,
    References: `<${message.rfcMessageId}>`,
  });
  const res = await t.call("/v1/client/send", { token: "bridge-token", body: sendBody(raw, [message.from.email]) });
  assert.equal(res.status, 200, res.text);
  const wire = Buffer.from(t.sender.rawSent[0]?.raw ?? []).toString("utf8");
  assert.match(wire, new RegExp(`^In-Reply-To: <${message.rfcMessageId}>`, "m"));
  assert.match(wire, new RegExp(`^References: <${message.rfcMessageId}>`, "m"));
  assert.equal((await t.store.getMessage(String(res.json.sentId)))?.threadId, message.threadId);
});

test("attachments go out as built and are sealed in the Sent copy; oversize messages are refused", async () => {
  const t = await testApp({ bridgeSend: true, deps: { clientSendLimits: { maxBytes: 4000, maxRecipients: 50, perDay: 100, recipientsPerDay: 100, perTenMinutes: 100 } } });
  const boundary = "b1";
  const withAttachment = mime(
    { From: JON, To: "a@example.org", Subject: "File", "Content-Type": `multipart/mixed; boundary="${boundary}"` },
    [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Attached.",
      `--${boundary}`,
      'Content-Type: text/plain; name="note.txt"',
      'Content-Disposition: attachment; filename="note.txt"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("hello attachment").toString("base64"),
      `--${boundary}--`,
      "",
    ].join("\r\n"),
  );
  const res = await t.call("/v1/client/send", { token: "bridge-token", body: sendBody(withAttachment, ["a@example.org"]) });
  assert.equal(res.status, 200, res.text);
  assert.match(Buffer.from(t.sender.rawSent[0]?.raw ?? []).toString("utf8"), /filename="note.txt"/);
  const copy = await t.store.getMessage(String(res.json.sentId));
  assert.equal(copy?.attachments.length, 1);
  assert.equal(copy?.attachments[0]?.filename, "note.txt");

  const big = mime({ From: JON, To: "a@example.org", Subject: "Big" }, `${"x".repeat(5000)}\r\n`);
  const refused = await t.call("/v1/client/send", { token: "bridge-token", body: sendBody(big, ["a@example.org"]) });
  assert.equal(refused.status, 400);
  assert.match(String(refused.json.error), /limit is 4000/);
  assert.equal(t.sender.rawSent.length, 1);
});

test("From must be the mailbox or a configured extra address, and must match MAIL FROM", async () => {
  const t = await testApp({ bridgeSend: true, config: { sendFrom: [JON, "jon@cyberphysical.us"] } });
  const other = await t.call("/v1/client/send", { token: "bridge-token", body: sendBody(mime({ From: "ceo@example.com", To: "a@example.org", Subject: "x" }), ["a@example.org"], "ceo@example.com") });
  assert.equal(other.status, 403);
  const mismatch = await t.call("/v1/client/send", { token: "bridge-token", body: sendBody(mime({ From: JON, To: "a@example.org", Subject: "x" }), ["a@example.org"], "jon@cyberphysical.us") });
  assert.equal(mismatch.status, 403);
  const alias = await t.call("/v1/client/send", {
    token: "bridge-token",
    body: sendBody(mime({ From: "jon@cyberphysical.us", To: "a@example.org", Subject: "x" }), ["a@example.org"], "jon@cyberphysical.us"),
  });
  assert.equal(alias.status, 200, alias.text);
  assert.equal(t.sender.rawSent[0]?.from, "jon@cyberphysical.us");
  const none = await t.call("/v1/client/send", { token: "bridge-token", body: sendBody(mime({ From: JON, To: "a@example.org", Subject: "x" }), []) });
  assert.equal(none.status, 400);
});

test("the global send kill switch stops Thunderbird sends, approved sends and auto-send; tokens can engage it, only Jon can release it", async () => {
  const t = await testApp({ bridgeSend: true });
  const session = await t.login();
  assert.equal((await t.call("/v1/rules/switches", { token: "agent-token", body: { sendKillSwitch: true } })).status, 200, "any write token may make things safer");
  assert.equal((await t.call("/v1/rules/switches", { token: "agent-token", body: { sendKillSwitch: false } })).status, 403);
  assert.equal((await t.call("/v1/rules/switches", { token: "bridge-token", body: { sendKillSwitch: false } })).status, 403, "not even the bridge");

  const body = sendBody(mime({ From: JON, To: "a@example.org", Subject: "x" }), ["a@example.org"]);
  const refused = await t.call("/v1/client/send", { token: "bridge-token", body });
  assert.equal(refused.status, 403);
  assert.match(String(refused.json.error), /kill switch/);

  const { message } = await t.ingest(fixture("personal.eml"));
  const draft = await t.mailbox.createDraft({ to: [message.from.email], subject: "Re", text: "ok", origin: "human" });
  const approval = await t.call(`/v1/drafts/${draft.id}/approval`, { token: session, body: await t.review(draft.id) });
  assert.equal(approval.status, 200);
  const approved = await t.call(`/v1/drafts/${draft.id}/approve-and-send`, { token: "send-token", body: { approvalToken: approval.json.approvalToken } });
  assert.equal(approved.status, 403);
  assert.equal(t.sender.sent.length + t.sender.rawSent.length, 0);

  const rules = { ...emptyRules(new Date()), sendKillSwitch: true };
  const refusals = autoSendRefusals({
    doc: rules,
    rule: { id: "r", name: "r", enabled: true, match: { from: ["a@example.org"] }, actions: [], stop: false, createdBy: "human", updatedAt: "" },
    action: { mode: "autoSend", template: "ok", maxChars: 100, allowSenders: ["a@example.org"], allowCategories: [], perSenderPerDay: 1, perDay: 1, allowAiText: false },
    message,
    enabled: true,
    mailbox: JON,
    domain: "cyberphysical.us",
    recipientUsesPgp: false,
  });
  assert.ok(refusals.includes("global send kill switch is engaged"));

  assert.equal((await t.call("/v1/rules/switches", { token: session, body: { sendKillSwitch: false } })).status, 200);
  assert.equal((await t.call("/v1/client/send", { token: "bridge-token", body })).status, 200);
});

test("direct sends are rate limited (429) and every refusal is audited", async () => {
  const t = await testApp({ bridgeSend: true, deps: { clientSendLimits: { maxBytes: 4_000_000, maxRecipients: 3, perDay: 100, recipientsPerDay: 100, perTenMinutes: 2 } } });
  const body = sendBody(mime({ From: JON, To: "a@example.org", Subject: "x" }), ["a@example.org"]);
  assert.equal((await t.call("/v1/client/send", { token: "bridge-token", body })).status, 200);
  assert.equal((await t.call("/v1/client/send", { token: "bridge-token", body })).status, 200);
  const limited = await t.call("/v1/client/send", { token: "bridge-token", body });
  assert.equal(limited.status, 429);
  assert.match(String(limited.json.error), /10 minutes/);
  const many = sendBody(mime({ From: JON, To: "a@example.org", Subject: "x" }), ["a@example.org", "b@example.org", "c@example.org", "d@example.org"]);
  assert.equal((await t.call("/v1/client/send", { token: "bridge-token", body: many })).status, 400);
  assert.equal(t.sender.rawSent.length, 2);
  const refusals = (await t.store.listAudit()).filter((event) => event.action === "send.client" && event.outcome === "refused");
  assert.deepEqual(refusals.map((event) => event.detail).sort(), ["rate_limited", "too_many_recipients"]);
});

test("sending a bot draft from Thunderbird marks that draft sent and records whether it was unchanged", async () => {
  const t = await testApp({ bridgeSend: true });
  const { message } = await t.ingest(fixture("personal.eml"));
  const created = await t.call("/v1/drafts", {
    token: "agent-token",
    body: { to: [message.from.email], subject: `Re: ${message.subject}`, text: "Yes, Friday works.", inReplyTo: message.rfcMessageId },
  });
  assert.equal(created.status, 201, created.text);
  const draftId = (created.json.draft as { id: string }).id;
  const raw = mime(
    { From: JON, To: message.from.email, Subject: `Re: ${message.subject}`, "In-Reply-To": `<${message.rfcMessageId}>`, References: `<${message.rfcMessageId}>` },
    "Yes, Friday works.\r\n",
  );
  const res = await t.call("/v1/client/send", { token: "bridge-token", body: sendBody(raw, [message.from.email]) });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.draftId, draftId);
  assert.equal(res.json.draftUnchanged, true);
  const draft = await t.store.getDraft(draftId);
  assert.equal(draft?.status, "sent");
  assert.equal(draft?.clientSent?.unchanged, true);
  assert.equal(draft?.sentMessageId, "raw-1@memory");
  assert.ok((await t.store.listAudit()).some((event) => event.action === "send.client" && event.detail?.includes(`draft:${draftId} unchanged:true`)));
  assert.equal((await t.call(`/v1/drafts/${draftId}/discard`, { token: "bridge-token", method: "POST" })).status, 200, "Thunderbird deleting the sent draft is a no-op");
  assert.equal((await t.store.getDraft(draftId))?.status, "sent");
});

test("agents with the trash scope soft-delete as themselves, capped per day; the MCP offers trash_message only to them", async () => {
  const t = await testApp({ bridgeSend: true, deps: { agentTrashPerDay: 1 } });
  const first = (await t.ingest(fixture("personal.eml"))).message;
  const second = (await t.ingest(fixture("attachment.eml"))).message;
  assert.equal((await t.call(`/v1/messages/${first.id}/move`, { token: "agent-token", body: { folder: "trash" } })).status, 403, "no trash scope, no trash");
  const res = await t.call(`/v1/messages/${first.id}/move`, { token: "agent-trash-token", body: { folder: "trash" } });
  assert.equal(res.status, 200, res.text);
  const stored = await t.store.getMessage(first.id);
  assert.equal(stored?.folder, "trash");
  assert.equal(stored?.trashedBy, "agent:cursor");
  assert.ok(stored?.keepUntil, "recoverable for the retention window");
  assert.equal((await t.call(`/v1/messages/${second.id}/move`, { token: "agent-trash-token", body: { folder: "trash" } })).status, 429, "daily cap");
  assert.equal((await t.call(`/v1/messages/${first.id}/restore`, { token: "agent-token", method: "POST" })).status, 200);
  assert.equal((await t.store.getMessage(first.id))?.folder, "inbox");

  const list = async (token: string) => {
    const reply = await t.call("/mcp", { token, body: { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers: { accept: "application/json, text/event-stream" } });
    return { status: reply.status, names: ((reply.json?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []).map((tool) => tool.name) };
  };
  assert.ok((await list("agent-trash-token")).names.includes("trash_message"));
  assert.ok(!(await list("agent-token")).names.includes("trash_message"));
  assert.ok(!(await list("admin-token")).names.includes("trash_message"), "admin does not imply trash");
  assert.equal((await list("bridge-token")).status, 403, "Jon's mail-client credential is never an agent");
});

test("agents cannot write rules, enable auto-send, or hard delete", async () => {
  const t = await testApp();
  const rules = { rules: [{ id: "auto", name: "auto", match: { from: ["a@example.org"] }, actions: [{ type: "reply", reply: { mode: "autoSend", template: "Thanks", allowSenders: ["a@example.org"] } }] }] };
  for (const token of ["agent-token", "agent-trash-token", "admin-token", "bridge-token"]) {
    assert.equal((await t.call("/v1/rules", { method: "PUT", token, body: rules })).status, 403, token);
  }
  const routes = (t.app.routes as Array<{ method: string; path: string }>).map((route) => `${route.method} ${route.path}`);
  assert.ok(!routes.some((route) => route.startsWith("DELETE /v1/")), "no hard-delete route");
});
