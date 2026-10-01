import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { testApp } from "./test-app.ts";

const PHOTO = Buffer.from("not really a JPEG");
const hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function file(bytes: Buffer = PHOTO, filename = "Photo 1.jpg") {
  return { filename, contentType: "image/jpeg", sha256: hex(bytes), data: bytes.toString("base64") };
}

async function withDraft() {
  const t = await testApp();
  await t.store.putContact({ email: "mina@example.com" });
  const draft = await t.mailbox.createDraft({ to: ["mina@example.com"], subject: "Lease", text: "Signed copy attached.", origin: "human" });
  return { ...t, draft };
}

interface DraftJson {
  draft: { attachments?: { id: string; filename: string; contentType: string; size: number; sha256: string }[]; lastEditedBy?: string };
  text: string | null;
}

test("settings advertise the draft attachment limits", async () => {
  const t = await testApp();
  const res = await t.call("/v1/settings", { token: "read-token" });
  assert.deepEqual(res.json.draftAttachments, { maxMessageBytes: 4_000_000, maxFiles: 10 });
});

test("the app's flow: upload, review with the hashes, approve, send", async () => {
  const t = await withDraft();
  const human = await t.login();
  const added = await t.call(`/v1/drafts/${t.draft.id}/attachments`, { token: human, body: file() });
  assert.equal(added.status, 200, added.text);
  const view = added.json as unknown as DraftJson;
  assert.equal(view.text, "Signed copy attached.");
  assert.deepEqual(
    view.draft.attachments?.map(({ filename, contentType, size, sha256 }) => ({ filename, contentType, size, sha256 })),
    [{ filename: "Photo 1.jpg", contentType: "image/jpeg", size: PHOTO.byteLength, sha256: hex(PHOTO) }],
  );

  const reviewed = { to: ["mina@example.com"], cc: [], subject: "Lease", text: "Signed copy attached.", pgp: "auto" };
  const without = await t.call(`/v1/drafts/${t.draft.id}/approval`, { token: human, body: reviewed });
  assert.equal(without.status, 409, "an approval that doesn't name the file is a conflict");
  const minted = await t.call(`/v1/drafts/${t.draft.id}/approval`, { token: human, body: { ...reviewed, attachments: [hex(PHOTO)] } });
  assert.equal(minted.status, 200, minted.text);
  const sent = await t.call(`/v1/drafts/${t.draft.id}/approve-and-send`, { token: human, body: { approvalToken: minted.json.approvalToken } });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(t.sender.sent[0]?.attachments?.[0]?.filename, "Photo 1.jpg");
});

test("a bot can attach and remove files, but a file added after review blocks the send", async () => {
  const t = await withDraft();
  const human = await t.login();
  const minted = await t.call(`/v1/drafts/${t.draft.id}/approval`, { token: human, body: await t.review(t.draft.id) });
  const approvalToken = minted.json.approvalToken;
  const added = await t.call(`/v1/drafts/${t.draft.id}/attachments`, { token: "agent-token", body: file() });
  assert.equal(added.status, 200, added.text);
  const view = added.json as unknown as DraftJson;
  assert.equal(view.draft.lastEditedBy, "agent");
  const refused = await t.call(`/v1/drafts/${t.draft.id}/approve-and-send`, { token: "send-token", body: { approvalToken } });
  assert.equal(refused.status, 403);
  assert.equal(t.sender.sent.length, 0);

  const id = view.draft.attachments?.[0]?.id ?? "";
  const removed = await t.call(`/v1/drafts/${t.draft.id}/attachments/${id}/remove`, { token: "agent-token", method: "POST" });
  assert.equal(removed.status, 200, removed.text);
  assert.deepEqual((removed.json as unknown as DraftJson).draft.attachments, []);
  const again = await t.call(`/v1/drafts/${t.draft.id}/attachments/${id}/remove`, { token: "agent-token", method: "POST" });
  assert.equal(again.status, 404);
});

test("uploads need write, a matching hash, base64, and room in the message", async () => {
  const t = await withDraft();
  assert.equal((await t.call(`/v1/drafts/${t.draft.id}/attachments`, { token: "read-token", body: file() })).status, 403);
  const wrongHash = await t.call(`/v1/drafts/${t.draft.id}/attachments`, { token: "write-token", body: { ...file(), sha256: hex(Buffer.from("x")) } });
  assert.equal(wrongHash.status, 400);
  const notBase64 = await t.call(`/v1/drafts/${t.draft.id}/attachments`, { token: "write-token", body: { ...file(), data: "%%%" } });
  assert.equal(notBase64.status, 400);
  const big = Buffer.alloc(3_000_000, 1);
  const tooLarge = await t.call(`/v1/drafts/${t.draft.id}/attachments`, { token: "write-token", body: file(big) });
  assert.equal(tooLarge.status, 413, tooLarge.text);
  const badList = await t.call(`/v1/drafts/${t.draft.id}/approval`, { token: await t.login(), body: { ...(await t.review(t.draft.id)), attachments: ["nope"] } });
  assert.equal(badList.status, 400);
});

test("a write token without body gets the view without the draft text", async () => {
  const t = await withDraft();
  const res = await t.call(`/v1/drafts/${t.draft.id}/attachments`, { token: "write-token", body: file() });
  assert.equal(res.status, 200);
  assert.equal((res.json as unknown as DraftJson).text, null);
});
