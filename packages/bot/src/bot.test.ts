import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LOJO_TEST_RECIPIENT, type DraftView } from "@lojo/core";
import { fixture } from "@lojo/core/testing";
import { TEST_PASSPHRASE, testApp } from "@lojo/api/testing";
import { runAdmin, type AdminIo } from "./admin.ts";
import type { FetchLike } from "./api.ts";
import { opArgs, parseArgv } from "./args.ts";
import { apiUrlFrom, BotConfigError, readPrivateFile, writePrivateFile } from "./config.ts";
import { digestStatePath } from "./digest.ts";
import { newBotKey } from "./keys.ts";
import { botMcpServer } from "./mcp.ts";
import { allowedOps, ops, runOp } from "./ops.ts";
import { botContext } from "./runtime.ts";

type App = Awaited<ReturnType<typeof testApp>>;

const API = "http://localhost";

function fetchFor(app: App): FetchLike {
  return (url, init) => Promise.resolve(app.app.request(url, init));
}

function adminIo(lines: string[]): AdminIo {
  return { ask: () => Promise.resolve(TEST_PASSPHRASE), print: (line) => lines.push(line) };
}

/** A bot home on "Santa": token and key files mode 600, an attach directory, a state directory. */
function botHome() {
  const root = mkdtempSync(join(tmpdir(), "lojo-bot-"));
  const home = join(root, "config");
  const attachDir = join(root, "files");
  mkdirSync(attachDir, { recursive: true });
  const env = { LOJO_API_URL: API, LOJO_BOT_HOME: home, LOJO_BOT_STATE_DIR: join(root, "state"), LOJO_BOT_ATTACH_DIR: attachDir };
  return { root, home, attachDir, env };
}

async function admin(app: App, command: string, positionals: string[], flags: Record<string, string | boolean> = {}) {
  const lines: string[] = [];
  await runAdmin({ command, positionals, flags }, { apiUrl: API, io: adminIo(lines), fetchImpl: fetchFor(app) });
  return lines;
}

/** Jon creates the bot with `lojo-bot admin create`, the bot generates its key, Jon registers it. */
async function setUp(app: App, scopes = "read,write,body", withKey = true) {
  const santa = botHome();
  const lines = await admin(app, "create", ["grok"], { out: join(santa.home, "token"), scopes });
  if (withKey) {
    const key = await newBotKey();
    writePrivateFile(join(santa.home, "envelope.private.jwk"), JSON.stringify(key.privateJwk));
    const publicFile = join(santa.root, "bot.public.jwk");
    writeFileSync(publicFile, JSON.stringify(key.publicJwk));
    await admin(app, "set-key", [publicFile]);
  }
  const ctx = await botContext(santa.env, fetchFor(app));
  return { santa, ctx, lines };
}

test("admin create writes the credential to a mode 600 file and never prints it", async () => {
  const app = await testApp();
  const { santa, lines, ctx } = await setUp(app, "read,write,body", false);
  const tokenFile = join(santa.home, "token");
  const token = readFileSync(tokenFile, "utf8").trim();
  assert.match(token, /^lbt_grok_/);
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  assert.equal(lines.join("\n").includes(token), false);
  assert.deepEqual([...ctx.scopes], ["read", "write", "body"]);
  await assert.rejects(admin(app, "create", ["other"], { out: tokenFile }), /already exists/);

  const rotated = await admin(app, "rotate", ["grok"], { out: tokenFile, force: true });
  assert.equal(rotated.join("\n").includes(readFileSync(tokenFile, "utf8").trim()), false);
  await assert.rejects(runOp("health", {}, ctx), /401/);
  const fresh = await botContext(santa.env, fetchFor(app));
  assert.equal(((await runOp("health", {}, fresh)) as { bot: string }).bot, "bot:grok");
});

test("a wrong passphrase stops every admin command", async () => {
  const app = await testApp();
  const io: AdminIo = { ask: () => Promise.resolve("wrong"), print: () => undefined };
  await assert.rejects(runAdmin({ command: "list", positionals: [], flags: {} }, { apiUrl: API, io, fetchImpl: fetchFor(app) }), /Sign-in failed: 401/);
});

