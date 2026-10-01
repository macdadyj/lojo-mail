import assert from "node:assert/strict";
import test from "node:test";
import { simpleParser } from "mailparser";
import * as openpgp from "openpgp";
import { approvalContentHash } from "./approval.ts";
import { draftAttachmentKey } from "./blob/store.ts";
import { draftAttachmentContext, serverSealBytes } from "./crypto/server-seal.ts";
import { DEFAULT_CLIENT_SEND_LIMITS } from "./client-send.ts";
import { DRAFT_ATTACHMENT_LIMITS, cleanAttachmentFilename, encodedSize, estimatedMessageBytes } from "./draft-attachments.ts";
import { sha256 } from "./ids.ts";
import { buildRawMessage, mimeParameter } from "./mime/compose.ts";
import { generateTestKey } from "./openpgp/mail.ts";
import { memoryWorld, reviewOf, type MemoryWorld } from "./testing.ts";

const PHOTO = new TextEncoder().encode("JPEG bytes, honest: \u00ff\u00d8 not really");

function upload(data: Uint8Array, filename = "Photo 2026-09-30 1.jpg", contentType = "image/jpeg") {
  return { filename, contentType, sha256: sha256(data), data };
}

async function withDraft(opts: Parameters<typeof memoryWorld>[0] = {}) {
  const w = await memoryWorld(opts);
  await w.store.putContact({ email: "mina@example.com" });
  const draft = await w.mailbox.createDraft({ to: ["mina@example.com"], subject: "Lease", text: "Signed copy attached.", origin: "human" });
  return { ...w, draft };
}

async function send(w: MemoryWorld, draftId: string) {
  const { approvalToken } = await w.mailbox.mintApproval(draftId, "human", await reviewOf(w.mailbox, draftId));
  return w.mailbox.approveAndSend(draftId, approvalToken);
}

test("a file is stored sealed, listed with its hash, and counts as an edit", async () => {
  const w = await withDraft();
  const { approvalToken } = await w.mailbox.mintApproval(w.draft.id, "human", await reviewOf(w.mailbox, w.draft.id));
  const draft = await w.mailbox.addDraftAttachment(w.draft.id, upload(PHOTO, "../../etc/\u0007Photo \"1\".jpg", "IMAGE/JPEG; x=1"), "agent");
  const [file] = draft.attachments ?? [];
  assert.ok(file);
  assert.deepEqual({ ...file, id: "" }, { id: "", filename: "Photo 1.jpg", contentType: "image/jpeg", size: PHOTO.byteLength, sha256: sha256(PHOTO) });
  assert.equal(draft.lastEditedBy, "agent");
  assert.equal(draft.status, "edited");
  assert.equal(draft.approvalTokenHash, undefined, "adding a file clears the approval");
  await assert.rejects(() => w.mailbox.approveAndSend(w.draft.id, approvalToken), /does not match/);

  const stored = w.blobs.objects.get(draftAttachmentKey(w.draft.id, file.id));
  assert.ok(stored);
  const sealed = JSON.parse(new TextDecoder().decode(stored)) as { ctx: Record<string, string> };
  assert.deepEqual(sealed.ctx, draftAttachmentContext(w.draft.id, file.id));
  assert.equal(Buffer.from(stored).includes(Buffer.from("honest")), false, "no plaintext in the blob store");

  const view = await w.mailbox.getDraft(w.draft.id);
  assert.equal(view.draft.attachments?.[0]?.sha256, sha256(PHOTO));
  assert.ok((await w.store.listAudit()).some((event) => event.action === "draft.attachment_added" && event.detail?.includes("by:agent")));
});

