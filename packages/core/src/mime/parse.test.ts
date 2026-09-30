import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isBulk } from "./bulk.ts";
import { htmlToText } from "./html.ts";
import { parseMime } from "./parse.ts";
import { heuristicPhishing } from "./phishing.ts";
import { assignThreadIds } from "./thread.ts";

function fixture(name: string): Buffer {
  return readFileSync(new URL(`../../../../fixtures/emails/${name}`, import.meta.url));
}

test("parses a personal message, html, attachments, and armored pgp", async () => {
  const personal = await parseMime(fixture("personal.eml"));
  assert.equal(personal.rfcMessageId, "lease-1@example.com");
  assert.equal(personal.from.email, "mina@example.com");
  assert.match(personal.text, /CODEWORD-ZEBRA/);
  assert.equal(personal.pgpEncrypted, false);

  const html = await parseMime(fixture("html-only.eml"));
  assert.match(html.text, /4412/);
  assert.equal(html.text.includes("<b>"), false);

  const attachment = await parseMime(fixture("attachment.eml"));
  assert.equal(attachment.attachments.length, 1);
  assert.equal(attachment.attachments[0]?.filename, "note.txt");
  assert.equal(Buffer.from(attachment.attachments[0]?.bytes ?? []).toString("utf8").trim(), "hello attachment");

  const pgp = await parseMime(fixture("pgp.eml"));
  assert.equal(pgp.pgpEncrypted, true);
});

test("htmlToText drops tags and scripts", () => {
  const text = htmlToText("<style>p{}</style><script>alert(1)</script><p>Hello&nbsp;there</p>");
  assert.equal(text.includes("alert"), false);
  assert.match(text, /Hello there/);
});

test("bulk mail is detected from list headers", async () => {
  const newsletter = await parseMime(fixture("newsletter.eml"));
  assert.equal(isBulk(newsletter), true);
  const personal = await parseMime(fixture("personal.eml"));
  assert.equal(isBulk(personal), false);
});

test("phishing heuristics flag mismatched reply-to and urgent language", async () => {
  const phish = await parseMime(fixture("phish.eml"));
  const signal = heuristicPhishing(phish);
  assert.ok(signal.score >= 50);
  assert.ok(signal.reasons.some((reason) => /Reply-To/.test(reason)));
  assert.ok(signal.reasons.some((reason) => /Urgent/.test(reason)));
});

test("thread assignment joins a reply to its parent", async () => {
  const personal = await parseMime(fixture("personal.eml"));
  const reply = await parseMime(fixture("reply.eml"));
  const ids = assignThreadIds([
    { rfcMessageId: personal.rfcMessageId, references: personal.references, inReplyTo: personal.inReplyTo },
    { rfcMessageId: reply.rfcMessageId, references: reply.references, inReplyTo: reply.inReplyTo },
  ]);
  assert.equal(ids.get(personal.rfcMessageId), ids.get(reply.rfcMessageId));
});

test("List-Id and List-Unsubscribe are read even though mailparser folds them into one `list` value", async () => {
  const parsed = await parseMime(fixture("newsletter.eml"));
  assert.equal(parsed.listId, "<notes.northwind.example>");
  assert.equal(parsed.listUnsubscribe, "<https://northwind.example/unsub>");
  const withoutPrecedence = await parseMime(fixture("newsletter.eml").toString().replace("Precedence: bulk\n", ""));
  assert.equal(isBulk(withoutPrecedence), true);
});
