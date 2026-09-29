import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { analyzeMessage } from "./ai/pipeline.ts";
import { MockLlm } from "./ai/providers.ts";
import type { LlmRequest } from "./ai/types.ts";
import { decodeEnvelope, encodeEnvelope, messageBodyContext, openJson } from "./crypto/envelope.ts";
import { buildRawMessage } from "./mime/compose.ts";
import { parseMime } from "./mime/parse.ts";
import { decryptText, generateTestKey } from "./openpgp/mail.ts";
import { DYNAMO_ITEM_LIMIT_BYTES } from "./store/memory-dynamo.ts";
import { fixture, malicious, memoryWorld } from "./testing.ts";
import type { SealedBody } from "./types.ts";

/** A worst-case model that obeys instructions embedded in the email. */
function obedientLlm(): MockLlm {
  return new MockLlm((request: LlmRequest) => {
    const body = {
      summary: "Routine note, no action needed.",
      category: "personal",
      priority: "now",
      actionItems: [],
      labels: ["family", "trusted"],
      phishingScore: 0,
      phishingReasons: [],
      unsubscribe: { detected: true, url: "javascript:alert(document.cookie)", mailto: null },
      threadSummary: request.user.slice(0, 400),
      draftReply: "Sure, here it is: https://paypa1-secure.example/verify",
    };
    return { text: JSON.stringify(body), inputTokens: 100, outputTokens: 100 };
  });
}

async function approveAndSend(w: Awaited<ReturnType<typeof memoryWorld>>, draftId: string) {
  const { approvalToken } = await w.mailbox.mintApproval(draftId, "human");
  return w.mailbox.approveAndSend(draftId, approvalToken);
}

test("[control] inbound pipeline: an obedient model still cannot send, delete, or retarget a draft", async () => {
  const w = await memoryWorld({ llm: obedientLlm() });
  await w.ingest(fixture("personal.eml"));
  for (const name of ["01-agent-exfil.eml", "02-triage-manipulation.eml"]) await w.ingest(malicious(name));
  assert.equal(w.sender.sent.length, 0, "ingest must never send");
  const messages = await w.store.listMessages({ limit: 100 });
  assert.ok(messages.every((m) => m.folder !== "trash"), "ingest must never trash");
  for (const draft of await w.store.listDrafts()) {
    assert.equal(draft.status, "suggested");
    assert.ok(!draft.to.some((a) => a.email === "archive@attacker.example"), "draft recipients come from headers, not the model");
  }
  const phish = messages.find((m) => m.subject === "Your account is suspended");
  assert.ok((phish?.ai?.phishingScore ?? 0) >= 35, "heuristic floor survives a model that says 0");
});

test("[P1-10] inbound pipeline: a phish cannot talk its way into triage or onto a reassurance label", async () => {
  const w = await memoryWorld({ llm: obedientLlm() });
  const { message } = await w.ingest(malicious("02-triage-manipulation.eml"));
  assert.ok((message.ai?.phishingScore ?? 0) >= 40, `score ${message.ai?.phishingScore}`);
  assert.equal(message.ai?.priority, "later", "a high phishing score demotes the model's 'now'");
  assert.ok(!message.labels.includes("trusted") && !(message.ai?.labels ?? []).includes("trusted"));
  const triage = await w.mailbox.triage();
  assert.ok(!triage.some((view) => view.subject === "Your account is suspended"), "phish is excluded from triage");
  assert.equal((await w.store.listDrafts()).length, 0, "no suggested reply to a phish");
});

test("[P0-5] production mailbox (no private key): draft-reply works from the AI-context copy or browser text", async () => {
  const w = await memoryWorld({ unlocked: false });
  const { message } = await w.ingest(fixture("personal.eml"));
  const draft = await w.mailbox.draftReply(message.id);
  assert.equal(draft.to[0]?.email, "mina@example.com");
  assert.match(await w.mailbox.readDraftText(draft), /Thanks for the note/);

  const noContext = await memoryWorld({ unlocked: false, config: { aiContextDays: 0 } });
  const second = await noContext.ingest(fixture("personal.eml"), {}, null);
  await assert.rejects(() => noContext.mailbox.draftReply(second.message.id), /No server-readable text/);
  const fromBrowser = await noContext.mailbox.draftReply(second.message.id, { sourceText: "Please send the lease." });
  assert.equal(fromBrowser.status, "suggested");
});

