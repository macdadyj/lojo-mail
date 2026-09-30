import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fixture } from "@lojo/core/testing";
import { createTransport } from "nodemailer";
import { APP_PASSWORD, harness, type Harness } from "./testkit.ts";

describe("SMTP submission", () => {
  let h: Harness;

  before(async () => {
    h = await harness();
  });

  after(async () => {
    await h.close();
  });

  const transport = (auth: { user: string; pass: string } | null = { user: h.address, pass: APP_PASSWORD }) =>
    createTransport({
      host: "127.0.0.1",
      port: h.bridge.smtpPort,
      secure: false,
      ignoreTLS: true,
      ...(auth ? { auth } : {}),
    });

  it("turns a submission into a client draft pending approval and sends nothing", async () => {
    const info = await transport().sendMail({ from: h.address, to: "stranger@example.org", cc: "other@example.net", subject: "Hello from Thunderbird", text: "Body text here" });
    assert.match(info.response, /approval/);
    const drafts = await h.t.store.listDrafts();
    assert.equal(drafts.length, 1);
    const draft = drafts[0];
    assert.equal(draft?.origin, "client");
    assert.equal(draft?.status, "pending_approval");
    assert.deepEqual(draft?.to.map((item) => item.email), ["stranger@example.org"]);
    assert.deepEqual(draft?.cc.map((item) => item.email), ["other@example.net"]);
    assert.equal(draft?.subject, "Hello from Thunderbird");
    assert.equal(draft?.approvalTokenHash, undefined);
    assert.match(info.response, new RegExp(draft?.id ?? "missing"));
    const view = await h.t.mailbox.getDraft(draft?.id ?? "", { withText: true });
    assert.equal(view.text, "Body text here");
    assert.equal(h.t.sender.sent.length, 0);
  });

  it("threads a reply through In-Reply-To", async () => {
    const parent = (await h.t.ingest(fixture("personal.eml"))).message;
    await transport().sendMail({
      from: h.address,
      to: "mina@example.com",
      subject: "Re: Lease renewal by Friday",
      text: "Signed copy attached tomorrow.",
      inReplyTo: "<lease-1@example.com>",
      references: ["<lease-1@example.com>"],
    });
    const draft = (await h.t.store.listDrafts()).find((item) => item.origin === "client" && item.subject === "Re: Lease renewal by Friday");
    assert.equal(draft?.threadId, parent.threadId);
    assert.equal(draft?.inReplyTo, "lease-1@example.com");
    assert.equal(h.t.sender.sent.length, 0);
  });

  it("converts an HTML-only message to text", async () => {
    await transport().sendMail({ from: h.address, to: "stranger@example.org", subject: "html only", html: "<p>Hello <b>there</b></p>" });
    const draft = (await h.t.store.listDrafts()).find((item) => item.subject === "html only");
    const view = await h.t.mailbox.getDraft(draft?.id ?? "", { withText: true });
    assert.match(view.text ?? "", /Hello\s+there/);
  });

  it("rejects a sender that is not the mailbox", async () => {
    await assert.rejects(() => transport().sendMail({ from: "someone@example.com", to: "stranger@example.org", subject: "x", text: "x" }), /550/);
    await assert.rejects(
      () => transport().sendMail({ from: "someone@example.com", to: "stranger@example.org", subject: "x", text: "x", envelope: { from: h.address, to: ["stranger@example.org"] } }),
      /From header/,
    );
  });

  it("rejects Bcc", async () => {
    await assert.rejects(() => transport().sendMail({ from: h.address, to: "stranger@example.org", bcc: "hidden@example.org", subject: "x", text: "x" }), /Bcc is not supported/);
  });

  it("rejects attachments", async () => {
    await assert.rejects(
      () => transport().sendMail({ from: h.address, to: "stranger@example.org", subject: "x", text: "x", attachments: [{ filename: "a.txt", content: "hello" }] }),
      /Attachments/,
    );
  });

  it("requires authentication with the app password", async () => {
    await assert.rejects(() => transport(null).sendMail({ from: h.address, to: "stranger@example.org", subject: "x", text: "x" }), /530|auth/i);
    await assert.rejects(() => transport({ user: h.address, pass: "wrong" }).sendMail({ from: h.address, to: "stranger@example.org", subject: "x", text: "x" }), /535|Invalid/);
  });

  it("created drafts only for the accepted submissions", async () => {
    const subjects = (await h.t.store.listDrafts())
      .filter((draft) => draft.origin === "client")
      .map((draft) => draft.subject)
      .sort();
    assert.deepEqual(subjects, ["Hello from Thunderbird", "Re: Lease renewal by Friday", "html only"]);
    assert.equal(h.t.sender.sent.length, 0);
  });
});
