#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import { OllamaLlm, OpenAiCompatibleLlm, type LlmClient, type MessageView } from "@lojo/core";
import { effectiveScopes, toolDefinitions } from "@lojo/mcp/catalog";
import { HttpMailClient } from "@lojo/mcp/http";
import { parseScopes } from "@lojo/mcp/scopes";
import { callTool, type ToolContext } from "@lojo/mcp/tools";
import { runAgent } from "./agent.ts";
import { OllamaChat, OpenAiChat, type ChatBackend } from "./chat.ts";
import { draftLocally, formatList, summarizeLocally, unwrap } from "./local.ts";

const USAGE = `lojo-local: search and operate lojo-mail from a local model

  lojo-local whoami
  lojo-local tools
  lojo-local search <query> [--semantic] [--context] [--json]
  lojo-local inbox [--triage] [--limit N] [--json]
  lojo-local read <threadId> [--context] [--json]
  lojo-local summarize <threadId> [--local]
  lojo-local draft <messageId> [--submit]               server model drafts the reply
  lojo-local draft <threadId> --local [--submit] [--instruction "..."]
  lojo-local ask "<question>" [--max-steps N]
  lojo-local backfill [--limit N]

Environment
  LOJO_API_URL          lojo-mail API (default http://127.0.0.1:8787)
  LOJO_API_TOKEN        API or agent token (default dev-read-only)
  LOJO_API_SCOPES       scopes this client may use, narrowed to the token's (default read)
  LOJO_LOCAL_BACKEND    ollama | openai (default ollama)
  OLLAMA_URL            default http://100.96.1.90:11434
  LOJO_LOCAL_MODEL      default llama3.2:1b (llama3.2:3b or qwen2.5:3b call tools more reliably)
  LOJO_LOCAL_OPENAI_URL OpenAI-compatible base URL for --backend openai (llama.cpp, vLLM, LM Studio)
  LOJO_LOCAL_OPENAI_KEY optional key for that server
  LOJO_MAILBOX          Jon's address, so draft replies skip his own messages (default lojo@cyberphysical.us)

--local runs the model on this machine: thread text goes from the API to
Ollama and nowhere else. It needs a token with the body scope. Nothing here
can send mail; drafts go to Jon's approval queue in the web app.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    semantic: { type: "boolean", default: false },
    context: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    triage: { type: "boolean", default: false },
    limit: { type: "string" },
    local: { type: "boolean", default: false },
    submit: { type: "boolean", default: false },
    instruction: { type: "string" },
    "max-steps": { type: "string" },
    backend: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const env = process.env;
const [command, ...rest] = positionals;
if (!command || values.help) {
  console.log(USAGE);
  process.exit(command ? 0 : 2);
}

const client = new HttpMailClient(env.LOJO_API_URL ?? "http://127.0.0.1:8787", env.LOJO_API_TOKEN ?? "dev-read-only");
const declared = parseScopes(env.LOJO_API_SCOPES ?? "read");
const session = await client.session();
const ctx: ToolContext = { mailbox: client, scopes: effectiveScopes(declared, session.scopes) };
const backendName = values.backend ?? env.LOJO_LOCAL_BACKEND ?? "ollama";
const model = env.LOJO_LOCAL_MODEL ?? "llama3.2:1b";

function localLlm(): LlmClient {
  switch (backendName) {
    case "ollama":
      return new OllamaLlm({ baseUrl: env.OLLAMA_URL ?? "http://100.96.1.90:11434", model, timeoutMs: 180_000 });
    case "openai":
      return new OpenAiCompatibleLlm({
        name: "local-openai",
        baseUrl: env.LOJO_LOCAL_OPENAI_URL ?? "http://127.0.0.1:8080/v1",
        model,
        ...(env.LOJO_LOCAL_OPENAI_KEY ? { apiKey: env.LOJO_LOCAL_OPENAI_KEY } : {}),
        timeoutMs: 180_000,
      });
    default:
      throw new Error(`--backend must be ollama or openai, not ${backendName}`);
  }
}

function chatBackend(): ChatBackend {
  switch (backendName) {
    case "ollama":
      return new OllamaChat({ baseUrl: env.OLLAMA_URL ?? "http://100.96.1.90:11434", model });
    case "openai":
      return new OpenAiChat({
        baseUrl: env.LOJO_LOCAL_OPENAI_URL ?? "http://127.0.0.1:8080/v1",
        model,
        ...(env.LOJO_LOCAL_OPENAI_KEY ? { apiKey: env.LOJO_LOCAL_OPENAI_KEY } : {}),
      });
    default:
      throw new Error(`--backend must be ollama or openai, not ${backendName}`);
  }
}

function limit(fallback: number): number {
  const parsed = Number(values.limit ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function printMessages(wrapped: string): void {
  if (values.json) console.log(wrapped);
  else console.log(formatList(unwrap<MessageView[]>(wrapped)));
}

function need(arg: string | undefined, what: string): string {
  if (!arg) {
    console.error(`missing ${what}\n\n${USAGE}`);
    process.exit(2);
  }
  return arg;
}

try {
  switch (command) {
    case "whoami":
      console.log(JSON.stringify({ api: session, using: ctx.scopes }, null, 2));
      break;
    case "tools":
      for (const tool of toolDefinitions(ctx.scopes)) console.log(`${tool.name}  [${tool.scopes.join(",")}]\n  ${tool.description}`);
      break;
    case "search":
      printMessages(await callTool("search_mail", { query: need(rest.join(" "), "query"), mode: values.semantic ? "semantic" : "keyword", includeContext: values.context }, ctx));
      break;
    case "inbox":
      printMessages(await callTool("list_inbox", { limit: limit(20), triage: values.triage }, ctx));
      break;
    case "read": {
      const wrapped = await callTool("read_thread", { threadId: need(rest[0], "threadId"), includeContext: values.context }, ctx);
      if (values.json) console.log(wrapped);
      else {
        const read = unwrap<{ thread: { subject: string }; messages: MessageView[] }>(wrapped);
        console.log(`${read.thread.subject}\n`);
        for (const message of read.messages) {
          console.log(`--- ${message.date} ${message.from.email}\n${message.text ?? message.contextText ?? message.snippet}\n`);
        }
      }
      break;
    }
    case "summarize": {
      const threadId = need(rest[0], "threadId");
      if (values.local) console.log(await summarizeLocally(ctx, localLlm(), threadId));
      else console.log(unwrap<{ summary: string }>(await callTool("summarize_thread", { threadId }, ctx)).summary);
      break;
    }
    case "draft": {
      const id = need(rest[0], values.local ? "threadId" : "messageId");
      if (values.local) {
        const result = await draftLocally(ctx, localLlm(), id, {
          submit: values.submit,
          self: env.LOJO_MAILBOX ?? "lojo@cyberphysical.us",
          ...(values.instruction ? { instruction: values.instruction } : {}),
        });
        console.log(`${result.text}\n\ndraft ${result.draftId} (${result.status})${values.submit ? "" : ". Run with --submit to queue it for Jon's approval."}`);
      } else {
        const created = unwrap<{ draft: { id: string; status: string } }>(await callTool("draft_reply", { messageId: id }, ctx));
        const final = values.submit ? unwrap<{ draft: { id: string; status: string } }>(await callTool("submit_for_approval", { draftId: created.draft.id }, ctx)) : created;
        console.log(`draft ${final.draft.id} (${final.draft.status})`);
      }
      break;
    }
    case "ask": {
      const result = await runAgent({
        backend: chatBackend(),
        ctx,
        question: need(rest.join(" "), "question"),
        maxSteps: Number(values["max-steps"] ?? 6) || 6,
        onStep: (step) => console.error(`  tool ${step.tool} ${JSON.stringify(step.arguments)}${step.ok ? "" : " (refused or failed)"}`),
      });
      console.log(result.answer);
      break;
    }
    case "backfill": {
      const response = await fetch(`${(env.LOJO_API_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "")}/v1/vectors/backfill`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.LOJO_API_TOKEN ?? ""}`, "content-type": "application/json" },
        body: JSON.stringify({ limit: limit(25) }),
      });
      console.log(await response.text());
      if (!response.ok) process.exitCode = 1;
      break;
    }
    default:
      console.error(`unknown command ${command}\n\n${USAGE}`);
      process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
