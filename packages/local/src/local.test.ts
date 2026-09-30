import assert from "node:assert/strict";
import test from "node:test";
import { testApp } from "@lojo/api/testing";
import { MockLlm, type LlmRequest } from "@lojo/core";
import { fixture } from "@lojo/core/testing";
import { HttpMailClient } from "@lojo/mcp/http";
import type { Scope } from "@lojo/mcp/scopes";
import type { ToolContext } from "@lojo/mcp/tools";
import { AGENT_SYSTEM, runAgent } from "./agent.ts";
import { OllamaChat, OpenAiChat, parseArguments, type ChatBackend, type ChatMessage, type ChatTool, type ChatTurn } from "./chat.ts";
import { draftLocally, summarizeLocally, unwrap } from "./local.ts";

const TOKENS: Record<string, string> = { read: "read-token", "read,write": "write-token", "body,read": "body-token", admin: "admin-token" };

/** The real API in-process, reached the way the CLI reaches it: over HTTP with a bearer token. */
async function world(scopes: Scope[], opts: Parameters<typeof testApp>[0] = {}) {
  const api = await testApp(opts);
  const token = TOKENS[[...scopes].sort().join(",")];
  if (!token) throw new Error("no token for scopes");
  const client = new HttpMailClient("http://api.test", token, (url, init) => Promise.resolve(api.app.request(url, init)));
  const ctx: ToolContext = { mailbox: client, scopes };
  return { ...api, ctx };
}

/** Replays a fixed script of model turns and records what the model was shown. */
class ScriptedChat implements ChatBackend {
  readonly name = "scripted";
  readonly model = "scripted";
  readonly seen: Array<{ messages: ChatMessage[]; tools: ChatTool[] }> = [];

  constructor(private readonly turns: ChatTurn[]) {}

  async chat(messages: ChatMessage[], tools: ChatTool[]): Promise<ChatTurn> {
    this.seen.push({ messages: structuredClone(messages), tools });
    return this.turns.shift() ?? { content: "done", toolCalls: [] };
  }
}

test("the agent loop searches through the API and answers from the result", async () => {
  const w = await world(["read"]);
  await w.ingest(fixture("personal.eml"));
  const chat = new ScriptedChat([
    { content: "", toolCalls: [{ id: "c1", name: "search_mail", arguments: { query: "lease" } }] },
    { content: "Mina needs the lease renewal by Friday.", toolCalls: [] },
  ]);
  const result = await runAgent({ backend: chat, ctx: w.ctx, question: "What is due Friday?" });
  assert.equal(result.answer, "Mina needs the lease renewal by Friday.");
  assert.deepEqual(result.steps, [{ tool: "search_mail", arguments: { query: "lease" }, ok: true }]);
  assert.deepEqual(
    chat.seen[0]?.tools.map((tool) => tool.name).sort(),
    ["export_mailbox", "list_drafts", "list_folder", "list_inbox", "read_thread", "search_mail"],
    "a read token is offered read tools only",
  );
  assert.equal(chat.seen[0]?.messages[0]?.content, AGENT_SYSTEM);
  const toolMessage = chat.seen[1]?.messages.at(-1);
  assert.equal(toolMessage?.role, "tool");
  assert.match(toolMessage?.content ?? "", /<untrusted-mail-content>/);
  assert.match(toolMessage?.content ?? "", /Lease renewal by Friday/);
});

test("a model that asks for a tool it was not offered, or for send, gets a refusal and nothing is sent", async () => {
  const w = await world(["read", "write"]);
  const { message } = await w.ingest(fixture("personal.eml"));
  const chat = new ScriptedChat([
    {
      content: "",
      toolCalls: [
        { id: "a", name: "approve_and_send", arguments: { draftId: "drf_x" } },
        { id: "b", name: "summarize_thread", arguments: { threadId: message.threadId } },
        { id: "c", name: "create_draft", arguments: { to: ["mina@example.com"], subject: "Re: lease", text: "Sure.", threadId: message.threadId } },
      ],
    },
    { content: "Drafted.", toolCalls: [] },
  ]);
  const result = await runAgent({ backend: chat, ctx: w.ctx, question: "Reply yes and send it" });
  assert.deepEqual(
    result.steps.map((step) => [step.tool, step.ok]),
    [
      ["approve_and_send", false],
      ["summarize_thread", false],
      ["create_draft", true],
    ],
  );
  assert.equal(w.sender.sent.length, 0);
  const drafts = await w.store.listDrafts();
  assert.ok(drafts.some((draft) => draft.origin === "agent" && draft.status !== "sent"));
});