test("the bot reads bodies with its own key, Jon's backfill covers older mail", async () => {
  const app = await testApp({ botCopies: true });
  const old = await app.ingest(fixture("personal.eml"));
  const { ctx, santa } = await setUp(app);
  const fresh = await app.ingest(fixture("reply.eml"));

  const read = (await runOp("read_message", { messageId: fresh.message.id }, ctx)) as { body: { source: string; text: string } };
  assert.equal(read.body.source, "bot-key");
  assert.ok(read.body.text.length > 0);

  const before = (await runOp("read_message", { messageId: old.message.id }, ctx)) as { body: { source: string } };
  assert.notEqual(before.body.source, "bot-key");

  const jonKey = join(santa.root, "jon.private.jwk");
  writePrivateFile(jonKey, JSON.stringify(app.privateJwk));
  const lines = await admin(app, "backfill", [], { "private-key-file": jonKey });
  assert.match(lines.at(-1) ?? "", /1 sealed, 0 failed/);
  const after = (await runOp("read_message", { messageId: old.message.id }, ctx)) as { body: { source: string } };
  assert.equal(after.body.source, "bot-key");

  await admin(app, "remove-key", []);
  const removed = (await runOp("read_message", { messageId: fresh.message.id }, ctx)) as { body: { source: string } };
  assert.notEqual(removed.body.source, "bot-key");
});

test("without body scope the bot sees metadata only", async () => {
  const app = await testApp({ botCopies: true });
  const { message } = await app.ingest(fixture("personal.eml"));
  const { ctx } = await setUp(app, "read,write");
  const read = (await runOp("read_message", { messageId: message.id }, ctx)) as { body: { source: string; text?: string } };
  assert.equal(read.body.source, "none");
  assert.equal(read.body.text, undefined);
});

test("draft_reply threads a reply that waits for Jon; attach_file reads only the attach directory", async () => {
  const app = await testApp({ botCopies: true });
  const { message } = await app.ingest(fixture("personal.eml"));
  const { ctx, santa } = await setUp(app);

  const reply = (await runOp("draft_reply", { messageId: message.id, text: "Friday works." }, ctx)) as DraftView;
  assert.equal(reply.draft.origin, "agent");
  assert.deepEqual(reply.draft.to.map((item) => item.email), [message.from.email]);
  assert.equal(reply.draft.threadId, message.threadId);
  assert.match(reply.draft.subject, /^Re: /i);

  writeFileSync(join(santa.attachDir, "notes.txt"), "agenda");
  const attached = (await runOp("attach_file", { draftId: reply.draft.id, path: "notes.txt" }, ctx)) as DraftView;
  assert.deepEqual(
    attached.draft.attachments?.map((item) => item.filename),
    ["notes.txt"],
  );

  const secret = join(santa.root, "outside.txt");
  writeFileSync(secret, "not for mail");
  await assert.rejects(runOp("attach_file", { draftId: reply.draft.id, path: secret }, ctx), BotConfigError);
  await assert.rejects(runOp("attach_file", { draftId: reply.draft.id, path: "../outside.txt" }, ctx), BotConfigError);
  symlinkSync(secret, join(santa.attachDir, "link.txt"));
  await assert.rejects(runOp("attach_file", { draftId: reply.draft.id, path: "link.txt" }, ctx), BotConfigError);
  await assert.rejects(runOp("attach_file", { draftId: reply.draft.id, path: join(santa.home, "token") }, ctx), BotConfigError);

  const submitted = (await runOp("submit_for_approval", { draftId: reply.draft.id }, ctx)) as DraftView;
  assert.equal(submitted.draft.status, "pending_approval");
  assert.equal(app.sender.sent.length, 0);
  const discarded = (await runOp("discard_draft", { draftId: reply.draft.id }, ctx)) as DraftView;
  assert.equal(discarded.draft.status, "discarded");
});

