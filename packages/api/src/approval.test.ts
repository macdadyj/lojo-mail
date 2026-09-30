import assert from "node:assert/strict";
import test from "node:test";
import { APPROVAL_TTL_MS } from "@lojo/core";
import { testApp } from "./test-app.ts";

async function withDraft(opts: Parameters<typeof testApp>[0] = {}) {
  const t = await testApp(opts);
  await t.store.putContact({ email: "mina@example.com" });
  const draft = await t.mailbox.createDraft({ to: ["mina@example.com"], subject: "Re: lease", text: "Signed copy attached." });
  return { ...t, draft };
}

test("a human mints an approval and the web sends with it", async () => {
  const t = await withDraft();
  const human = await t.login();
  const minted = await t.call(`/v1/drafts/${t.draft.id}/approval`, { token: human, body: await t.review(t.draft.id) });
  assert.equal(minted.status, 200);
  const approvalToken = String(minted.json.approvalToken);
  assert.match(approvalToken, /^apv_/);
  const sent = await t.call(`/v1/drafts/${t.draft.id}/approve-and-send`, { token: human, body: { approvalToken } });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(t.sender.sent.length, 1);
});

test("a send token with no approval gets 403", async () => {
  const t = await withDraft();
  const res = await t.call(`/v1/drafts/${t.draft.id}/approve-and-send`, { token: "send-token", body: {} });
  assert.equal(res.status, 403);
  const guessed = await t.call(`/v1/drafts/${t.draft.id}/approve-and-send`, { token: "send-token", body: { approvalToken: "apv_guess" } });
  assert.equal(guessed.status, 403);
  assert.equal(t.sender.sent.length, 0);
});

test("an API token cannot mint an approval, whatever its scopes", async () => {
  const t = await withDraft();
  for (const token of ["read-token", "write-token", "send-token", "body-token", "admin-token"]) {
    const res = await t.call(`/v1/drafts/${t.draft.id}/approval`, { token, body: await t.review(t.draft.id) });
    assert.equal(res.status, 403, token);
  }
  assert.equal((await t.store.getDraft(t.draft.id))?.approvalTokenHash, undefined);
});

test("a human-minted token also works for a send-scoped caller, once", async () => {
  const t = await withDraft();
  const human = await t.login();
  const approvalToken = String((await t.call(`/v1/drafts/${t.draft.id}/approval`, { token: human, body: await t.review(t.draft.id) })).json.approvalToken);
  assert.equal((await t.call(`/v1/drafts/${t.draft.id}/approve-and-send`, { token: "write-token", body: { approvalToken } })).status, 403);
  assert.equal((await t.call(`/v1/drafts/${t.draft.id}/approve-and-send`, { token: "send-token", body: { approvalToken } })).status, 200);
  const replay = await t.call(`/v1/drafts/${t.draft.id}/approve-and-send`, { token: "send-token", body: { approvalToken } });
  assert.equal(replay.status, 400, replay.text);
  assert.equal(t.sender.sent.length, 1);
});

test("an approval for different content is rejected", async () => {
  const t = await withDraft();
  const human = await t.login();
  const approvalToken = String((await t.call(`/v1/drafts/${t.draft.id}/approval`, { token: human, body: await t.review(t.draft.id) })).json.approvalToken);
  const edited = await t.call(`/v1/drafts/${t.draft.id}`, { token: "write-token", body: { text: "Different words." } });
  assert.equal(edited.status, 200);
  const res = await t.call(`/v1/drafts/${t.draft.id}/approve-and-send`, { token: "send-token", body: { approvalToken } });
  assert.equal(res.status, 403);
  assert.equal(t.sender.sent.length, 0);
});

test("a write-token edit after Jon opened the draft gets 409 instead of an approval", async () => {
  const t = await withDraft();
  const human = await t.login();
  const reviewed = await t.review(t.draft.id);
  for (const edit of [{ text: "Wire the deposit to the new account." }, { pgp: "off" }, { cc: ["mina@example.com"] }]) {
    const changed = await t.call(`/v1/drafts/${t.draft.id}`, { token: "write-token", body: edit });
    assert.equal(changed.status, 200, changed.text);
    const res = await t.call(`/v1/drafts/${t.draft.id}/approval`, { token: human, body: reviewed });
    assert.equal(res.status, 409, JSON.stringify(edit));
    assert.equal(res.json.code, "conflict");
    assert.equal((await t.store.getDraft(t.draft.id))?.approvalTokenHash, undefined);
    const restored = await t.call(`/v1/drafts/${t.draft.id}`, { token: human, body: reviewed });
    assert.equal(restored.status, 200, restored.text);
  }
  const minted = await t.call(`/v1/drafts/${t.draft.id}/approval`, { token: human, body: reviewed });
  assert.equal(minted.status, 200, minted.text);
  assert.equal(t.sender.sent.length, 0);
});

test("minting needs the reviewed content", async () => {
  const t = await withDraft();
  const human = await t.login();
  const reviewed = await t.review(t.draft.id);
  const { pgp: _pgp, ...withoutPgp } = reviewed;
  const bodies: unknown[] = [undefined, {}, withoutPgp, { ...reviewed, pgp: "maybe" }, { ...reviewed, to: "mina@example.com" }, { ...reviewed, text: 1 }];
  for (const body of bodies) {
    const res = await t.call(`/v1/drafts/${t.draft.id}/approval`, body === undefined ? { token: human, method: "POST" } : { token: human, body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal((await t.store.getDraft(t.draft.id))?.approvalTokenHash, undefined);
});

test("an expired approval is rejected", async () => {
  let clock = Date.parse("2026-09-29T12:00:00Z");
  const t = await withDraft({ now: () => new Date(clock) });
  const human = await t.login();
  const approvalToken = String((await t.call(`/v1/drafts/${t.draft.id}/approval`, { token: human, body: await t.review(t.draft.id) })).json.approvalToken);
  clock += APPROVAL_TTL_MS + 1;
  const res = await t.call(`/v1/drafts/${t.draft.id}/approve-and-send`, { token: human, body: { approvalToken } });
  assert.equal(res.status, 403);
  assert.match(String(res.json.error), /expired/);
});

test("an agent can submit a draft for approval but not send it", async () => {
  const t = await withDraft();
  const submitted = await t.call(`/v1/drafts/${t.draft.id}/submit`, { token: "write-token", method: "POST" });
  assert.equal((submitted.json.draft as { status: string }).status, "pending_approval");
  assert.equal(t.sender.sent.length, 0);
});
