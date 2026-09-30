import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { S3Client } from "@aws-sdk/client-s3";
import {
  createEmbedder,
  createLlmClient,
  DynamoMailStore,
  FsBlobStore,
  generateIdentity,
  loadConfig,
  loadProviderSecrets,
  MemoryStore,
  MockLlm,
  type BlobStore,
  type EcPublicJwk,
  type Embedder,
  type LlmClient,
  type LojoConfig,
  type ProviderSecrets,
  type MailStore,
} from "@lojo/core";
import { documentClient, dynamoLike, S3BlobStore, tableNamesFromEnv } from "@lojo/pipeline/aws";
import { importMailbox, loadFolderMap } from "./import-mailbox.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function analyzer(config: LojoConfig, secrets: ProviderSecrets): LlmClient {
  if (config.llmProvider === "mock") return new MockLlm();
  try {
    return createLlmClient(config, secrets);
  } catch (error) {
    console.error(`--analyze: ${error instanceof Error ? error.message : String(error)}. Using the mock model.`);
    return new MockLlm();
  }
}

function embedderOrNull(config: LojoConfig, secrets: ProviderSecrets): Embedder | null {
  try {
    return createEmbedder(config, secrets);
  } catch (error) {
    console.error(`--embed: ${error instanceof Error ? error.message : String(error)}. Importing without vectors.`);
    return null;
  }
}

function readPublicKey(path: string): EcPublicJwk {
  const jwk = JSON.parse(readFileSync(path, "utf8")) as EcPublicJwk & { d?: string };
  if (jwk.d !== undefined) fail(`${path} contains a private key. Pass the public JWK only.`);
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) fail(`${path} is not a P-256 public JWK`);
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    contacts: { type: "string" },
    map: { type: "string", default: "config/tuta-folder-map.json" },
    store: { type: "string", default: "data/mailbox.json" },
    target: { type: "string" },
    analyze: { type: "boolean", default: false },
    embed: { type: "boolean", default: false },
    "public-key": { type: "string" },
  },
});

if (!values.input) {
  fail(
    "usage: npm run import -- --input imports/tuta [--contacts contacts.vcf] [--store data/mailbox.json] [--analyze] [--embed]\n" +
      "       npm run import -- --target aws --input imports/tuta --public-key keys/envelope.public.jwk",
  );
}

const target = values.target ?? (process.env.LOJO_STORE === "dynamo" ? "aws" : "local");
if (target !== "local" && target !== "aws") fail(`--target must be local or aws, not ${target}`);
const config = loadConfig();
const secrets = await loadProviderSecrets(config, process.env);

let store: MailStore;
let blobs: BlobStore;
let publicJwk: EcPublicJwk;
let save: () => void = () => undefined;

if (target === "aws") {
  const bucket = process.env.LOJO_BUCKET;
  if (!bucket) fail("--target aws needs LOJO_BUCKET (terraform output bucket) and AWS credentials in the environment.");
  if (!values["public-key"]) fail("--target aws needs --public-key with the envelope public JWK that is in SSM.");
  publicJwk = readPublicKey(values["public-key"]);
  store = new DynamoMailStore(dynamoLike(documentClient()), tableNamesFromEnv());
  blobs = new S3BlobStore(new S3Client({ region: config.region }), bucket);
  console.error(`Importing into DynamoDB (${tableNamesFromEnv().messages}) and s3://${bucket}/objects/`);
} else {
  const storePath = values.store ?? "data/mailbox.json";
  mkdirSync(dirname(storePath), { recursive: true });
  const memory = existsSync(storePath) ? MemoryStore.fromSnapshot(JSON.parse(readFileSync(storePath, "utf8"))) : new MemoryStore();
  store = memory;
  blobs = new FsBlobStore(`${storePath}.blobs`);
  save = () => writeFileSync(storePath, `${JSON.stringify(memory.snapshot())}\n`, { mode: 0o600 });
  const publicPath = values["public-key"] ?? `${storePath}.public.jwk`;
  const privatePath = `${storePath}.private.jwk`;
  if (resolve(publicPath) === resolve(privatePath)) fail("--public-key must not be the private key path");
  if (existsSync(publicPath)) {
    publicJwk = readPublicKey(publicPath);
  } else {
    if (existsSync(privatePath)) fail(`${privatePath} exists but ${publicPath} does not. Refusing to replace the keypair.`);
    const generated = await generateIdentity();
    publicJwk = generated.publicJwk;
    mkdirSync(dirname(publicPath), { recursive: true });
    writeFileSync(publicPath, `${JSON.stringify(generated.publicJwk, null, 2)}\n`);
    writeFileSync(privatePath, `${JSON.stringify(generated.privateJwk, null, 2)}\n`, { mode: 0o600 });
    console.error(`Generated an envelope keypair: public ${publicPath}, private ${privatePath}. Keep the private file out of git.`);
  }
}

const folderMap = existsSync(values.map ?? "") ? loadFolderMap(readFileSync(values.map ?? "", "utf8")) : {};
const report = await importMailbox({
  input: values.input,
  contactsPath: values.contacts,
  folderMap,
  deps: {
    store,
    blobs,
    publicJwk,
    llm: values.analyze ? analyzer(config, secrets) : null,
    embedder: values.embed ? embedderOrNull(config, secrets) : null,
    config,
    styleGuide: existsSync("config/style-guide.md") ? readFileSync("config/style-guide.md", "utf8") : "",
  },
});
save();
console.log(JSON.stringify(report, null, 2));
if (report.errors.length > 0) process.exit(1);
