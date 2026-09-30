import assert from "node:assert/strict";
import test from "node:test";
import { MockLlm, parseMime, type LlmRequest } from "@lojo/core";
import { fixture, malicious } from "@lojo/core/testing";
import { sesInput } from "./ses.ts";
import { testApp } from "./test-app.ts";

test("[P0-6] production API (no private key): a send token alone cannot send; a human approval can", async () => {
  const t = await testApp({ unlocked: false });
  await t.store.putContact({ email: "mina@example.com" });
  const draft = await t.mailbox.createDraft({ to: ["mina@example.com"], subject: "Re: lease", text: "Signed copy attached." });
  const bare = await t.call(`/v1/drafts/${draft.id}/approve-and-send`, { token: "send-token", method: "POST" });
  assert.equal(bare.status, 400, "no JSON body is a bad request");
  const noToken = await t.call(`/v1/drafts/${draft.id}/approve-and-send`, { token: "send-token", body: {} });
  assert.equal(noToken.status, 403);
  assert.equal(t.sender.sent.length, 0);

  const human = await t.login();
  const approvalToken = String((await t.call(`/v1/drafts/${draft.id}/approval`, { token: human, body: await t.review(draft.id) })).json.approvalToken);
  const sent = await t.call(`/v1/drafts/${draft.id}/approve-and-send`, { token: human, body: { approvalToken } });
  assert.equal(sent.status, 200, `send in production returned ${sent.status} ${sent.text}`);
  assert.equal(t.sender.sent[0]?.text, "Signed copy attached.");
});

test("[P0-5] production API (no private key): draft-reply and rewrite work", async () => {
  const t = await testApp({ unlocked: false });
  const { message } = await t.ingest(fixture("personal.eml"), {}, null);
  const reply = await t.call(`/v1/messages/${message.id}/draft-reply`, { token: "write-token", method: "POST" });
  assert.equal(reply.status, 201, reply.text);
  const draftId = String((reply.json.draft as { id: string }).id);
  const rewritten = await t.call(`/v1/drafts/${draftId}/rewrite`, { token: "write-token", body: { instruction: "shorter" } });
  assert.equal(rewritten.status, 200, rewritten.text);
});

test("[control] API: path variants do not bypass auth or the send gate", async () => {
  const t = await testApp();
  await t.store.putContact({ email: "mina@example.com" });
  const draft = await t.mailbox.createDraft({ to: ["mina@example.com"], subject: "s", text: "t" });
  for (const path of ["/v1/inbox", "/v1//inbox", "/v1/inbox/", "/v1/./inbox", "/v1/%69nbox", "/v1/health/../inbox", "/V1/inbox"]) {
    assert.notEqual((await t.app.request(path)).status, 200, `unauthenticated ${path} returned 200`);
  }
  for (const path of [
    `/v1/drafts/${draft.id}/approve-and-send`,
    `/v1/drafts/${draft.id}/approve-and-send/`,
    `/v1/drafts/${draft.id}/approve-and-send%2F`,
    `/v1/drafts/${draft.id}/%61pprove-and-send`,
    `/v1/drafts/${draft.id}//approve-and-send`,
    `/v1/drafts/${draft.id}/approval`,
  ]) {
    for (const token of ["write-token", "send-token", "admin-token"]) {
      const res = await t.call(path, { token, body: { approvalToken: "apv_x" } });
      assert.notEqual(res.status, 200, `${token} reached ${path}`);
    }
  }
  assert.equal(t.sender.sent.length, 0);
});

test("[P2] API: a read-only token can search", async () => {
  const t = await testApp();
  await t.ingest(fixture("personal.eml"));
  const res = await t.call("/v1/search", { token: "read-token", body: { query: "lease" } });
  assert.equal(res.status, 200);
});

test("[P1] API: semantic search ranks by body-derived vectors, so it needs the body scope and spends nothing when refused", async () => {
  const t = await testApp();
  await t.ingest(fixture("personal.eml"));
  const spentBefore = (await t.store.listAudit()).filter((event) => event.action === "ai.embed_query").length;
  for (const token of ["read-token", "write-token"]) {
    const res = await t.call("/v1/search", { token, body: { query: "lease", mode: "semantic" } });
    assert.equal(res.status, 403, token);
  }
  assert.equal((await t.store.listAudit()).filter((event) => event.action === "ai.embed_query").length, spentBefore);
  assert.equal((await t.call("/v1/search", { token: "body-token", body: { query: "lease", mode: "semantic" } })).status, 200);
});

test("[P1-10] API: trash needs a human session", async () => {
  const t = await testApp();
  const { message } = await t.ingest(fixture("personal.eml"), {}, null);
  for (const token of ["write-token", "admin-token"]) {
    const res = await t.call(`/v1/messages/${message.id}/move`, { token, body: { folder: "trash" } });
    assert.equal(res.status, 403, token);
  }
  assert.equal((await t.store.getMessage(message.id))?.folder, "inbox");
  const human = await t.login();
  assert.equal((await t.call(`/v1/messages/${message.id}/move`, { token: human, body: { folder: "trash" } })).status, 200);
});