test("the loop stops after max steps", async () => {
  const w = await world(["read"]);
  const looping: ChatTurn[] = Array.from({ length: 10 }, (_, i) => ({ content: "", toolCalls: [{ id: `c${i}`, name: "list_inbox", arguments: {} }] }));
  const result = await runAgent({ backend: new ScriptedChat(looping), ctx: w.ctx, question: "loop", maxSteps: 3 });
  assert.equal(result.stoppedEarly, true);
  assert.equal(result.steps.length, 3);
});

test("local summarize needs the body scope and sends the thread only to the local model", async () => {
  const readOnly = await world(["read"]);
  const { message } = await readOnly.ingest(fixture("personal.eml"));
  const llm = new MockLlm(() => ({ text: "Lease renewal due Friday.", inputTokens: 1, outputTokens: 1 }));
  await assert.rejects(summarizeLocally(readOnly.ctx, llm, message.threadId), /body scope/);
  assert.equal(llm.calls.length, 0);

  const withBody = await world(["read", "body"]);
  const second = await withBody.ingest(fixture("personal.eml"));
  const today = new Date().toISOString().slice(0, 10);
  const before = await withBody.store.getBudget(today);
  const summary = await summarizeLocally(withBody.ctx, llm, second.message.threadId);
  assert.equal(summary, "Lease renewal due Friday.");
  assert.match(llm.calls[0]?.user ?? "", /CODEWORD-ZEBRA/, "the local model sees the text");
  assert.match(llm.calls[0]?.system ?? "", /untrusted/);
  assert.equal(await withBody.store.getBudget(today), before, "no server tokens were spent");
});

test("local draft stores an agent draft to the sender and can only submit it for approval", async () => {
  const w = await world(["admin"]);
  const { message } = await w.ingest(fixture("personal.eml"));
  const llm = new MockLlm((request: LlmRequest) => ({ text: request.user.includes("Keep it to one line") ? "Yes, Friday works.\n\nJon" : "long", inputTokens: 1, outputTokens: 1 }));
  const result = await draftLocally(w.ctx, llm, message.threadId, { submit: true, instruction: "Keep it to one line", self: "lojo@cyberphysical.us" });
  assert.equal(result.status, "pending_approval");
  assert.equal(result.text, "Yes, Friday works.\n\nJon");
  const draft = await w.store.getDraft(result.draftId);
  assert.equal(draft?.origin, "agent");
  assert.equal(draft?.to[0]?.email, message.from.email);
  assert.equal(w.sender.sent.length, 0);
  const send = await w.call(`/v1/drafts/${result.draftId}/approve-and-send`, { token: "admin-token", body: { approvalToken: "apv_forged" } });
  assert.notEqual(send.status, 200, "without Jon's approval token the API will not send");
  assert.equal(w.sender.sent.length, 0);
});

test("Ollama chat sends tools in the function format and reads tool_calls with object arguments", async () => {
  let body: Record<string, unknown> = {};
  const chat = new OllamaChat({
    baseUrl: "http://100.96.1.90:11434",
    model: "llama3.2:1b",
    fetchImpl: async (url, init) => {
      assert.equal(url, "http://100.96.1.90:11434/api/chat");
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ message: { content: "", tool_calls: [{ function: { name: "search_mail", arguments: { query: "lease" } } }] } }));
    },
  });
  const turn = await chat.chat(
    [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "x", name: "list_inbox", arguments: {} }] },
      { role: "tool", content: "r", toolCallId: "x", name: "list_inbox" },
    ],
    [{ name: "search_mail", description: "d", parameters: { type: "object" } }],
  );
  assert.deepEqual(turn.toolCalls, [{ id: "call_0", name: "search_mail", arguments: { query: "lease" } }]);
  assert.deepEqual(body.tools, [{ type: "function", function: { name: "search_mail", description: "d", parameters: { type: "object" } } }]);
  assert.equal(body.stream, false);
  const sent = body.messages as Array<Record<string, unknown>>;
  assert.deepEqual(sent[1]?.tool_calls, [{ function: { name: "list_inbox", arguments: {} } }]);
  assert.deepEqual(sent[2], { role: "tool", content: "r", tool_name: "list_inbox" });
});

