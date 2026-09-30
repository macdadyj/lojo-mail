import assert from "node:assert/strict";
import test from "node:test";
import { testApp } from "@lojo/api/testing";
import { fixture } from "@lojo/core/testing";

type Api = Awaited<ReturnType<typeof testApp>>;

interface RpcReply {
  result?: {
    protocolVersion?: string;
    capabilities?: unknown;
    instructions?: string;
    tools?: Array<{ name: string; inputSchema: { type: string } }>;
    content?: Array<{ text?: string }>;
    isError?: boolean;
  };
  error?: { code: number };
}

let nextId = 1;

async function rpc(api: Api, token: string | undefined, method: string, params?: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await api.app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : null) as RpcReply | null };
}

function toolText(reply: RpcReply | null): string {
  return String(reply?.result?.content?.[0]?.text ?? "");
}

test("initialize negotiates a supported protocol version and tells the model mail is untrusted", async () => {
  const api = await testApp();
  const res = await rpc(api, "read-token", "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "grok", version: "1" } });
  assert.equal(res.status, 200);
  assert.equal(res.json?.result?.protocolVersion, "2025-03-26");
  assert.deepEqual(res.json?.result?.capabilities, { tools: { listChanged: false } });
  assert.match(res.json?.result?.instructions ?? "", /untrusted/);
  assert.equal(res.headers.get("mcp-session-id"), null, "stateless: no session id");

  const future = await rpc(api, "read-token", "initialize", { protocolVersion: "2099-01-01" });
  assert.equal(future.json?.result?.protocolVersion, "2025-06-18");
});

test("tools/list only advertises what the token's scopes allow", async () => {
  const api = await testApp();
  const read = await rpc(api, "read-token", "tools/list");
  const readNames = (read.json?.result?.tools ?? []).map((tool) => tool.name).sort();
  assert.deepEqual(readNames, ["export_mailbox", "list_inbox", "read_thread", "search_mail"]);

  const write = await rpc(api, "write-token", "tools/list");
  const writeNames = (write.json?.result?.tools ?? []).map((tool) => tool.name);
  assert.ok(writeNames.includes("create_draft"));
  assert.ok(!writeNames.includes("summarize_thread"), "summaries are message text and need body");

  const admin = await rpc(api, "admin-token", "tools/list");
  const adminNames = admin.json?.result?.tools ?? [];
  assert.equal(adminNames.length, 12);
  assert.ok(adminNames.every((tool) => !/send|approve|trash/.test(tool.name)), "no tool can send, approve, or trash, whatever the scope");
  assert.ok(adminNames.every((tool) => tool.inputSchema.type === "object"));
});

test("tools/call runs through the REST API and wraps results as untrusted", async () => {
  const api = await testApp();
  await api.ingest(fixture("personal.eml"));
  const res = await rpc(api, "read-token", "tools/call", { name: "search_mail", arguments: { query: "lease" } });
  assert.equal(res.status, 200);
  const text = toolText(res.json);
  assert.match(text, /<untrusted-mail-content>/);
  assert.match(text, /Lease renewal by Friday/);
  assert.equal(text.includes("CODEWORD-ZEBRA"), false, "no body text without the body scope");
});

test("a tool beyond the token's scopes is refused as a tool error and the API is never asked", async () => {
  const api = await testApp();
  const { message } = await api.ingest(fixture("personal.eml"));
  const before = (await api.store.listAudit()).length;
  const res = await rpc(api, "write-token", "tools/call", { name: "summarize_thread", arguments: { threadId: message.threadId } });
  assert.equal(res.status, 200);
  assert.equal(res.json?.result?.isError, true);
  assert.match(toolText(res.json), /Missing body scope/);
  assert.equal((await api.store.listAudit()).length, before, "no model call was made");
});

test("remote MCP cannot send: drafts only reach Jon's approval queue", async () => {
  const api = await testApp();
  const { message } = await api.ingest(fixture("personal.eml"));
  const created = await rpc(api, "send-token", "tools/call", {
    name: "create_draft",
    arguments: { to: ["mina@example.com"], subject: "Re: lease", text: "Will do.", threadId: message.threadId },
  });
  const draftId = /"id": "(drf_[^"]+)"/.exec(toolText(created.json))?.[1];
  assert.ok(draftId);
  const submitted = await rpc(api, "send-token", "tools/call", { name: "submit_for_approval", arguments: { draftId } });
  assert.match(toolText(submitted.json), /pending_approval/);
  const send = await rpc(api, "send-token", "tools/call", { name: "approve_and_send", arguments: { draftId } });
  assert.equal(send.json?.error?.code, -32602);
  assert.equal(api.sender.sent.length, 0);
});