test("[P1-2] a forged From: lojo@ lands in the inbox, unread, labelled unverified-self", async () => {
  const w = await memoryWorld({ llm: null });
  const { message } = await w.ingest(malicious("03-spoofed-self.eml"));
  assert.equal(message.folder, "inbox", "inbound mail must not be filed as sent based on a forgeable header");
  assert.equal(message.unread, true);
  assert.ok(message.labels.includes("unverified-self"));
});

test("[P1-2] SES verdicts: a DMARC fail from our own domain is quarantined to spam", async () => {
  const w = await memoryWorld({ llm: null });
  const raw = Buffer.concat([
    Buffer.from("X-SES-Spam-Verdict: PASS\r\nX-SES-Virus-Verdict: PASS\r\nAuthentication-Results: amazonses.com; spf=fail; dkim=fail; dmarc=fail header.from=cyberphysical.us\r\n"),
    malicious("03-spoofed-self.eml"),
  ]);
  const { message } = await w.ingest(raw);
  assert.equal(message.folder, "spam");
  assert.ok(message.labels.includes("quarantined"));
  assert.equal(message.verdicts?.dmarc, "fail");
  assert.equal(message.ai?.skipReason, "quarantined");
});

test("[P1-3] Message-ID squatting does not drop the legitimate message", async () => {
  const w = await memoryWorld({ llm: null });
  await w.ingest(malicious("04-message-id-squat.eml"), { deliveryId: "raw/squat" });
  const real = await w.ingest(fixture("personal.eml"), { deliveryId: "raw/real" });
  assert.equal(real.duplicate, false, "a different delivery with the same Message-ID is not a duplicate");
  assert.equal((await w.store.getMessagesByRfcId("lease-1@example.com")).length, 2);
});

test("[P2] References-based thread hijack: an unrelated sender does not join Jon's thread", async () => {
  const w = await memoryWorld({ llm: null });
  const legit = await w.ingest(fixture("personal.eml"));
  const hijack = await w.ingest(malicious("05-thread-hijack.eml"));
  assert.notEqual(hijack.message.threadId, legit.message.threadId);
  const own = await w.ingest(fixture("reply.eml"), { origin: "sent" });
  assert.equal(own.message.threadId, legit.message.threadId, "Jon's own reply still threads");
});

test("[P2] RFC 2047 subject cannot carry CR/LF into outbound raw headers", async () => {
  const parsed = await parseMime(malicious("06-subject-crlf.eml"));
  const raw = buildRawMessage({
    from: { email: "lojo@cyberphysical.us" },
    to: [{ email: "mina@example.com", name: "Mina\r\nBcc: spy@attacker.example" }],
    cc: [],
    subject: `Re: ${parsed.subject}`,
    text: "x",
  });
  assert.doesNotMatch(raw, /\r\nBcc:/i);
  assert.doesNotMatch(raw, /\r\nX-Injected:/i);
  assert.throws(() =>
    buildRawMessage({ from: { email: "lojo@cyberphysical.us" }, to: [{ email: "a@b.example\r\nBcc: c@d.example" }], cc: [], subject: "s", text: "t" }),
  );
});

test("[P2] Reply-To mismatch heuristic fires", async () => {
  const parsed = await parseMime(fixture("phish.eml"));
  assert.ok(parsed.replyTo);
  const out = await analyzeMessage(new MockLlm(), {
    subject: parsed.subject,
    from: parsed.from,
    replyTo: parsed.replyTo,
    to: "lojo@cyberphysical.us",
    text: parsed.text,
    threadContext: "",
    styleGuide: "",
    maxBodyChars: 8000,
  });
  assert.ok(out.sensitive.phishingReasons.includes("Reply-To domain differs from From domain"), JSON.stringify(out.sensitive.phishingReasons));
});

