import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import {
  createLlmClient,
  FsBlobStore,
  generateIdentity,
  LocalKeyWrapper,
  loadConfig,
  Mailbox,
  MemoryBlobStore,
  MemorySender,
  MemoryStore,
  MockLlm,
  type BlobStore,
  type EcPrivateJwk,
  type EcPublicJwk,
} from "@lojo/core";
import { createApp } from "./app.ts";
import { tokenBookFromEnv } from "./auth.ts";
import { seedDemo } from "./seed.ts";
import { DEV_PASSPHRASE, devSessions } from "./session.ts";

const production = process.env.NODE_ENV === "production";
const host = process.env.LOJO_HOST ?? "127.0.0.1";
const config = loadConfig({ ...process.env, LOJO_LLM_PROVIDER: process.env.LOJO_LLM_PROVIDER ?? "mock" });
const llm =
  config.llmProvider === "mock"
    ? new MockLlm()
    : createLlmClient(config, { grokApiKey: process.env.LOJO_GROK_API_KEY });
const styleGuide = readFileSync(new URL("../../../config/style-guide.md", import.meta.url), "utf8");

/** A local master key for draft sealing, so drafts in an imported store survive restarts. */
function localKeys(path: string): LocalKeyWrapper {
  if (existsSync(path)) return new LocalKeyWrapper(new Uint8Array(readFileSync(path)));
  const master = randomBytes(32);
  writeFileSync(path, master, { mode: 0o600 });
  return new LocalKeyWrapper(new Uint8Array(master));
}

let store: MemoryStore;
let blobs: BlobStore;
let keys: LocalKeyWrapper;
let publicJwk: EcPublicJwk;
let privateJwk: EcPrivateJwk | undefined;
const storeFile = process.env.LOJO_STORE_FILE;
if (storeFile) {
  store = MemoryStore.fromSnapshot(JSON.parse(readFileSync(storeFile, "utf8")));
  blobs = new FsBlobStore(`${storeFile}.blobs`);
  keys = localKeys(`${storeFile}.master.key`);
  publicJwk = JSON.parse(readFileSync(`${storeFile}.public.jwk`, "utf8")) as EcPublicJwk;
} else {
  const identity = await generateIdentity();
  store = new MemoryStore();
  blobs = new MemoryBlobStore();
  keys = new LocalKeyWrapper();
  publicJwk = identity.publicJwk;
  privateJwk = identity.privateJwk;
  await seedDemo({ store, blobs, keys, publicJwk, llm, config, styleGuide });
}

const mailbox = new Mailbox({
  store,
  blobs,
  keys,
  config,
  publicJwk,
  ...(privateJwk ? { privateJwk } : {}),
  llm,
  sender: new MemorySender(),
  styleGuide,
});
const app = createApp({
  mailbox,
  tokens: tokenBookFromEnv(process.env, production),
  sessions: devSessions(process.env, production),
  dev: !production,
  corsOrigin: ["http://127.0.0.1:5173", "http://localhost:5173"],
  info: {
    mailbox: config.mailbox,
    domain: config.domain,
    llmProvider: config.llmProvider,
    dailyTokenBudget: config.dailyTokenBudget,
  },
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: host }, () => {
  console.log(`lojo-mail api http://${host}:${port}${storeFile ? ` (store ${storeFile}, locked)` : " (seeded demo, unlocked)"}`);
  if (!process.env.LOJO_HUMAN_PASSPHRASE) console.log(`web sign-in passphrase (dev default): ${DEV_PASSPHRASE}`);
  if (!production) console.log("local API tokens: dev-only-change-me (read,write), dev-read-only, dev-send-change-me");
});