test("[P0-6] API: full export is human-only; the index is metadata", async () => {
  const t = await testApp();
  await t.ingest(fixture("personal.eml"));
  assert.equal((await t.call("/v1/export", { token: "admin-token" })).status, 403);
  const index = await t.call("/v1/export/index", { token: "read-token" });
  assert.equal(index.status, 200);
  assert.doesNotMatch(index.text, /CODEWORD-ZEBRA/);
  assert.doesNotMatch(index.text, /"ct"/);
  const human = await t.login();
  const full = await t.call("/v1/export", { token: human });
  assert.equal(full.status, 200);
  assert.match(full.text, /bodyEnvelope/);
});

test("[P1] API: read and write tokens get no message text, even from a server that can open bodies", async () => {
  const t = await testApp();
  const { message } = await t.ingest(fixture("personal.eml"));
  for (const token of ["read-token", "write-token"]) {
    const reads = [
      await t.call(`/v1/messages/${message.id}`, { token }),
      await t.call(`/v1/threads/${message.threadId}`, { token }),
      await t.call("/v1/inbox", { token }),
      await t.call("/v1/triage", { token }),
    ];
    for (const res of reads) {
      assert.equal(res.status, 200, token);
      assert.doesNotMatch(res.text, /CODEWORD-ZEBRA|"summary"|"threadSummary"|"actionItems"/, token);
    }
    const found = await t.call("/v1/search", { token, body: { query: "CODEWORD-ZEBRA" } });
    assert.deepEqual(found.json.messages, [], `${token} can search body text`);
    const summary = await t.call(`/v1/threads/${message.threadId}/summarize`, { token, method: "POST" });
    assert.equal(summary.status, 403, `${token} summarize`);
    assert.equal((await t.call("/v1/action-items", { token })).status, 403, `${token} action items`);
  }
  const auditBefore = (await t.store.listAudit()).filter((event) => event.action === "ai.summarize_thread").length;
  assert.equal(auditBefore, 0, "a refused summary spends no tokens");
  assert.match((await t.call(`/v1/messages/${message.id}`, { token: "body-token" })).text, /CODEWORD-ZEBRA/);
  const human = await t.login();
  assert.match((await t.call(`/v1/messages/${message.id}`, { token: human })).text, /CODEWORD-ZEBRA/);
  assert.equal((await t.call(`/v1/threads/${message.threadId}/summarize`, { token: human, method: "POST" })).status, 200);
});

test("[P2] API: a non-JSON model reply falls back to a plain reply; a provider failure is a 502, never a bare 500", async () => {
  const prose = new MockLlm((request: LlmRequest) =>
    request.system.startsWith("Write Jon's reply")
      ? { text: "Hi Mina,\n\nWill do.\n\nJon", inputTokens: 50, outputTokens: 5 }
      : { text: "Sure! This email is about a lease.", inputTokens: 50, outputTokens: 5 },
  );
  const t = await testApp({ llm: prose });
  const { message } = await t.ingest(fixture("personal.eml"));
  const ok = await t.call(`/v1/messages/${message.id}/draft-reply`, { token: "admin-token", method: "POST" });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.json.text, "Hi Mina,\n\nWill do.\n\nJon");

  const down = await testApp({
    llm: new MockLlm(() => {
      throw new Error("503 from provider");
    }),
  });
  const again = await down.ingest(fixture("personal.eml"));
  for (const path of [`/v1/messages/${again.message.id}/draft-reply`, `/v1/threads/${again.message.threadId}/summarize`]) {
    const res = await down.call(path, { token: "admin-token", method: "POST" });
    assert.equal(res.status, 502, `${path} ${res.text}`);
    assert.equal(res.json.code, "upstream");
    assert.doesNotMatch(res.text, /503 from provider|internal/);
  }
});

test("[P0-6] API: an agent draft to a stranger is refused; a human draft is not", async () => {
  const t = await testApp();
  await t.ingest(fixture("personal.eml"));
  const agent = await t.call("/v1/drafts", { token: "write-token", body: { to: ["archive@attacker.example"], subject: "backup", text: "x" } });
  assert.equal(agent.status, 403);
  const human = await t.login();
  const own = await t.call("/v1/drafts", { token: human, body: { to: ["new-friend@example.org"], subject: "hi", text: "x" } });
  assert.equal(own.status, 201);
  assert.equal((own.json.draft as { origin: string }).origin, "human");
});

test("[P2] RFC 2047 subject cannot carry CR/LF into outbound raw headers", async () => {
  const parsed = await parseMime(malicious("06-subject-crlf.eml"));
  const input = sesInput(
    { from: { email: "lojo@cyberphysical.us" }, to: [{ email: "mina@example.com" }], cc: [], subject: `Re: ${parsed.subject}`, text: "x", armored: "-----BEGIN PGP MESSAGE-----" },
    "cfg",
  );
  const raw = new TextDecoder().decode(input.Content?.Raw?.Data);
  assert.doesNotMatch(raw, /\r\nBcc: spy@attacker\.example/);
});