test("[P0-2] a 300 KB attachment goes to S3 and the DynamoDB item stays small", async () => {
  const w = await memoryWorld({ llm: null });
  const bytes = Buffer.alloc(300 * 1024, 7).toString("base64").replace(/.{76}/g, "$&\r\n");
  const raw = [
    "From: Sable <sable@example.com>",
    "To: lojo@cyberphysical.us",
    "Subject: scan",
    "Message-ID: <big-1@example.com>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain",
    "",
    "see attached",
    "--b",
    'Content-Type: application/pdf; name="scan.pdf"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="scan.pdf"',
    "",
    bytes,
    "--b--",
    "",
  ].join("\r\n");
  const { message } = await w.ingest(raw);
  const itemBytes = w.store.memory.itemSize("messages", { id: message.id });
  assert.ok(itemBytes > 0 && itemBytes < 16 * 1024, `message item is ${itemBytes} bytes`);
  assert.equal(message.attachments[0]?.blobKey, `objects/${message.id}/att1.bin`);
  const payload = await w.mailbox.attachment(message.id, "att1");
  assert.equal(payload.bytes?.byteLength, 300 * 1024);
});

test("[P0-2] MemoryDynamo enforces the 400 KB item limit like DynamoDB", async () => {
  const w = await memoryWorld();
  await assert.rejects(
    () => w.store.memory.put("lojo-mail-audit", { day: "2026-09-29", id: "big", detail: "x".repeat(DYNAMO_ITEM_LIMIT_BYTES) }),
    /maximum allowed size/,
  );
});

test("[P1-3] redelivery is recognised after more than one page of messages", async () => {
  const w = await memoryWorld({ llm: null });
  const mk = (i: number) =>
    `From: a${i}@example.com\r\nTo: lojo@cyberphysical.us\r\nSubject: n${i}\r\nMessage-ID: <n${i}@example.com>\r\nDate: Tue, 1 Sep 2026 00:00:00 +0000\r\n\r\nbody ${i}\r\n`;
  for (let i = 0; i < 501; i += 1) await w.ingest(mk(i), { deliveryId: `raw/${i}` });
  const again = await w.ingest(mk(500), { deliveryId: "raw/500" });
  assert.equal(again.duplicate, true);
});

test("[control] audit.detail does not carry model output or body fragments when JSON parsing fails", async () => {
  const w = await memoryWorld({
    llm: new MockLlm(() => ({ text: '{ "summary": "Mina says the codeword is CODEWORD-ZEBRA", oops }', inputTokens: 1, outputTokens: 1 })),
  });
  await w.ingest(fixture("personal.eml"));
  assert.doesNotMatch(JSON.stringify(await w.store.listAudit()), /CODEWORD-ZEBRA/);
});

test("[control] envelope: body is not in the stored item, tampering fails, fresh ephemeral key per message", async () => {
  const w = await memoryWorld({ llm: null });
  const a = await w.ingest(fixture("personal.eml"));
  const b = await w.ingest(fixture("attachment.eml"));
  assert.doesNotMatch(JSON.stringify(a.message), /CODEWORD-ZEBRA/);
  const ea = decodeEnvelope((await w.blobs.get(a.message.bodyKey)) ?? new Uint8Array());
  const eb = decodeEnvelope((await w.blobs.get(b.message.bodyKey)) ?? new Uint8Array());
  assert.notEqual(ea.epk.x, eb.epk.x);
  const bad = { ...ea, ct: ea.ct.replace(/^./, (c) => (c === "A" ? "B" : "A")) };
  await assert.rejects(() => openJson(bad, w.privateJwk, messageBodyContext(a.message.id)));
});

test("[P2] envelope is bound to its message: swapping bodies between messages is detected", async () => {
  const w = await memoryWorld({ llm: null });
  const a = await w.ingest(fixture("personal.eml"));
  const b = await w.ingest(fixture("attachment.eml"));
  const stolen = (await w.blobs.get(a.message.bodyKey)) ?? new Uint8Array();
  await w.blobs.put(b.message.bodyKey, stolen);
  await assert.rejects(() => w.mailbox.openMessage(b.message));
  await assert.rejects(() => openJson<SealedBody>(decodeEnvelope(encodeEnvelope(decodeEnvelope(stolen))), w.privateJwk, messageBodyContext(b.message.id)));
});