test("sorting ops, scope checks, bot rules and the lojo-test send", async () => {
  const app = await testApp();
  const { message } = await app.ingest(fixture("personal.eml"));
  const plain = await setUp(app, "read,write", false);
  await assert.rejects(runOp("trash_message", { messageId: message.id }, plain.ctx), /needs the trash scope/);
  await assert.rejects(runOp("upsert_rule", { rule: { id: "x" } }, plain.ctx), /needs the rules scope/);
  await assert.rejects(runOp("send_test_to_lojo_test", { subject: "s", text: "t" }, plain.ctx), /needs the test-send scope/);

  const session = await app.login();
  await app.call("/v1/bots/grok/scopes", { token: session, body: { scopes: ["read", "write", "trash", "rules", "test-send"] } });
  const ctx = await botContext(plain.santa.env, fetchFor(app));

  await runOp("mark_read", { messageId: message.id, read: true }, ctx);
  await runOp("flag", { messageId: message.id, flagged: true }, ctx);
  const flagged = await app.mailbox.getMessage(message.id);
  assert.equal(flagged.unread, false);
  assert.ok(flagged.labels.includes("flagged"));

  const trashed = (await runOp("trash_message", { messageId: message.id }, ctx)) as { trashedBy: string };
  assert.equal(trashed.trashedBy, "bot:grok");
  await runOp("restore_message", { messageId: message.id }, ctx);
  assert.equal((await app.mailbox.getMessage(message.id)).folder, "inbox");

  await runOp("upsert_rule", { rule: { id: "news", name: "News", match: { bulk: true }, actions: [{ type: "move", folder: "archive" }] } }, ctx);
  const listed = (await runOp("list_rules", {}, ctx)) as { rules: { rules: Array<{ id: string; createdBy?: string }> } };
  assert.equal(listed.rules.rules.find((rule) => rule.id === "news")?.createdBy, "bot");
  await assert.rejects(
    runOp("upsert_rule", { rule: { id: "bin", name: "Bin", match: { bulk: true }, actions: [{ type: "move", folder: "trash" }] } }, ctx),
    /403|400/,
  );
  await runOp("delete_rule", { ruleId: "news" }, ctx);

  const sent = (await runOp("send_test_to_lojo_test", { subject: "ping", text: "hello", to: ["jon@elsewhere.example"] }, ctx)) as { to: string };
  assert.equal(sent.to, LOJO_TEST_RECIPIENT);
  assert.deepEqual(app.sender.sent.map((item) => item.to.map((to) => to.email)), [[LOJO_TEST_RECIPIENT]]);

  const audit = (await runOp("audit_log", { mine: true, limit: 200 }, ctx)) as Array<{ actor?: string; action: string }>;
  assert.ok(audit.length > 0);
  assert.ok(audit.every((event) => event.actor === "bot:grok"));
  assert.ok(audit.some((event) => event.action === "bot.test_send"));
});

test("the digest reports new mail once, peek leaves the cursor, and the first run skips old mail", async () => {
  let now = new Date("2026-10-01T12:00:00Z");
  const app = await testApp({ botCopies: true, now: () => now });
  const { ctx, santa } = await setUp(app);
  ctx.now = () => now;
  const first = await app.ingest(fixture("personal.eml"));

  const peek = (await runOp("digest", { peek: true, sinceHours: 720 }, ctx)) as { counts: { new: number }; messages: Array<{ id: string; excerpt?: string }> };
  assert.equal(peek.counts.new, 1);
  assert.ok(peek.messages[0]?.excerpt);
  assert.throws(() => readFileSync(digestStatePath(santa.env.LOJO_BOT_STATE_DIR)));

  const run = (await runOp("digest", { sinceHours: 720 }, ctx)) as { counts: { new: number }; messages: Array<{ id: string }>; note: string };
  assert.deepEqual(run.messages.map((item) => item.id), [first.message.id]);
  assert.match(run.note, /untrusted/i);
  assert.equal(statSync(digestStatePath(santa.env.LOJO_BOT_STATE_DIR)).mode & 0o777, 0o600);

  const again = (await runOp("digest", {}, ctx)) as { counts: { new: number } };
  assert.equal(again.counts.new, 0);

  now = new Date("2026-10-01T13:00:00Z");
  const second = await app.ingest(fixture("reply.eml"));
  await app.ingest(fixture("newsletter.eml"));
  const limited = (await runOp("digest", { limit: 1 }, ctx)) as { counts: { new: number; reported: number }; truncated: boolean };
  assert.equal(limited.counts.new, 2);
  assert.equal(limited.truncated, true);
  const rest = (await runOp("digest", {}, ctx)) as { counts: { new: number }; messages: Array<{ id: string }> };
  assert.equal(rest.counts.new, 1);
  assert.ok(second.message.id);

  const fresh = await botContext({ ...santa.env, LOJO_BOT_STATE_DIR: join(botHome().root, "state") }, fetchFor(app));
  fresh.now = () => now;
  const baseline = (await runOp("digest", {}, fresh)) as { counts: { new: number } };
  assert.equal(baseline.counts.new, 0);
  const next = (await runOp("digest", { sinceHours: 720 }, fresh)) as { counts: { new: number } };
  assert.equal(next.counts.new, 0);
});

