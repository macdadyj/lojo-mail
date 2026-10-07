import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRules } from "../rules/match.ts";
import { emptyRules } from "../rules/validate.ts";
import type { RulesDocument } from "../rules/types.ts";
import { heuristicProposals, parseSiModelOutput, sanitizeActions, type SiMailRef } from "./parse.ts";
import { replySystem } from "./prompt.ts";
import { siReplyPrompt } from "./run.ts";

const message: SiMailRef = {
  id: "msg_1",
  from: "news@northwind.example",
  domain: "northwind.example",
  subject: "September notes",
  snippet: "A monthly roundup",
  text: "Unsubscribe at the link.",
  category: "newsletter",
  labels: [],
  bulk: true,
  phishingScore: 0,
};

test("a permanent delete from SI is rewritten to Trash", () => {
  const [proposal] = parseSiModelOutput(
    JSON.stringify({
      items: [{ messageId: "msg_1", reason: "drop it", actions: [{ type: "delete" }, { type: "hardDelete" }, { type: "purge" }], saveRule: true }],
    }),
    [message],
  );
  assert.ok(proposal);
  assert.deepEqual(proposal.actions, [{ type: "trash" }]);
  assert.equal(JSON.stringify(proposal.actions).includes("delete"), false);
});

test("unknown actions are dropped and invented message ids are ignored", () => {
  const [proposal] = parseSiModelOutput(
    JSON.stringify({
      items: [
        { messageId: "msg_nope", reason: "no", actions: [{ type: "trash" }] },
        { messageId: "msg_1", reason: "file", actions: [{ type: "label", labels: ["Receipts"] }, { type: "send" }, { type: "reply" }] },
      ],
    }),
    [message],
  );
  assert.equal(proposal?.messageId, "msg_1");
  assert.deepEqual(proposal?.actions, [{ type: "label", labels: ["receipts"] }]);
});

test("trash wins over junk, and the heuristic files newsletters", () => {
  const actions = sanitizeActions([{ type: "spam" }, { type: "trash" }, { type: "label", labels: ["newsletters"] }], message);
  assert.deepEqual(actions.map((action) => action.type), ["label", "trash"]);
  const [guess] = heuristicProposals([message]);
  assert.deepEqual(guess?.actions, [{ type: "label", labels: ["newsletters"] }]);
});

test("the reply prompt never asks SI to send", () => {
  const prompt = siReplyPrompt({
    tone: "brief",
    instruction: "say yes, propose Tuesday",
    from: "mina@example.com",
    subject: "Lease",
    sourceText: "Can we meet?",
    threadText: "Earlier note",
  });
  assert.match(prompt.system, /Do not send/);
  assert.match(prompt.system, /say yes, propose Tuesday/);
  assert.match(prompt.system, /Two or three short sentences/);
  assert.match(prompt.user, /untrusted-mail/);
  assert.equal(replySystem("formal", "").includes("Do not send"), true);
});

test("the SI kill switch skips SI rules and leaves other rules running", () => {
  const doc: RulesDocument = {
    ...emptyRules(new Date("2026-10-07T00:00:00Z")),
    siKillSwitch: true,
    rules: [
      {
        id: "si-file-news",
        name: "SI file",
        enabled: true,
        match: { from: ["news@northwind.example"] },
        actions: [{ type: "label", labels: ["newsletters"] }],
        stop: false,
        createdBy: "human",
        updatedAt: "2026-10-07T00:00:00Z",
      },
      {
        id: "keep",
        name: "Keep",
        enabled: true,
        match: { from: ["news@northwind.example"] },
        actions: [{ type: "markRead" }],
        stop: false,
        createdBy: "human",
        updatedAt: "2026-10-07T00:00:00Z",
      },
    ],
  };
  const hit = evaluateRules(doc, {
    from: { email: "news@northwind.example" },
    to: [],
    cc: [],
    subject: "Notes",
    ai: null,
    bulk: true,
    attachments: [],
    labels: [],
  });
  assert.deepEqual(hit.labels, []);
  assert.equal(hit.markRead, true);
  assert.deepEqual(
    hit.hits.map((item) => item.ruleId),
    ["keep"],
  );
});