test("[P1-5] OpenPGP send: every recipient and Jon can decrypt, and the message is signed", async () => {
  const jon = await generateTestKey("lojo@cyberphysical.us", "pw");
  const ada = await generateTestKey("ada@example.com", "pw");
  const bob = await generateTestKey("bob@example.com", "pw");
  const w = await memoryWorld();
  const signed = await memoryWorld({
    deps: { ownPgpPublicKey: jon.publicKey, pgpSigningKey: { armoredKey: jon.privateKey, passphrase: "pw" } },
  });
  for (const world of [w, signed]) {
    await world.store.putContact({ email: "ada@example.com", pgpPublicKey: ada.publicKey });
    await world.store.putContact({ email: "bob@example.com", pgpPublicKey: bob.publicKey });
  }
  const draft = await signed.mailbox.createDraft({ to: ["ada@example.com", "bob@example.com"], subject: "s", text: "secret plan" });
  await approveAndSend(signed, draft.id);
  const out = signed.sender.sent[0];
  assert.ok(out?.armored);
  for (const key of [ada, bob, jon]) {
    const opened = await decryptText(out.armored, key.privateKey, "pw", jon.publicKey);
    assert.equal(opened.text, "secret plan");
    assert.equal(opened.signed, true);
  }
  const sentCopy = (await signed.store.listMessages({ folder: "sent" }))[0];
  assert.ok(sentCopy);
  assert.equal(sentCopy.origin, "sent");

  await w.store.putContact({ email: "carol@example.com" });
  const partial = await w.mailbox.createDraft({ to: ["ada@example.com", "carol@example.com"], subject: "s", text: "t" });
  const { approvalToken } = await w.mailbox.mintApproval(partial.id, "human");
  await assert.rejects(() => w.mailbox.approveAndSend(partial.id, approvalToken), /No OpenPGP key for carol@example.com/);
  assert.equal(w.sender.sent.length, 0);
});

test("[P2] Draft reply on a thread whose latest message is Jon's own reply targets the other party", async () => {
  const w = await memoryWorld();
  await w.ingest(fixture("personal.eml"));
  const { message: latest } = await w.ingest(fixture("reply.eml"), { origin: "sent" });
  const suggested = (await w.store.listDrafts())[0];
  const draft = await w.mailbox.draftReply(latest.id);
  assert.notEqual(draft.to[0]?.email, w.config.mailbox);
  assert.equal(draft.id, suggested?.id, "reuses the open suggested draft instead of making another");
});

test("[P2] ingest creates no suggested draft for Jon's own sent copy", async () => {
  const w = await memoryWorld();
  await w.ingest(fixture("reply.eml"), { origin: "sent" });
  await w.ingest(malicious("03-spoofed-self.eml"));
  const drafts = await w.store.listDrafts();
  assert.ok(!drafts.some((d) => d.to.some((a) => a.email === w.config.mailbox)));
});

test("[P2] DMARC aggregate reports skip the model and go to archive", async () => {
  const w = await memoryWorld();
  const raw = [
    "From: noreply-dmarc-support@google.com",
    "To: dmarc@cyberphysical.us",
    "Subject: Report domain: cyberphysical.us",
    "Message-ID: <dmarc-1@google.com>",
    "",
    "report",
    "",
  ].join("\r\n");
  const { message } = await w.ingest(raw);
  assert.equal(message.folder, "archive");
  assert.ok(message.labels.includes("dmarc-report"));
  assert.equal(message.ai?.skipReason, "dmarc-report");
  assert.equal(w.llm?.calls.length, 0);
});

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx|mjs)$/.test(entry) && !entry.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

test("[P0-2] no package source uses DynamoDB Scan", () => {
  const packages = new URL("../../", import.meta.url).pathname;
  const offenders = readdirSync(packages)
    .flatMap((name) => {
      try {
        return sourceFiles(join(packages, name, "src"));
      } catch {
        return [];
      }
    })
    .filter((path) => /ScanCommand|\.scan\(/.test(readFileSync(path, "utf8")));
  assert.deepEqual(offenders, []);
});
