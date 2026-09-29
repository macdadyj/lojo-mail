import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { generateIdentity, ingestRaw, loadConfig, Mailbox, MemorySender, MemoryStore, MockLlm } from "@lojo/core";
import { createApp } from "./app.ts";
import { TokenBook } from "./auth.ts";
import { sesInput } from "./ses.ts";

const STYLE = "Sign off with Jon.";

async function testApp() {
  const { publicJwk, privateJwk } = await generateIdentity();
  const store = new MemoryStore();
  const config = loadConfig({ LOJO_LLM_PROVIDER: "mock" });
  const llm = new MockLlm();
  const sender = new MemorySender();
  const mailbox = new Mailbox({ store, config, publicJwk, privateJwk, llm, sender, styleGuide: STYLE });
  const raw = readFileSync(new URL("../../../fixtures/emails/personal.eml", import.meta.url));
  await ingestRaw(raw, { store, publicJwk, llm, config, styleGuide: STYLE });
  const tokens = new TokenBook(false);
  tokens.add("read-token", { label: "read", scopes: ["read"] });
  tokens.add("write-token", { label: "write", scopes: ["read", "write"] });
  tokens.add("send-token", { label: "send", scopes: ["read", "write", "send"] });
  const app = createApp({
    mailbox,
    tokens,
    dev: true,
    info: { mailbox: config.mailbox, domain: config.domain, llmProvider: "mock", dailyTokenBudget: config.dailyTokenBudget },
  });
  return { app, sender, store };
}

test("inbox requires a token and returns the seeded message", async () => {
  const { app } = await testApp();
  const denied = await app.request("/v1/inbox");
  assert.equal(denied.status, 401);
  const ok = await app.request("/v1/inbox", { headers: { authorization: "Bearer read-token" } });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { messages: Array<{ subject: string; text?: string }> };
  assert.equal(body.messages[0]?.subject, "Lease renewal by Friday");
  assert.match(body.messages[0]?.text ?? "", /CODEWORD-ZEBRA/);
});

test("a read token cannot approve or relabel", async () => {
  const { app, store } = await testApp();
  const draft = (await store.listDrafts())[0];
  assert.ok(draft);
  const send = await app.request(`/v1/drafts/${draft.id}/approve-and-send`, {
    method: "POST",
    headers: { authorization: "Bearer read-token" },
  });
  assert.equal(send.status, 403);
  const label = await app.request("/v1/messages/missing/labels", {
    method: "POST",
    headers: { authorization: "Bearer read-token", "content-type": "application/json" },
    body: JSON.stringify({ labels: ["later"] }),
  });
  assert.equal(label.status, 403);
});

test("send token approves a draft and a write token can archive", async () => {
  const { app, sender, store } = await testApp();
  const message = (await store.listMessages({ folder: "inbox" }))[0];
  assert.ok(message);
  const archived = await app.request(`/v1/messages/${message.id}/archive`, {
    method: "POST",
    headers: { authorization: "Bearer write-token" },
  });
  assert.equal(archived.status, 200);
  const draft = (await store.listDrafts())[0];
  assert.ok(draft);
  const sent = await app.request(`/v1/drafts/${draft.id}/approve-and-send`, {
    method: "POST",
    headers: { authorization: "Bearer write-token" },
  });
  assert.equal(sent.status, 403);
  const allowed = await app.request(`/v1/drafts/${draft.id}/approve-and-send`, {
    method: "POST",
    headers: { authorization: "Bearer send-token" },
  });
  assert.equal(allowed.status, 200);
  assert.equal(sender.sent.length, 1);
});

test("ses payload uses raw content when the body is armored", () => {
  const input = sesInput(
    {
      from: { email: "lojo@cyberphysical.us", name: "Jon Hebert" },
      to: [{ email: "ada@example.com" }],
      cc: [],
      subject: "hello",
      text: "plain",
      armored: "-----BEGIN PGP MESSAGE-----\nww0=\n-----END PGP MESSAGE-----",
    },
    "lojo-mail",
  );
  assert.equal(input.Content?.Raw !== undefined, true);
  assert.equal(input.ConfigurationSetName, "lojo-mail");
  assert.equal(input.FromEmailAddress, "lojo@cyberphysical.us");
});