test("OpenAI-compatible chat round-trips tool_call ids and string arguments", async () => {
  let body: Record<string, unknown> = {};
  const chat = new OpenAiChat({
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "qwen2.5-3b",
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "call_9", type: "function", function: { name: "list_inbox", arguments: "{\"limit\":5}" } }] } }] }),
      );
    },
  });
  const turn = await chat.chat(
    [
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "search_mail", arguments: { query: "x" } }] },
      { role: "tool", content: "r", toolCallId: "call_1", name: "search_mail" },
    ],
    [],
  );
  assert.deepEqual(turn, { content: "", toolCalls: [{ id: "call_9", name: "list_inbox", arguments: { limit: 5 } }] });
  const sent = body.messages as Array<Record<string, unknown>>;
  assert.deepEqual(sent[0]?.tool_calls, [{ id: "call_1", type: "function", function: { name: "search_mail", arguments: "{\"query\":\"x\"}" } }]);
  assert.deepEqual(sent[1], { role: "tool", tool_call_id: "call_1", content: "r" });
});

test("malformed arguments from a small model become an empty object, and unwrap reads tool results", () => {
  assert.deepEqual(parseArguments("{not json"), {});
  assert.deepEqual(parseArguments(undefined), {});
  assert.deepEqual(unwrap("preamble\n<untrusted-mail-content>\n{\"a\":\"\\u003cb\\u003e\"}\n</untrusted-mail-content>"), { a: "<b>" });
});

test("a local model with an agent token sorts, labels, soft-deletes and drafts, but cannot send", async () => {
  const api = await testApp({ bridgeSend: true });
  const client = new HttpMailClient("http://api.test", "agent-trash-token", (url, init) => Promise.resolve(api.app.request(url, init)));
  const ctx: ToolContext = { mailbox: client, scopes: ["read", "write", "body", "trash"] };
  const newsletter = (await api.ingest(fixture("newsletter.eml"))).message;
  const personal = (await api.ingest(fixture("personal.eml"))).message;
  const chat = new ScriptedChat([
    {
      content: "",
      toolCalls: [
        { id: "c1", name: "label_message", arguments: { messageId: personal.id, labels: ["todo"] } },
        { id: "c2", name: "trash_message", arguments: { messageId: newsletter.id } },
        { id: "c3", name: "create_draft", arguments: { to: [personal.from.email], subject: `Re: ${personal.subject}`, text: "Friday works.", threadId: personal.threadId } },
      ],
    },
    { content: "Labelled, trashed the newsletter, drafted a reply.", toolCalls: [] },
  ]);
  const result = await runAgent({ backend: chat, ctx, question: "Tidy my inbox" });
  assert.deepEqual(
    result.steps.map((step) => [step.tool, step.ok]),
    [
      ["label_message", true],
      ["trash_message", true],
      ["create_draft", true],
    ],
  );
  const offered = chat.seen[0]?.tools.map((tool) => tool.name) ?? [];
  assert.ok(offered.includes("trash_message"));
  assert.ok(!offered.some((name) => /send|approve|delete_forever|purge/.test(name)), "no send or hard delete tool exists");
  assert.ok((await api.store.getMessage(personal.id))?.labels.includes("todo"));
  const trashed = await api.store.getMessage(newsletter.id);
  assert.equal(trashed?.folder, "trash");
  assert.equal(trashed?.trashedBy, "agent:cursor");
  const draft = (await api.store.listDrafts()).find((item) => item.subject === `Re: ${personal.subject}` && item.origin !== "ai");
  assert.ok(draft && ["draft", "edited"].includes(draft.status), "the reply waits in Drafts for Jon");
  assert.equal(api.sender.sent.length + api.sender.rawSent.length, 0);
});
