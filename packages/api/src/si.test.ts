import assert from "node:assert/strict";
import test from "node:test";
import { MockLlm } from "@lojo/core";
import { fixture } from "@lojo/core/testing";
import { testApp } from "./test-app.ts";

const NEWS = () => fixture("newsletter.eml");
const PERSONAL = () => fixture("personal.eml");

function laterFromNorthwind(): string {
  return [
    "From: Northwind Notes <news@northwind.example>",
    "To: lojo@cyberphysical.us",
    "Subject: October notes",
    "Date: Tue, 06 Oct 2026 12:00:00 +0000",
    "Message-ID: <news-oct@northwind.example>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Another monthly roundup. Unsubscribe if you like.",
    "",
  ].join("\r\n");
}

test("filter proposes, apply moves to recoverable Trash, and undo puts it back", async () => {
  const scripted = new MockLlm((request) => {
    const id = request.user.match(/messageId: (\S+)/)?.[1] ?? "";
    const trash = /lease renewal/i.test(request.user);
    return {
      text: JSON.stringify({
        items: [
          {
            messageId: id,
            reason: trash ? "not needed" : "leave",
            actions: trash ? [{ type: "delete" }] : [],
            saveRule: false,
          },
        ],
      }),
      inputTokens: 12,
      outputTokens: 12,
    };
  });
  const app = await testApp({ llm: scripted });
  const personal = await app.ingest(PERSONAL());
  const session = await app.login();
  let purged = 0;
  const store = app.store;
  const original = store.deleteTrashedMessage.bind(store);
  store.deleteTrashedMessage = async (id, keepUntil) => {
    purged += 1;
    return original(id, keepUntil);
  };

  const proposed = await app.call("/v1/si/filter", {
    token: session,
    body: { messageIds: [personal.message.id], texts: { [personal.message.id]: "Lease renewal by Friday" } },
  });
  assert.equal(proposed.status, 200);
  const proposals = proposed.json.proposals as Array<{ messageId: string; actions: Array<{ type: string }> }>;
  assert.equal(proposals[0]?.actions[0]?.type, "trash");
  assert.equal(JSON.stringify(proposals).includes("delete"), false);

  assert.equal((await app.call("/v1/si/filter/apply", { token: "write-token", body: { items: proposals } })).status, 403);

  const applied = await app.call("/v1/si/filter/apply", { token: session, body: { items: proposals.map((item) => ({ ...item, saveRule: false })) } });
  assert.equal(applied.status, 200);
  const changeId = String(applied.json.changeId);
  assert.equal(applied.json.undo, true);
  const trashed = await app.store.getMessage(personal.message.id);
  assert.equal(trashed?.folder, "trash");
  assert.ok(trashed?.keepUntil, "trash keeps a retention window");
  assert.equal(purged, 0, "SI never hard-deletes");

  const undone = await app.call("/v1/si/filter/undo", { token: session, body: { changeId } });
  assert.equal(undone.status, 200);
  assert.equal((await app.store.getMessage(personal.message.id))?.folder, "inbox");
  assert.equal(purged, 0);
});

test("a block is a trash rule, reversible from the blocked list, and the kill switch stops SI rules", async () => {
  const app = await testApp();
  const news = await app.ingest(NEWS());
  const session = await app.login();
  const proposed = await app.call("/v1/si/filter", {
    token: session,
    body: { messageIds: [news.message.id], texts: { [news.message.id]: "A monthly roundup. Unsubscribe." } },
  });
  assert.equal(proposed.status, 200);
  const proposal = (proposed.json.proposals as Array<{ messageId: string; actions: unknown[]; saveRule: boolean }>)[0];
  assert.ok(proposal);
  const applied = await app.call("/v1/si/filter/apply", {
    token: session,
    body: {
      items: [{ messageId: proposal.messageId, actions: [...(proposal.actions as unknown[]), { type: "blockSender" }], saveRule: true }],
    },
  });
  assert.equal(applied.status, 200);
  assert.ok(Number(applied.json.rules) >= 1);

  const blocked = await app.call("/v1/si/blocked", { token: session });
  const list = blocked.json.blocked as Array<{ ruleId: string; kind: string; value: string }>;
  assert.equal(list.length, 1);
  assert.equal(list[0]?.kind, "sender");
  assert.equal(list[0]?.value, "news@northwind.example");

  const again = await app.ingest(laterFromNorthwind());
  assert.equal(again.message.folder, "trash");
  assert.ok(again.message.keepUntil);
  assert.ok(await app.store.getMessage(again.message.id), "blocked mail is still stored");

  const removed = await app.call("/v1/si/blocked/remove", { token: session, body: { ruleId: list[0]?.ruleId } });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json.blocked, []);
  const undone = await app.call("/v1/si/filter/undo", { token: session, body: { changeId: removed.json.changeId } });
  assert.equal(undone.status, 200);
  const restored = await app.call("/v1/si/blocked", { token: session });
  assert.equal((restored.json.blocked as unknown[]).length, 1);

  assert.equal((await app.call("/v1/rules/switches", { token: "write-token", body: { siKillSwitch: true } })).status, 200);
  assert.equal((await app.call("/v1/rules/switches", { token: "write-token", body: { siKillSwitch: false } })).status, 403);
  const stopped = await app.ingest(
    laterFromNorthwind().replace("news-oct@northwind.example", "news-nov@northwind.example").replace("October notes", "November notes"),
  );
  assert.notEqual(stopped.message.folder, "trash", "the kill switch stops the block rule");
  assert.equal((await app.call("/v1/si/filter/apply", { token: session, body: { items: [{ messageId: news.message.id, actions: [{ type: "label", labels: ["church"] }], saveRule: false }] } })).status, 403);
  assert.equal((await app.call("/v1/rules/switches", { token: session, body: { siKillSwitch: false } })).status, 200);
});

test("reply with SI writes a draft and does not send", async () => {
  const app = await testApp();
  const personal = await app.ingest(PERSONAL());
  const session = await app.login();
  const before = app.sender.sent.length;
  const res = await app.call("/v1/si/reply", {
    token: session,
    body: {
      messageId: personal.message.id,
      tone: "brief",
      instruction: "say yes, propose Tuesday",
      sourceText: "Can we talk about the lease this week?",
      threadText: "",
    },
  });
  assert.equal(res.status, 201);
  const draft = res.json.draft as { status: string; origin: string; pgp: string; sentMessageId?: string };
  assert.equal(draft.status, "suggested");
  assert.equal(draft.origin, "ai");
  assert.equal(draft.pgp, "auto");
  assert.equal(draft.sentMessageId, undefined);
  assert.match(String(res.json.text), /Tuesday/);
  assert.equal(app.sender.sent.length, before, "reply does not send");
  const llm = app.llm;
  assert.ok(llm instanceof MockLlm);
  const call = llm.calls.find((item) => item.system.startsWith("You are SI, writing"));
  assert.ok(call);
  assert.match(call.system, /Do not send/);
  assert.match(call.system, /say yes, propose Tuesday/);
  assert.equal((await app.call(`/v1/drafts/${(res.json.draft as { id: string }).id}/approve-and-send`, { token: session, body: { approvalToken: "apv_nope" } })).status, 403);
});