test("the MCP server advertises only the tools the credential may call, results wrapped as untrusted", async () => {
  const app = await testApp({ botCopies: true });
  await app.ingest(fixture("personal.eml"));
  const { ctx } = await setUp(app);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await botMcpServer(ctx).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);

  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(names.sort(), allowedOps(ctx.scopes).map((item) => item.name).sort());
  for (const required of ["list_inbox", "read_message", "search", "digest", "draft_reply", "create_draft", "attach_file", "list_drafts", "discard_draft", "move_message", "list_rules", "health", "audit_log", "settings"]) {
    assert.ok(names.includes(required), required);
  }
  assert.equal(names.includes("send_test_to_lojo_test"), false);
  assert.equal(names.includes("trash_message"), false);
  assert.equal(names.includes("upsert_rule"), false);

  const result = (await client.callTool({ name: "list_inbox", arguments: { limit: 5 } })) as { content: Array<{ text: string }>; isError?: boolean };
  assert.equal(result.isError, undefined);
  assert.match(result.content[0]?.text ?? "", /untrusted/i);
  const bad = (await client.callTool({ name: "read_message", arguments: { messageId: "missing" } })) as { isError?: boolean };
  assert.equal(bad.isError, true);
  await client.close();
});

test("every op name required by the plan exists", () => {
  const names = ops.map((item) => item.name);
  for (const required of ["list_inbox", "read_message", "search", "digest", "draft_reply", "create_draft", "attach_file", "list_drafts", "discard_draft", "move_message", "trash_message", "list_rules", "upsert_rule", "delete_rule", "health", "audit_log", "settings", "send_test_to_lojo_test"]) {
    assert.ok(names.includes(required), required);
  }
  assert.equal(
    ops.some((item) => item.scopes.some((scope) => !["read", "write", "body", "trash", "rules", "test-send"].includes(scope))),
    false,
  );
});

test("CLI arguments are typed by the operation's schema", () => {
  const draft = ops.find((item) => item.name === "create_draft");
  assert.ok(draft);
  const args = opArgs(parseArgv(["--to", "a@b.example,c@d.example", "--subject", "123", "--text=hi there"]), draft.schema);
  assert.deepEqual(args, { to: ["a@b.example", "c@d.example"], subject: "123", text: "hi there" });
  const inbox = ops.find((item) => item.name === "list_inbox");
  assert.ok(inbox);
  assert.deepEqual(opArgs(parseArgv(["--limit", "5", "--unreadOnly"]), inbox.schema), { limit: 5, unreadOnly: true });
  assert.deepEqual(opArgs(parseArgv(["--json", '{"limit":3}', "--triage", "true"]), inbox.schema), { limit: 3, triage: true });
  assert.throws(() => opArgs(parseArgv(["--nope", "1"]), inbox.schema), /Unknown argument --nope/);
});

test("private files must be mode 600, and the API must be https outside localhost", () => {
  const { root } = botHome();
  const file = join(root, "token");
  writeFileSync(file, "lbt_x");
  chmodSync(file, 0o644);
  assert.throws(() => readPrivateFile(file), /readable by group or others/);
  chmodSync(file, 0o600);
  assert.equal(readPrivateFile(file), "lbt_x");

  assert.throws(() => apiUrlFrom({ LOJO_API_URL: "http://api.example.com" }), /must be https/);
  assert.equal(apiUrlFrom({ LOJO_API_URL: "https://api.example.com/" }), "https://api.example.com");
  assert.equal(apiUrlFrom({ LOJO_API_URL: "http://localhost:8787" }), "http://localhost:8787");
  assert.throws(() => apiUrlFrom({}), /Set LOJO_API_URL/);
});