test("a file is refused when its hash is wrong, past the file count, or over the message size", async () => {
  const w = await withDraft();
  await assert.rejects(() => w.mailbox.addDraftAttachment(w.draft.id, { ...upload(PHOTO), sha256: sha256("other") }), { code: "invalid", message: /sha256/ });
  const many = await withDraft();
  for (let index = 0; index < 10; index += 1) await many.mailbox.addDraftAttachment(many.draft.id, upload(new Uint8Array([index])));
  await assert.rejects(() => many.mailbox.addDraftAttachment(many.draft.id, upload(new Uint8Array([99]))), { code: "invalid", message: /at most 10 files/ });
  const big = new Uint8Array(2_990_000);
  await assert.rejects(() => w.mailbox.addDraftAttachment(w.draft.id, upload(big)), { code: "too_large" });
  const fits = new Uint8Array(2_900_000);
  await w.mailbox.addDraftAttachment(w.draft.id, upload(fits));
  await assert.rejects(() => w.mailbox.addDraftAttachment(w.draft.id, upload(new Uint8Array(100_000))), { code: "too_large" });
  assert.equal((await w.store.getDraft(w.draft.id))?.attachments?.length, 1);
});

test("files can only be changed while the draft is editable", async () => {
  const w = await withDraft();
  await w.mailbox.discardDraft(w.draft.id);
  await assert.rejects(() => w.mailbox.addDraftAttachment(w.draft.id, upload(PHOTO)), /Draft is discarded/);
});

test("the approval names every file: a missing, extra, or swapped file is a conflict", async () => {
  const w = await withDraft();
  const withFile = await w.mailbox.addDraftAttachment(w.draft.id, upload(PHOTO), "human");
  const reviewed = await reviewOf(w.mailbox, w.draft.id);
  assert.deepEqual(reviewed.attachments, [sha256(PHOTO)]);

  const { attachments: _omitted, ...withoutFiles } = reviewed;
  await assert.rejects(() => w.mailbox.mintApproval(w.draft.id, "human", withoutFiles), { code: "conflict" });

  const fileId = withFile.attachments?.[0]?.id ?? "";
  await w.mailbox.removeDraftAttachment(w.draft.id, fileId, "agent");
  await w.mailbox.addDraftAttachment(w.draft.id, upload(new TextEncoder().encode("a different file"), "Photo 2026-09-30 1.jpg"), "agent");
  await assert.rejects(() => w.mailbox.mintApproval(w.draft.id, "human", reviewed), { code: "conflict", message: /changed since you reviewed/ });
  assert.equal(w.blobs.objects.has(draftAttachmentKey(w.draft.id, fileId)), false, "a removed file's blob is deleted");
  assert.equal(w.sender.sent.length, 0);
});

test("a draft without files hashes exactly as before", () => {
  const content = { from: "lojo@cyberphysical.us", to: [{ email: "a@example.com" }], cc: [], subject: "s", text: "t", pgp: "auto" as const };
  assert.equal(approvalContentHash({ ...content, attachments: [] }), approvalContentHash(content));
  assert.equal(approvalContentHash({ ...content, bcc: [] }), approvalContentHash(content));
  assert.notEqual(approvalContentHash({ ...content, bcc: [{ email: "hidden@example.com" }] }), approvalContentHash(content));
  const file = { sha256: sha256(PHOTO), filename: "a.jpg", contentType: "image/jpeg" };
  assert.notEqual(approvalContentHash({ ...content, attachments: [file] }), approvalContentHash(content));
  assert.notEqual(approvalContentHash({ ...content, attachments: [file] }), approvalContentHash({ ...content, attachments: [{ ...file, filename: "b.jpg" }] }));
});

