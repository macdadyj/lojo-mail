import { test } from "node:test";
import assert from "node:assert/strict";
import { authorNotice, changedFields, type Fields } from "./review.ts";

const REVIEWED: Fields = { to: "ada@example.com", cc: "", bcc: "", subject: "Lunch", text: "Thursday works.", pgp: "auto", files: "" };

test("[P2] approval conflict: names every field that changed under Jon", () => {
  const current: Fields = { ...REVIEWED, to: "ada@example.com, attacker@evil.test", text: "Thursday works. Also, the files.", pgp: "off" };
  assert.deepEqual(changedFields(REVIEWED, current), ["recipients (To)", "message text", "encryption"]);
});

test("approval conflict: a file added or swapped under Jon is named", () => {
  assert.deepEqual(changedFields({ ...REVIEWED, files: "aa" }, { ...REVIEWED, files: "aa,bb" }), ["attached files"]);
});

test("approval conflict: address case and spacing are not changes, matching the server", () => {
  assert.deepEqual(changedFields(REVIEWED, { ...REVIEWED, to: " Ada@Example.com " }), []);
});

test("[P2] approval conflict: the assistant notice depends on who wrote the draft, not its status", () => {
  for (const status of ["suggested", "edited", "pending_approval"] as const) {
    assert.match(authorNotice({ origin: "agent", status }) ?? "", /^An assistant wrote this draft/);
    assert.match(authorNotice({ origin: "ai", status }) ?? "", /^The AI wrote this draft/);
    assert.equal(authorNotice({ origin: "human", status }), null);
  }
  assert.match(authorNotice({ origin: "agent", status: "pending_approval" }) ?? "", /waiting for your approval/);
});

test("[P2] approval conflict: an assistant's edit to Jon's own draft is announced", () => {
  assert.equal(
    authorNotice({ origin: "human", lastEditedBy: "agent", status: "edited" }),
    "An assistant last changed this draft. Check the recipients and the text before you send.",
  );
  assert.equal(authorNotice({ origin: "human", lastEditedBy: "human", status: "edited" }), null);
  assert.match(authorNotice({ origin: "ai", lastEditedBy: "agent", status: "edited" }) ?? "", /^The AI wrote this draft, and an assistant last changed it\./);
});
