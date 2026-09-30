import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "@lojo/core/testing";
import { sesInput } from "./ses.ts";
import { testApp } from "./test-app.ts";

test("inbox requires a token and returns the seeded message", async () => {
  const t = await testApp({ dev: true });
  await t.ingest(fixture("personal.eml"));
  assert.equal((await t.call("/v1/inbox")).status, 401);
  const ok = await t.call("/v1/inbox", { token: "read-token" });
  assert.equal(ok.status, 200);
  const messages = ok.json.messages as Array<{ subject: string; text?: string }>;
  assert.equal(messages[0]?.subject, "Lease renewal by Friday");
  assert.equal(messages[0]?.text, undefined, "read gets metadata only");
  const withBody = (await t.call("/v1/inbox", { token: "body-token" })).json.messages as Array<{ text?: string }>;
  assert.match(withBody[0]?.text ?? "", /CODEWORD-ZEBRA/);
});

test("a read token cannot draft, relabel, or send", async () => {
  const t = await testApp();
  await t.ingest(fixture("personal.eml"));
  const draft = (await t.store.listDrafts())[0];
  assert.ok(draft);
  assert.equal((await t.call(`/v1/drafts/${draft.id}/approve-and-send`, { token: "read-token", body: {} })).status, 403);
  assert.equal((await t.call("/v1/messages/missing/labels", { token: "read-token", body: { labels: ["later"] } })).status, 403);
  assert.equal((await t.call("/v1/drafts", { token: "read-token", body: { to: ["mina@example.com"], subject: "s", text: "t" } })).status, 403);
});

test("a write token can archive; search is read; summarize needs write and body", async () => {
  const t = await testApp({ dev: true });
  const { message } = await t.ingest(fixture("personal.eml"));
  assert.equal((await t.call(`/v1/messages/${message.id}/archive`, { token: "write-token", method: "POST" })).status, 200);
  assert.equal((await t.call("/v1/search", { token: "read-token", body: { query: "lease" } })).status, 200);
  assert.equal((await t.call(`/v1/threads/${message.threadId}/summarize`, { token: "read-token", method: "POST" })).status, 403);
  assert.equal((await t.call(`/v1/threads/${message.threadId}/summarize`, { token: "write-token", method: "POST" })).status, 403);
  assert.equal((await t.call(`/v1/threads/${message.threadId}/summarize`, { token: "body-token", method: "POST" })).status, 403);
  assert.equal((await t.call(`/v1/threads/${message.threadId}/summarize`, { token: "admin-token", method: "POST" })).status, 200);
});

test("locked production shape returns the sealed body envelope, never plaintext", async () => {
  const t = await testApp({ unlocked: false });
  const { message } = await t.ingest(fixture("personal.eml"));
  const view = await t.call(`/v1/messages/${message.id}`, { token: "read-token" });
  assert.equal(view.json.locked, true);
  assert.equal(view.json.text, undefined);
  const sealed = await t.call(`/v1/messages/${message.id}/body`, { token: "read-token" });
  assert.equal(sealed.status, 200);
  assert.equal((sealed.json.envelope as { v: number }).v, 2);
  assert.doesNotMatch(sealed.text, /CODEWORD-ZEBRA/);
});

test("AI-context text needs the body scope", async () => {
  const t = await testApp({ unlocked: false });
  const { message } = await t.ingest(fixture("personal.eml"));
  assert.equal((await t.call(`/v1/messages/${message.id}?context=1`, { token: "write-token" })).status, 403);
  const withBody = await t.call(`/v1/messages/${message.id}?context=1`, { token: "body-token" });
  assert.equal(withBody.status, 200);
  assert.match(String(withBody.json.contextText), /CODEWORD-ZEBRA/);
  assert.equal((await t.call(`/v1/threads/${message.threadId}?context=1`, { token: "read-token" })).status, 403);
});

test("draft text needs the body scope or a human session", async () => {
  const t = await testApp();
  await t.ingest(fixture("personal.eml"));
  assert.equal((await t.call("/v1/drafts?text=1", { token: "write-token" })).status, 403);
  const listed = await t.call("/v1/drafts", { token: "write-token" });
  const drafts = listed.json.drafts as Array<{ text: string | null; draft: Record<string, unknown> }>;
  assert.equal(drafts[0]?.text, null);
  assert.equal(drafts[0]?.draft.sealed, undefined);
  const human = await t.login();
  const withText = await t.call("/v1/drafts?text=1", { token: human });
  assert.match(String((withText.json.drafts as Array<{ text: string }>)[0]?.text), /Thanks for the note/);
});

test("attachments: plaintext bytes when unlocked, the envelope when locked", async () => {
  const unlocked = await testApp({ dev: true });
  const a = await unlocked.ingest(fixture("attachment.eml"));
  const attId = a.message.attachments[0]?.id ?? "";
  const res = await unlocked.app.request(`/v1/messages/${a.message.id}/attachments/${attId}`, { headers: { authorization: "Bearer read-token" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="/);

  const locked = await testApp({ unlocked: false });
  const b = await locked.ingest(fixture("attachment.eml"));
  const sealed = await locked.call(`/v1/messages/${b.message.id}/attachments/${b.message.attachments[0]?.id}`, { token: "read-token" });
  assert.equal((sealed.json.envelope as { v: number }).v, 2);
});

test("ses payload is always raw with sanitized headers and threading", () => {
  const input = sesInput(
    {
      from: { email: "lojo@cyberphysical.us", name: "Jon Hebert" },
      to: [{ email: "ada@example.com" }],
      cc: [],
      subject: "hello\r\nBcc: spy@attacker.example",
      text: "plain",
      inReplyTo: "lease-1@example.com",
      references: ["lease-1@example.com"],
    },
    "lojo-mail",
  );
  const raw = new TextDecoder().decode(input.Content?.Raw?.Data);
  assert.equal(input.Content?.Simple, undefined);
  assert.equal(input.ConfigurationSetName, "lojo-mail");
  assert.doesNotMatch(raw, /\r\nBcc:/);
  assert.match(raw, /\r\nIn-Reply-To: <lease-1@example.com>\r\n/);
  assert.match(raw, /^From: "Jon Hebert" <lojo@cyberphysical.us>\r\n/);
});

test("vector backfill needs write and body, and reports what it did", async () => {
  const api = await testApp();
  await api.ingest(fixture("personal.eml"));
  assert.equal((await api.call("/v1/vectors/backfill", { token: "write-token", method: "POST" })).status, 403);
  assert.equal((await api.call("/v1/vectors/backfill", { token: "body-token", method: "POST" })).status, 403);
  const res = await api.call("/v1/vectors/backfill", { token: "admin-token", body: { limit: 5 } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { embedded: 0, unreadable: 0, failed: 0, remaining: 0 });
  const settings = await api.call("/v1/settings", { token: "read-token" });
  assert.equal(settings.json.embedProvider, "none");
});