test("auth: no token is 401 with a bearer challenge; a web session is refused; a browser origin is refused", async () => {
  const api = await testApp();
  const none = await rpc(api, undefined, "tools/list");
  assert.equal(none.status, 401);
  assert.match(none.headers.get("www-authenticate") ?? "", /^Bearer /);
  const wrong = await rpc(api, "not-a-token", "tools/list");
  assert.equal(wrong.status, 401);

  const session = await api.login();
  const human = await rpc(api, session, "tools/list");
  assert.equal(human.status, 403);

  const browser = await rpc(api, "read-token", "tools/list", undefined, { origin: "https://evil.example" });
  assert.equal(browser.status, 403);
});

test("protocol edges: notifications get 202, GET is 405, bad JSON and unknown methods are JSON-RPC errors", async () => {
  const api = await testApp();
  const note = await api.app.request("/mcp", {
    method: "POST",
    headers: { authorization: "Bearer read-token", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(note.status, 202);
  assert.equal(await note.text(), "");

  const get = await api.app.request("/mcp", { headers: { authorization: "Bearer read-token" } });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");

  const bad = await api.app.request("/mcp", { method: "POST", headers: { authorization: "Bearer read-token" }, body: "{" });
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: { code: number } }).error.code, -32700);

  const unknown = await rpc(api, "read-token", "resources/list");
  assert.equal(unknown.json?.error?.code, -32601);

  const version = await rpc(api, "read-token", "ping", undefined, { "mcp-protocol-version": "1999-01-01" });
  assert.equal(version.status, 400);
  assert.deepEqual((await rpc(api, "read-token", "ping", undefined, { "mcp-protocol-version": "2025-06-18" })).json?.result, {});
});

test("a batch from an older client gets one reply per request", async () => {
  const api = await testApp();
  const res = await api.app.request("/mcp", {
    method: "POST",
    headers: { authorization: "Bearer read-token", "content-type": "application/json" },
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]),
  });
  const body = (await res.json()) as Array<{ id: number }>;
  assert.deepEqual(
    body.map((item) => item.id),
    [1, 2],
  );
});

test("every request is access-logged under the token that made it, including tool calls made through /mcp", async () => {
  const api = await testApp();
  await api.ingest(fixture("personal.eml"));
  await rpc(api, "read-token", "tools/call", { name: "list_inbox", arguments: {} });
  await rpc(api, "read-token", "tools/call", { name: "get_action_items", arguments: {} });
  await rpc(api, "nope", "tools/list");
  await api.call("/v1/action-items", { token: "read-token" });
  await api.call("/v1/threads/thr_missing", { token: "body-token" });
  assert.deepEqual(api.accessLog, [
    { principal: "read", method: "GET", path: "/v1/inbox", status: 200 },
    { principal: "read", method: "POST", path: "/mcp", status: 200 },
    { principal: "read", method: "POST", path: "/mcp", status: 200 },
    { principal: "read", method: "GET", path: "/v1/action-items", status: 403 },
    { principal: "body", method: "GET", path: "/v1/threads/thr_missing", status: 404 },
  ]);
  assert.ok(!JSON.stringify(api.accessLog).includes("read-token"), "the token itself is never logged");
});
