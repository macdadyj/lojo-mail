import { readFileSync } from "node:fs";
import { MockLlm } from "./ai/providers.ts";
import { MemoryBlobStore } from "./blob/store.ts";
import { loadConfig } from "./config.ts";
import { generateIdentity } from "./crypto/envelope.ts";
import { LocalKeyWrapper } from "./crypto/server-seal.ts";
import { ingestRaw, type IngestOptions, type IngestResult } from "./ingest.ts";
import { Mailbox, type MailboxDeps, type ReviewedDraft } from "./mailbox.ts";
import { MemorySender } from "./send.ts";
import { MemoryStore } from "./store/memory.ts";
import type { LojoConfig } from "./types.ts";

const REPO = new URL("../../../", import.meta.url);

export const TEST_STYLE = "Sign off with Jon. No corporate filler.";

export function fixture(name: string): Buffer {
  return readFileSync(new URL(`fixtures/emails/${name}`, REPO));
}

export function malicious(name: string): Buffer {
  return readFileSync(new URL(`fixtures/malicious/${name}`, REPO));
}

export interface WorldOptions {
  /** Defaults to true: the dev shape, where the mailbox holds the envelope private key. */
  unlocked?: boolean;
  llm?: MockLlm | null;
  config?: Partial<LojoConfig>;
  now?: () => Date;
  deps?: Pick<MailboxDeps, "ownPgpPublicKey" | "pgpSigningKey">;
}

/** An in-memory mailbox wired the way the API wires it. No AWS, no network. */
export async function memoryWorld(opts: WorldOptions = {}) {
  const { publicJwk, privateJwk } = await generateIdentity();
  const store = new MemoryStore();
  const blobs = new MemoryBlobStore();
  const keys = new LocalKeyWrapper();
  const config: LojoConfig = {
    ...loadConfig({ LOJO_LLM_PROVIDER: "mock", LOJO_DAILY_TOKEN_BUDGET: "100000" }),
    ...opts.config,
  };
  const llm = opts.llm === undefined ? new MockLlm() : opts.llm;
  const sender = new MemorySender();
  const mailbox = new Mailbox({
    store,
    blobs,
    keys,
    config,
    publicJwk,
    ...(opts.unlocked === false ? {} : { privateJwk }),
    llm,
    sender,
    styleGuide: TEST_STYLE,
    ...(opts.now ? { now: opts.now } : {}),
    ...opts.deps,
  });
  const ingest = (raw: Buffer | string, options: IngestOptions = {}, model: MockLlm | null = llm): Promise<IngestResult> =>
    ingestRaw(
      raw,
      { store, blobs, keys, publicJwk, llm: model, config, styleGuide: TEST_STYLE, ...(opts.now ? { now: opts.now() } : {}) },
      options,
    );
  return { publicJwk, privateJwk, store, blobs, keys, config, llm, sender, mailbox, ingest };
}

export type MemoryWorld = Awaited<ReturnType<typeof memoryWorld>>;

/** What the web app sends when Jon approves the draft exactly as it is stored now. */
export async function reviewOf(mailbox: Mailbox, draftId: string): Promise<ReviewedDraft> {
  const { draft, text } = await mailbox.getDraft(draftId, { withText: true });
  return {
    to: draft.to.map((item) => item.email),
    cc: draft.cc.map((item) => item.email),
    subject: draft.subject,
    text: text ?? "",
    pgp: draft.pgp,
  };
}
