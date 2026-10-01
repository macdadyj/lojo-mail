import { readFileSync } from "node:fs";
import { MockEmbedder } from "./ai/embedders.ts";
import { MockLlm } from "./ai/providers.ts";
import type { Embedder } from "./ai/types.ts";
import { MemoryBlobStore } from "./blob/store.ts";
import { loadConfig } from "./config.ts";
import { generateIdentity } from "./crypto/envelope.ts";
import { LocalKeyWrapper } from "./crypto/server-seal.ts";
import { ingestRaw, type IngestOptions, type IngestResult } from "./ingest.ts";
import { Mailbox, type MailboxDeps, type ReviewedDraft } from "./mailbox.ts";
import { rulesRuntime } from "./rules/engine.ts";
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
  /** Defaults to the mock embedder. Pass null to turn semantic search off. */
  embedder?: Embedder | null;
  config?: Partial<LojoConfig>;
  now?: () => Date;
  deps?: Pick<MailboxDeps, "ownPgpPublicKey" | "pgpSigningKey" | "clientSendLimits" | "agentTrashPerDay">;
  /** Wires `autoSender` into the rules runtime, as LOJO_AUTO_SEND=on does in the processor. */
  autoSend?: boolean;
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
  const embedder = opts.embedder === undefined ? new MockEmbedder() : opts.embedder;
  const sender = new MemorySender();
  const autoSender = new MemorySender();
  const mailbox = new Mailbox({
    store,
    blobs,
    keys,
    config,
    publicJwk,
    ...(opts.unlocked === false ? {} : { privateJwk }),
    llm,
    embedder,
    sender,
    autoSendEnabled: opts.autoSend ?? false,
    styleGuide: TEST_STYLE,
    ...(opts.now ? { now: opts.now } : {}),
    ...opts.deps,
  });
  const ingest = (raw: Buffer | string, options: IngestOptions = {}, model: MockLlm | null = llm): Promise<IngestResult> =>
    ingestRaw(
      raw,
      {
        store,
        blobs,
        keys,
        publicJwk,
        llm: model,
        embedder,
        config,
        styleGuide: TEST_STYLE,
        rules: rulesRuntime(blobs, keys, opts.autoSend ? autoSender : null),
        ...(opts.now ? { now: opts.now() } : {}),
      },
      options,
    );
  return { publicJwk, privateJwk, store, blobs, keys, config, llm, embedder, sender, autoSender, mailbox, ingest };
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
    ...(draft.attachments && draft.attachments.length > 0 ? { attachments: draft.attachments.map((file) => file.sha256) } : {}),
  };
}
