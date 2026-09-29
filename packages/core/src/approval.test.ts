import assert from "node:assert/strict";
import test from "node:test";
import { APPROVAL_TTL_MS, hashApprovalToken } from "./approval.ts";
import type { DraftPatch } from "./mailbox.ts";
import { fixture, memoryWorld, reviewOf, type MemoryWorld } from "./testing.ts";

async function withDraft(opts: Parameters<typeof memoryWorld>[0] = {}) {
  const w = await memoryWorld(opts);
  await w.store.putContact({ email: "mina@example.com" });
  const draft = await w.mailbox.createDraft({ to: ["mina@example.com"], subject: "Re: lease", text: "Signed copy attached." });
  return { ...w, draft };
}

async function approve(w: MemoryWorld, draftId: string) {
  return w.mailbox.mintApproval(draftId, "human", await reviewOf(w.mailbox, draftId));
}

test("an approved draft sends once and files Jon's copy in sent", async () => {
  const w = await withDraft();
  const { approvalToken, expiresAt } = await approve(w, w.draft.id);
  assert.match(approvalToken, /^apv_[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(expiresAt) > Date.now());
  const stored = await w.store.getDraft(w.draft.id);
  assert.equal(stored?.approvalTokenHash, hashApprovalToken(approvalToken));
  assert.equal(JSON.stringify(stored).includes(approvalToken), false, "only the hash is stored");

  const sent = await w.mailbox.approveAndSend(w.draft.id, approvalToken);
  assert.equal(w.sender.sent.length, 1);
  assert.equal(w.sender.sent[0]?.text, "Signed copy attached.");
  const after = await w.store.getDraft(w.draft.id);
  assert.equal(after?.status, "sent");
  assert.ok(after?.approvalUsedAt);
  const copy = (await w.store.listMessages({ folder: "sent" }))[0];
  assert.equal(copy?.origin, "sent");
  assert.equal(copy?.deliveryId, `sent:${sent.messageId}`);
  assert.equal(copy?.unread, false);
  assert.ok((await w.store.listAudit()).some((event) => event.action === "send.approved" && event.detail === sent.messageId));
});

test("an agent cannot mint an approval", async () => {
  const w = await withDraft();
  const reviewed = await reviewOf(w.mailbox, w.draft.id);
  await assert.rejects(() => w.mailbox.mintApproval(w.draft.id, "agent", reviewed), /Only a signed-in human/);
});

test("sending without an approval token is refused", async () => {
  const w = await withDraft();
  await assert.rejects(() => w.mailbox.approveAndSend(w.draft.id, ""), /approval token is required/);
  await assert.rejects(() => w.mailbox.approveAndSend(w.draft.id, "apv_guess"), /does not match/);
  assert.equal(w.sender.sent.length, 0);
});

test("an approval for different content is rejected", async () => {
  const w = await withDraft();
  const { approvalToken } = await approve(w, w.draft.id);
  await w.store.putDraft({ ...((await w.store.getDraft(w.draft.id)) ?? w.draft), to: [{ email: "archive@attacker.example" }] });
  await assert.rejects(() => w.mailbox.approveAndSend(w.draft.id, approvalToken), /changed after it was approved/);
  assert.equal(w.sender.sent.length, 0);
});

test("an approval is minted only for the content Jon reviewed", async () => {
  const w = await withDraft();
  const reviewed = await reviewOf(w.mailbox, w.draft.id);
  await w.mailbox.updateDraft(w.draft.id, { text: "Change of plan: wire the deposit to the new account." }, "agent");
  await assert.rejects(() => w.mailbox.mintApproval(w.draft.id, "human", reviewed), {
    code: "conflict",
    message: /changed since you reviewed/,
  });
  assert.equal((await w.store.getDraft(w.draft.id))?.approvalTokenHash, undefined);
  assert.ok((await w.store.listAudit()).some((event) => event.action === "send.approval_refused" && event.messageId === w.draft.id));
  assert.equal(w.sender.sent.length, 0);
});

test("a recipient, subject, or PGP change after review blocks the approval", async () => {
  const changes: DraftPatch[] = [{ to: ["bob@example.com"] }, { cc: ["bob@example.com"] }, { subject: "Re: lease (new bank details)" }, { pgp: "off" }];
  for (const change of changes) {
    const w = await withDraft();
    await w.store.putContact({ email: "bob@example.com" });
    const reviewed = await reviewOf(w.mailbox, w.draft.id);
    await w.mailbox.updateDraft(w.draft.id, change, "agent");
    await assert.rejects(() => w.mailbox.mintApproval(w.draft.id, "human", reviewed), { code: "conflict" }, JSON.stringify(change));
    assert.equal((await w.store.getDraft(w.draft.id))?.approvalTokenHash, undefined);
  }
});

test("address case, whitespace, and header line breaks in the review do not block an approval", async () => {
  const w = await withDraft();
  const reviewed = await reviewOf(w.mailbox, w.draft.id);
  const minted = await w.mailbox.mintApproval(w.draft.id, "human", { ...reviewed, to: [" Mina@Example.com "], subject: ` ${reviewed.subject}\r\n` });
  await w.mailbox.approveAndSend(w.draft.id, minted.approvalToken);
  assert.equal(w.sender.sent.length, 1);
});

test("editing a draft through the mailbox clears its approval", async () => {
  const w = await withDraft();
  const { approvalToken } = await approve(w, w.draft.id);
  await w.mailbox.updateDraft(w.draft.id, { text: "Changed." }, "human");
  await assert.rejects(() => w.mailbox.approveAndSend(w.draft.id, approvalToken), /does not match/);
});

test("an approval token for one draft does not send another", async () => {
  const w = await withDraft();
  const other = await w.mailbox.createDraft({ to: ["mina@example.com"], subject: "other", text: "other" });
  const { approvalToken } = await approve(w, w.draft.id);
  await assert.rejects(() => w.mailbox.approveAndSend(other.id, approvalToken), /does not match/);
});

test("replaying an approval token is rejected", async () => {
  const w = await withDraft();
  const { approvalToken } = await approve(w, w.draft.id);
  await w.mailbox.approveAndSend(w.draft.id, approvalToken);
  await assert.rejects(() => w.mailbox.approveAndSend(w.draft.id, approvalToken));
  assert.equal(w.sender.sent.length, 1);
});

test("concurrent sends with one token send once", async () => {
  const w = await withDraft();
  const { approvalToken } = await approve(w, w.draft.id);
  const results = await Promise.allSettled([
    w.mailbox.approveAndSend(w.draft.id, approvalToken),
    w.mailbox.approveAndSend(w.draft.id, approvalToken),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(w.sender.sent.length, 1);
});

test("an expired approval is rejected", async () => {
  let clock = Date.parse("2026-09-29T12:00:00Z");
  const w = await withDraft({ now: () => new Date(clock) });
  const { approvalToken } = await approve(w, w.draft.id);
  clock += APPROVAL_TTL_MS + 1;
  await assert.rejects(() => w.mailbox.approveAndSend(w.draft.id, approvalToken), /expired/);
  assert.equal(w.sender.sent.length, 0);
});

test("an SES failure reverts the draft to edited and needs a new approval", async () => {
  const w = await withDraft();
  const { approvalToken } = await approve(w, w.draft.id);
  w.sender.failNext = true;
  await assert.rejects(() => w.mailbox.approveAndSend(w.draft.id, approvalToken), /needs a new approval/);
  const after = await w.store.getDraft(w.draft.id);
  assert.equal(after?.status, "edited");
  assert.equal(after?.approvalTokenHash, undefined);
  await assert.rejects(() => w.mailbox.approveAndSend(w.draft.id, approvalToken));
  const again = await approve(w, w.draft.id);
  await w.mailbox.approveAndSend(w.draft.id, again.approvalToken);
  assert.equal(w.sender.sent.length, 1);
});

test("an agent may only draft to known correspondents", async () => {
  const w = await memoryWorld();
  const { message } = await w.ingest(fixture("personal.eml"));
  await assert.rejects(
    () => w.mailbox.createDraft({ to: ["archive@attacker.example"], subject: "backup", text: "x" }),
    /not a known correspondent/,
  );
  const reply = await w.mailbox.createDraft({ to: ["mina@example.com"], subject: "Re", text: "x", threadId: message.threadId });
  assert.equal(reply.origin, "agent");
  const human = await w.mailbox.createDraft({ to: ["new@example.org"], subject: "hi", text: "x", origin: "human" });
  assert.equal(human.origin, "human");
  await assert.rejects(() => w.mailbox.updateDraft(reply.id, { to: ["archive@attacker.example"] }, "agent"), /not a known correspondent/);
});

test("agents cannot trash mail; a human can", async () => {
  const w = await memoryWorld({ llm: null });
  const { message } = await w.ingest(fixture("personal.eml"));
  await assert.rejects(() => w.mailbox.move(message.id, "trash"), /Only a signed-in human/);
  await assert.rejects(() => w.mailbox.move(message.id, "trash", "agent"), /Only a signed-in human/);
  assert.equal((await w.mailbox.move(message.id, "trash", "human")).folder, "trash");
});

test("submit for approval parks an agent draft without sending", async () => {
  const w = await withDraft();
  const submitted = await w.mailbox.submitForApproval(w.draft.id);
  assert.equal(submitted.status, "pending_approval");
  assert.equal(w.sender.sent.length, 0);
});