test("sending builds multipart/mixed, files a copy with the attachment in Sent, and deletes the draft's files", async () => {
  const w = await withDraft();
  const second = new Uint8Array(5000).map((_, index) => index % 251);
  await w.mailbox.addDraftAttachment(w.draft.id, upload(PHOTO), "human");
  await w.mailbox.addDraftAttachment(w.draft.id, upload(second, "Résumé – final.pdf", "application/pdf"), "human");
  const files = (await w.store.getDraft(w.draft.id))?.attachments ?? [];
  const result = await send(w, w.draft.id);
  assert.equal(result.encryption, "none");

  const out = w.sender.sent[0];
  assert.ok(out);
  assert.equal(out.armored, undefined);
  const raw = buildRawMessage(out);
  assert.match(raw, /Content-Type: multipart\/mixed; boundary="=_lojo_[0-9a-f]{24}"/);
  assert.match(raw, /filename\*=UTF-8''R%C3%A9sum%C3%A9%20%E2%80%93%20final\.pdf/);
  const parsed = await simpleParser(Buffer.from(raw));
  assert.equal(parsed.text?.trim(), "Signed copy attached.");
  assert.deepEqual(
    parsed.attachments.map((item) => [item.filename, item.contentType, sha256(new Uint8Array(item.content))]),
    [
      ["Photo 2026-09-30 1.jpg", "image/jpeg", sha256(PHOTO)],
      ["Résumé – final.pdf", "application/pdf", sha256(second)],
    ],
  );

  const copy = (await w.store.listMessages({ folder: "sent" }))[0];
  assert.deepEqual(copy?.attachments.map((item) => [item.filename, item.size]), [
    ["Photo 2026-09-30 1.jpg", PHOTO.byteLength],
    ["Résumé – final.pdf", second.byteLength],
  ]);
  for (const file of files) assert.equal(w.blobs.objects.has(draftAttachmentKey(w.draft.id, file.id)), false);
});

test("a file swapped in storage after approval is refused at send", async () => {
  const w = await withDraft();
  const draft = await w.mailbox.addDraftAttachment(w.draft.id, upload(PHOTO), "human");
  const file = draft.attachments?.[0];
  assert.ok(file);
  const { approvalToken } = await w.mailbox.mintApproval(w.draft.id, "human", await reviewOf(w.mailbox, w.draft.id));
  const evil = await serverSealBytes(new TextEncoder().encode("malware"), draftAttachmentContext(w.draft.id, file.id), w.keys);
  await w.blobs.put(draftAttachmentKey(w.draft.id, file.id), new TextEncoder().encode(JSON.stringify(evil)));
  await assert.rejects(() => w.mailbox.approveAndSend(w.draft.id, approvalToken), /changed after it was attached/);
  assert.equal(w.sender.sent.length, 0);
  assert.equal((await w.store.getDraft(w.draft.id))?.status, "edited", "nothing was claimed");
});

test("the send kill switch still stops a draft with files", async () => {
  const w = await withDraft();
  await w.mailbox.addDraftAttachment(w.draft.id, upload(PHOTO), "human");
  const { approvalToken } = await w.mailbox.mintApproval(w.draft.id, "human", await reviewOf(w.mailbox, w.draft.id));
  await w.mailbox.setRuleSwitches({ sendKillSwitch: true }, "human");
  await assert.rejects(() => w.mailbox.approveAndSend(w.draft.id, approvalToken), /kill switch/);
  assert.equal(w.sender.sent.length, 0);
});

test("discarding a draft deletes its sealed files", async () => {
  const w = await withDraft();
  const draft = await w.mailbox.addDraftAttachment(w.draft.id, upload(PHOTO), "human");
  await w.mailbox.discardDraft(w.draft.id);
  assert.equal(w.blobs.objects.has(draftAttachmentKey(w.draft.id, draft.attachments?.[0]?.id ?? "")), false);
});

