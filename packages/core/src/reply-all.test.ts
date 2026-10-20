import assert from "node:assert/strict";
import test from "node:test";
import { memoryWorld } from "./testing.ts";

const GATE = `From: Ada <Ada@Example.com>
To: lojo@cyberphysical.us, bea@example.com, ada@example.com
Cc: copy@example.com, Bea@Example.com, jon@example.com
Subject: Gate sensor
Date: Wed, 15 Oct 2026 14:05:00 +0000
Message-ID: <gate-2@example.com>
References: <gate-1@example.com> <gate-2@example.com>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

The north gate is back online.
`;

const SENT = `From: lojo@cyberphysical.us
To: ada@example.com, lojo@cyberphysical.us
Cc: copy@example.com
Subject: Hello
Date: Wed, 15 Oct 2026 15:00:00 +0000
Message-ID: <sent-1@example.com>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

Sent earlier.
`;

async function world() {
  return memoryWorld({
    config: { sendFrom: ["lojo@cyberphysical.us", "jon@example.com"] },
  });
}

test("reply all puts the sender and To on To, and Cc on Cc, without Jon or duplicates", async () => {
  const w = await world();
  const { message } = await w.ingest(GATE);
  const single = await w.mailbox.siReply({ messageId: message.id, tone: "brief" });
  assert.deepEqual(single.to.map((item) => item.email), ["Ada@Example.com"]);
  assert.deepEqual(single.cc, []);
  assert.equal(w.sender.sent.length, 0);

  const all = await w.mailbox.siReply({ messageId: message.id, replyAll: true });
  assert.equal(all.id, single.id);
  assert.deepEqual(
    all.to.map((item) => item.email),
    ["Ada@Example.com", "bea@example.com"],
  );
  assert.deepEqual(
    all.cc.map((item) => item.email),
    ["copy@example.com"],
  );
  assert.equal(all.subject, "Re: Gate sensor");
  assert.equal(all.inReplyTo, message.rfcMessageId);
  assert.deepEqual(all.references, [...new Set([...message.references, message.rfcMessageId])]);
  assert.ok(all.references?.includes(message.rfcMessageId));
  assert.equal(all.status, "suggested");
  assert.equal(w.sender.sent.length, 0);

  const again = await w.mailbox.siReply({ messageId: message.id });
  assert.equal(again.id, all.id);
  assert.deepEqual(
    again.to.map((item) => item.email),
    ["Ada@Example.com", "bea@example.com"],
  );
});

test("reply all on sent mail skips the sender and keeps the original lists", async () => {
  const w = await world();
  const { message } = await w.ingest(SENT, { origin: "sent" });
  const draft = await w.mailbox.siReply({ messageId: message.id, replyAll: true, sourceText: "Sent earlier." });
  assert.deepEqual(
    draft.to.map((item) => item.email),
    ["ada@example.com"],
  );
  assert.deepEqual(
    draft.cc.map((item) => item.email),
    ["copy@example.com"],
  );
  assert.equal(draft.subject, "Re: Hello");
  assert.equal(w.sender.sent.length, 0);
});
