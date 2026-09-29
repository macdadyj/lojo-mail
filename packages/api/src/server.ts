import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import {
  createLlmClient,
  generateIdentity,
  loadConfig,
  Mailbox,
  MemorySender,
  MemoryStore,
  MockLlm,
} from "@lojo/core";
import { createApp } from "./app.ts";
import { tokenBookFromEnv } from "./auth.ts";
import { seedDemo } from "./seed.ts";

const config = loadConfig({ ...process.env, LOJO_LLM_PROVIDER: process.env.LOJO_LLM_PROVIDER ?? "mock" });
const { publicJwk, privateJwk } = await generateIdentity();
const store = new MemoryStore();
const llm =
  config.llmProvider === "mock"
    ? new MockLlm()
    : createLlmClient(config, { grokApiKey: process.env.LOJO_GROK_API_KEY });
const styleGuide = readFileSync(new URL("../../../config/style-guide.md", import.meta.url), "utf8");
const mailbox = new Mailbox({
  store,
  config,
  publicJwk,
  privateJwk,
  llm,
  sender: new MemorySender(),
  styleGuide,
});
await seedDemo({ store, publicJwk, llm, config, styleGuide });
const app = createApp({
  mailbox,
  tokens: tokenBookFromEnv(process.env, false),
  dev: true,
  corsOrigin: ["http://127.0.0.1:5173", "http://localhost:5173"],
  info: {
    mailbox: config.mailbox,
    domain: config.domain,
    llmProvider: config.llmProvider,
    dailyTokenBudget: config.dailyTokenBudget,
  },
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`lojo-mail api http://127.0.0.1:${port}`);
  console.log("local tokens (refused when NODE_ENV=production): dev-only-change-me, dev-read-only, dev-send-change-me");
});