test("with OpenPGP the whole MIME tree, files included, is encrypted (PGP/MIME)", async () => {
  const jon = await generateTestKey("lojo@cyberphysical.us", "pw");
  const ada = await generateTestKey("ada@example.com", "pw");
  const w = await memoryWorld({ deps: { ownPgpPublicKey: jon.publicKey, pgpSigningKey: { armoredKey: jon.privateKey, passphrase: "pw" } } });
  await w.store.putContact({ email: "ada@example.com", pgpPublicKey: ada.publicKey });
  const draft = await w.mailbox.createDraft({ to: ["ada@example.com"], subject: "plans", text: "secret plan attached", origin: "human" });
  await w.mailbox.addDraftAttachment(draft.id, upload(PHOTO, "plan.jpg"), "human");
  const result = await send(w, draft.id);
  assert.equal(result.encryption, "pgp-mime");
  assert.ok((await w.store.listAudit()).some((event) => event.action === "send.approved" && event.detail?.endsWith("encryption:pgp-mime")));

  const out = w.sender.sent[0];
  assert.ok(out?.pgpMime);
  assert.equal(out.armored, undefined);
  const raw = buildRawMessage(out);
  assert.match(raw, /Content-Type: multipart\/encrypted; protocol="application\/pgp-encrypted"; boundary=/);
  assert.equal(raw.includes(Buffer.from(PHOTO).toString("base64").slice(0, 20)), false, "the file is not in the clear");
  assert.equal(raw.includes("plan.jpg"), false, "nor is its name");
  assert.equal(raw.includes(Buffer.from("secret plan").toString("base64").slice(0, 12)), false);

  const outer = await simpleParser(Buffer.from(raw));
  const armored = outer.attachments.find((item) => item.contentType === "application/octet-stream")?.content.toString("utf8");
  assert.ok(armored?.startsWith("-----BEGIN PGP MESSAGE-----"));
  for (const key of [ada, jon]) {
    const privateKey = await openpgp.decryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: key.privateKey }), passphrase: "pw" });
    const decrypted = await openpgp.decrypt({
      message: await openpgp.readMessage({ armoredMessage: armored }),
      decryptionKeys: privateKey,
      verificationKeys: await openpgp.readKey({ armoredKey: jon.publicKey }),
      format: "binary",
    });
    await decrypted.signatures[0]?.verified;
    const inner = await simpleParser(Buffer.from(decrypted.data as Uint8Array));
    assert.equal(inner.text?.trim(), "secret plan attached");
    assert.equal(inner.attachments[0]?.filename, "plan.jpg");
    assert.equal(sha256(new Uint8Array(inner.attachments[0]?.content ?? [])), sha256(PHOTO));
  }
  const copy = (await w.store.listMessages({ folder: "sent" }))[0];
  assert.equal(copy?.attachments[0]?.filename, "plan.jpg", "Jon's copy keeps the file, sealed to his envelope key");
});

test("long and non-ASCII filenames use RFC 2231 continuations that mail parsers read back", async () => {
  const name = `${"Überweisung – Kontoauszug ".repeat(4)}.pdf`;
  const param = mimeParameter("filename", name);
  assert.ok(param.split("\r\n").every((line) => line.length < 100));
  assert.match(param, /^filename\*0\*=UTF-8''/);
  assert.equal(mimeParameter("filename", "plain.txt"), 'filename="plain.txt"');
  const raw = buildRawMessage({
    from: { email: "lojo@cyberphysical.us" },
    to: [{ email: "a@example.com" }],
    cc: [],
    subject: "s",
    text: "t",
    attachments: [{ filename: name, contentType: "application/pdf", data: PHOTO }],
  });
  const parsed = await simpleParser(Buffer.from(raw));
  assert.equal(parsed.attachments[0]?.filename, name);
});

test("filenames are cleaned like the iOS app cleans them, and the size estimate matches its budget", () => {
  assert.equal(cleanAttachmentFilename("C:\\Users\\jon\\a.txt"), "a.txt");
  assert.equal(cleanAttachmentFilename(".."), "attachment");
  assert.equal(cleanAttachmentFilename("   "), "attachment");
  assert.equal(cleanAttachmentFilename("x".repeat(200)).length, 120);
  assert.equal(encodedSize(0), 0);
  assert.equal(encodedSize(57), 78);
  assert.equal(encodedSize(58), 84);
  assert.equal(estimatedMessageBytes(100, [1000]), 2048 + 100 + 10 + encodedSize(1000) + 512);
  assert.equal(DRAFT_ATTACHMENT_LIMITS.maxMessageBytes, DEFAULT_CLIENT_SEND_LIMITS.maxBytes, "the app and Thunderbird share one limit");
});
