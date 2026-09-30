import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import {
  createEmbedder,
  createLlmClient,
  DynamoMailStore,
  loadConfig,
  loadProviderSecrets,
  Mailbox,
  type EcPublicJwk,
  type Embedder,
  type LlmClient,
} from "@lojo/core";
import { documentClient, dynamoLike, KmsKeyWrapper, S3BlobStore, tableNamesFromEnv, ttlCache } from "@lojo/pipeline/aws";
import { getConnInfo, handle } from "hono/aws-lambda";
import styleGuide from "../../../config/style-guide.md";
import { createApp } from "./app.ts";
import { TokenBook, parseAgentTokens, parseScopes } from "./auth.ts";
import { LoginThrottle, Sessions } from "./session.ts";
import { SesSender } from "./ses.ts";

const ssm = new SSMClient({});

/** Missing optional parameters are undefined; any other SSM error fails the boot so it is retried. */
async function parameter(name: string): Promise<string | undefined> {
  try {
    const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return out.Parameter?.Value;
  } catch (error) {
    if (error instanceof Error && error.name === "ParameterNotFound") return undefined;
    throw error;
  }
}

async function required(name: string): Promise<string> {
  const value = await parameter(name);
  if (!value) throw new Error(`SSM parameter ${name} is missing`);
  return value;
}

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

async function buildApp() {
  const config = loadConfig();
  const publicJwk = JSON.parse(await required(env("LOJO_PUBLIC_KEY_PARAM", "/lojo-mail/envelope-public-jwk"))) as EcPublicJwk;
  const tokens = new TokenBook(true);
  tokens.add(await required(env("LOJO_API_TOKEN_PARAM", "/lojo-mail/api-token")), {
    label: "api",
    scopes: parseScopes(process.env.LOJO_API_SCOPES, ["read", "write"]),
  });
  const sendToken = await parameter(env("LOJO_SEND_TOKEN_PARAM", "/lojo-mail/api-token-send"));
  if (sendToken) tokens.add(sendToken, { label: "send", scopes: parseScopes(process.env.LOJO_SEND_SCOPES, ["read", "write", "send"]) });
  const agentTokens = await parameter(env("LOJO_AGENT_TOKENS_PARAM", "/lojo-mail/agent-tokens"));
  if (agentTokens) {
    for (const agent of parseAgentTokens(agentTokens, true)) tokens.add(agent.token, { label: agent.label, scopes: agent.scopes });
  }

  const secret = await parameter(env("LOJO_SESSION_SECRET_PARAM", "/lojo-mail/session-secret"));
  const passphraseHash = await parameter(env("LOJO_PASSPHRASE_HASH_PARAM", "/lojo-mail/human-passphrase-hash"));
  const sessions = secret && passphraseHash ? new Sessions({ secret: Buffer.from(secret, "utf8"), passphraseHash }) : null;
  if (!sessions) console.error("Human sign-in is disabled: session secret or passphrase hash parameter is missing");

  const secrets = await loadProviderSecrets(config, process.env, parameter);
  let llm: LlmClient | null = null;
  try {
    llm = createLlmClient(config, secrets);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
  let embedder: Embedder | null = null;
  try {
    embedder = createEmbedder(config, secrets);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }

  const bucket = process.env.LOJO_BUCKET;
  const keyId = process.env.LOJO_KMS_KEY_ID;
  if (!bucket || !keyId) throw new Error("LOJO_BUCKET and LOJO_KMS_KEY_ID are required");
  const ownPgpPublicKey = await parameter(env("LOJO_PGP_PUBLIC_KEY_PARAM", "/lojo-mail/pgp-public-key"));
  const signingKey = await parameter(env("LOJO_PGP_SIGNING_KEY_PARAM", "/lojo-mail/pgp-signing-key"));
  const signingPassphrase = await parameter(env("LOJO_PGP_SIGNING_PASSPHRASE_PARAM", "/lojo-mail/pgp-signing-passphrase"));

  const store = new DynamoMailStore(dynamoLike(documentClient()), tableNamesFromEnv());
  const mailbox = new Mailbox({
    store,
    blobs: new S3BlobStore(new S3Client({}), bucket),
    keys: new KmsKeyWrapper(new KMSClient({}), keyId),
    config,
    publicJwk,
    llm,
    embedder,
    sender: SesSender.fromEnv(),
    styleGuide: process.env.LOJO_STYLE_GUIDE ?? styleGuide,
    ...(ownPgpPublicKey ? { ownPgpPublicKey } : {}),
    ...(signingKey ? { pgpSigningKey: { armoredKey: signingKey, ...(signingPassphrase ? { passphrase: signingPassphrase } : {}) } } : {}),
  });
  return createApp({
    mailbox,
    tokens,
    sessions,
    // The login-failure alarm is a CloudWatch metric filter on this line.
    loginThrottle: new LoginThrottle(store, { onFailure: (source) => console.warn(JSON.stringify({ event: "login_failed", source })) }),
    clientAddress: (c) => getConnInfo(c).remote.address,
    accessLog: (entry) => console.log(JSON.stringify({ event: "api_request", ...entry })),
    dev: false,
    info: {
      mailbox: config.mailbox,
      domain: config.domain,
      llmProvider: config.llmProvider,
      embedProvider: config.embedProvider,
      dailyTokenBudget: config.dailyTokenBudget,
    },
  });
}

const app = ttlCache(Number(process.env.LOJO_CONFIG_TTL_MS ?? 5 * 60 * 1000), buildApp);

export async function handler(event: unknown, context: unknown): Promise<unknown> {
  const built = await app.get();
  return handle(built)(event as Parameters<ReturnType<typeof handle>>[0], context as Parameters<ReturnType<typeof handle>>[1]);
}
