import { createLlmClient, DynamoMailStore, loadConfig, Mailbox, type EcPublicJwk, type LlmClient } from "@lojo/core";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { handle } from "hono/aws-lambda";
import { documentClient, dynamoLike, tableNamesFromEnv } from "@lojo/pipeline/dynamo";
import styleGuide from "../../../config/style-guide.md";
import { createApp } from "./app.ts";
import { TokenBook, parseScopes } from "./auth.ts";
import { SesSender } from "./ses.ts";

const ssm = new SSMClient({});

async function parameter(name: string | undefined): Promise<string | undefined> {
  if (!name) return undefined;
  const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  return out.Parameter?.Value;
}

async function buildApp() {
  const config = loadConfig();
  const publicRaw = await parameter(process.env.LOJO_PUBLIC_KEY_PARAM ?? "/lojo-mail/envelope-public-jwk");
  if (!publicRaw) throw new Error("Envelope public key parameter is missing");
  const publicJwk = JSON.parse(publicRaw) as EcPublicJwk;
  const apiToken = await parameter(process.env.LOJO_API_TOKEN_PARAM ?? "/lojo-mail/api-token");
  if (!apiToken) throw new Error("API token parameter is missing");
  const tokens = new TokenBook(true);
  tokens.add(apiToken, { label: "api", scopes: parseScopes(process.env.LOJO_API_SCOPES, ["read", "write"]) });
  const sendToken = await parameter(process.env.LOJO_SEND_TOKEN_PARAM ?? "/lojo-mail/api-token-send");
  if (sendToken) tokens.add(sendToken, { label: "send", scopes: parseScopes(process.env.LOJO_SEND_SCOPES, ["read", "write", "send"]) });
  let llm: LlmClient | null = null;
  try {
    const grokApiKey = process.env.LOJO_GROK_API_KEY ?? (await parameter(process.env.LOJO_GROK_KEY_PARAM));
    llm = createLlmClient(config, { grokApiKey });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
  const mailbox = new Mailbox({
    store: new DynamoMailStore(dynamoLike(documentClient()), tableNamesFromEnv()),
    config,
    publicJwk,
    llm,
    sender: SesSender.fromEnv(),
    styleGuide: process.env.LOJO_STYLE_GUIDE ?? styleGuide,
  });
  return createApp({
    mailbox,
    tokens,
    dev: false,
    info: {
      mailbox: config.mailbox,
      domain: config.domain,
      llmProvider: config.llmProvider,
      dailyTokenBudget: config.dailyTokenBudget,
    },
  });
}

let appPromise: ReturnType<typeof buildApp> | null = null;

export async function handler(event: unknown, context: unknown): Promise<unknown> {
  if (!appPromise) appPromise = buildApp();
  const app = await appPromise;
  return handle(app)(event as Parameters<ReturnType<typeof handle>>[0], context as Parameters<ReturnType<typeof handle>>[1]);
}
