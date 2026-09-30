import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import test from "node:test";
import { ConverseCommand, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { loadConfig } from "../config.ts";
import { BedrockTitanEmbedder, createEmbedder, GoogleEmbedder, OllamaEmbedder, OpenAiCompatibleEmbedder } from "./embedders.ts";
import { ServiceAccountTokens } from "./google-auth.ts";
import { BedrockLlm, createLlmClient, GeminiLlm, OpenAiCompatibleLlm } from "./providers.ts";
import { loadProviderSecrets } from "./secrets.ts";

interface Seen {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function recorder(reply: (url: string) => unknown, status = 200) {
  const seen: Seen[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    seen.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify(reply(url)), { status });
  };
  return { seen, fetchImpl };
}

test("the OpenAI-compatible client works without a key for local servers and sends one when given", async () => {
  const { seen, fetchImpl } = recorder(() => ({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
  const local = new OpenAiCompatibleLlm({ baseUrl: "http://127.0.0.1:8080/v1/", model: "qwen", fetchImpl });
  const result = await local.complete({ system: "s", user: "u", maxTokens: 10 });
  assert.equal(result.text, "ok");
  assert.equal(seen[0]?.url, "http://127.0.0.1:8080/v1/chat/completions");
  assert.equal(seen[0]?.headers.get("authorization"), null);
  assert.equal(local.name, "openai");

  const hosted = new OpenAiCompatibleLlm({ baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-nano", apiKey: "sk-test", fetchImpl });
  await hosted.complete({ system: "s", user: "u", maxTokens: 10 });
  assert.equal(seen[1]?.headers.get("authorization"), "Bearer sk-test");
  assert.equal(seen[1]?.body.model, "gpt-4.1-nano");
});

test("provider errors carry the status, never the response body", async () => {
  const { fetchImpl } = recorder(() => ({ error: "prompt echo: SECRET-LEASE-TEXT" }), 429);
  const client = new OpenAiCompatibleLlm({ baseUrl: "https://example.test/v1", model: "m", fetchImpl });
  await assert.rejects(client.complete({ system: "s", user: "u", maxTokens: 1 }), (error: Error) => {
    assert.match(error.message, /429/);
    assert.doesNotMatch(error.message, /SECRET-LEASE-TEXT/);
    return true;
  });
});

test("Gemini API calls generateContent with the key in a header, not the URL", async () => {
  const { seen, fetchImpl } = recorder(() => ({
    candidates: [{ content: { parts: [{ text: "hel" }, { text: "lo" }] } }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
  }));
  const client = new GeminiLlm({ model: "gemini-2.5-flash-lite", endpoint: { kind: "studio", apiKey: "AIza-test" }, fetchImpl });
  const result = await client.complete({ system: "sys", user: "hi", maxTokens: 50 });
  assert.equal(result.text, "hello");
  assert.equal(result.inputTokens, 7);
  assert.equal(seen[0]?.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent");
  assert.equal(seen[0]?.headers.get("x-goog-api-key"), "AIza-test");
  assert.deepEqual(seen[0]?.body.systemInstruction, { parts: [{ text: "sys" }] });
  assert.equal(client.name, "gemini");
});

test("Vertex with a service account signs a JWT, exchanges it once, and calls the regional endpoint", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const calls: string[] = [];
  let assertion = "";
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push(url);
    if (url === "https://oauth2.googleapis.com/token") {
      assertion = new URLSearchParams(String(init.body)).get("assertion") ?? "";
      return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), { status: 200 });
    }
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer ya29.test");
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
  };
  const secrets = { vertexServiceAccount: JSON.stringify({ client_email: "lojo@proj.iam.gserviceaccount.com", private_key: pem }) };
  const config = loadConfig({ LOJO_LLM_PROVIDER: "vertex", LOJO_VERTEX_PROJECT: "proj-1", LOJO_VERTEX_LOCATION: "us-central1" });
  const client = createLlmClient(config, secrets, fetchImpl);
  await client.complete({ system: "s", user: "u", maxTokens: 5 });
  await client.complete({ system: "s", user: "u", maxTokens: 5 });
  assert.deepEqual(calls, [
    "https://oauth2.googleapis.com/token",
    "https://us-central1-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1/publishers/google/models/gemini-2.5-flash-lite:generateContent",
    "https://us-central1-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1/publishers/google/models/gemini-2.5-flash-lite:generateContent",
  ]);
  const [header, claims, signature] = assertion.split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${claims}`);
  assert.ok(verifier.verify(publicKey, Buffer.from(signature ?? "", "base64url")));
  const decoded = JSON.parse(Buffer.from(claims ?? "", "base64url").toString()) as { iss: string; aud: string; scope: string };
  assert.equal(decoded.iss, "lojo@proj.iam.gserviceaccount.com");
  assert.equal(decoded.aud, "https://oauth2.googleapis.com/token");
  assert.equal(client.name, "vertex");
});

test("a service account key cannot redirect the signed assertion to another token endpoint", () => {
  assert.throws(
    () => new ServiceAccountTokens({ client_email: "a@b", private_key: "x", token_uri: "https://evil.example/token" }),
    /Refusing token_uri/,
  );
});

test("Vertex express mode uses the global endpoint with an API key", async () => {
  const { seen, fetchImpl } = recorder(() => ({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
  const client = createLlmClient(loadConfig({ LOJO_LLM_PROVIDER: "vertex" }), { geminiApiKey: "express-key" }, fetchImpl);
  await client.complete({ system: "s", user: "u", maxTokens: 5 });
  assert.equal(seen[0]?.url, "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash-lite:generateContent");
  assert.equal(seen[0]?.headers.get("x-goog-api-key"), "express-key");
});

test("Bedrock Converse serves Nova, Claude Haiku, and Llama with one request shape", async () => {
  for (const modelId of ["us.amazon.nova-micro-v1:0", "us.anthropic.claude-haiku-4-5-20251001-v1:0", "us.meta.llama3-2-1b-instruct-v1:0"]) {
    const sent: unknown[] = [];
    const client = {
      send: async (command: unknown) => {
        sent.push(command);
        return { output: { message: { content: [{ text: `hi from ${modelId}` }] } }, usage: { inputTokens: 3, outputTokens: 4 } };
      },
    };
    const llm = new BedrockLlm({ region: "us-east-1", modelId, client: client as never });
    const result = await llm.complete({ system: "s", user: "u", maxTokens: 10 });
    assert.equal(result.text, `hi from ${modelId}`);
    assert.ok(sent[0] instanceof ConverseCommand);
    assert.equal((sent[0] as ConverseCommand).input.modelId, modelId);
  }
});

test("each provider refuses to start without its credential", () => {
  assert.throws(() => createLlmClient(loadConfig({ LOJO_LLM_PROVIDER: "grok" })), /Grok/);
  assert.throws(() => createLlmClient(loadConfig({ LOJO_LLM_PROVIDER: "gemini" })), /Gemini/);
  assert.throws(() => createLlmClient(loadConfig({ LOJO_LLM_PROVIDER: "vertex" })), /Vertex/);
  assert.throws(
    () => createLlmClient(loadConfig({ LOJO_LLM_PROVIDER: "vertex" }), { vertexServiceAccount: JSON.stringify({ client_email: "a", private_key: "b" }) }),
    /LOJO_VERTEX_PROJECT/,
  );
  assert.equal(createLlmClient(loadConfig({ LOJO_LLM_PROVIDER: "openai" })).name, "openai");
  assert.equal(createLlmClient(loadConfig({ LOJO_LLM_PROVIDER: "ollama" })).name, "ollama");
});

test("nomic embeddings get task prefixes; the legacy endpoint is only tried on 404", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const embedder = new OllamaEmbedder({
    baseUrl: "http://100.96.1.90:11434",
    model: "nomic-embed-text",
    dimensions: 256,
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (url.endsWith("/api/embed")) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 });
    },
  });
  const result = await embedder.embed("lease", "query");
  assert.deepEqual(result.vector, [0.1, 0.2]);
  assert.equal(bodies[0]?.input, "search_query: lease");
  assert.equal(bodies[1]?.prompt, "search_query: lease");

  const failing = new OllamaEmbedder({
    baseUrl: "http://x",
    model: "nomic-embed-text",
    dimensions: 256,
    fetchImpl: async () => new Response("boom", { status: 500 }),
  });
  await assert.rejects(failing.embed("x", "document"), /500/);
});

test("Titan v2 embeddings request the configured size and normalization", async () => {
  const sent: InvokeModelCommand[] = [];
  const client = {
    send: async (command: InvokeModelCommand) => {
      sent.push(command);
      return { body: new TextEncoder().encode(JSON.stringify({ embedding: [0.5, 0.5], inputTextTokenCount: 9 })) };
    },
  };
  const embedder = new BedrockTitanEmbedder({ region: "us-east-1", modelId: "amazon.titan-embed-text-v2:0", dimensions: 256, client: client as never });
  const result = await embedder.embed("hello");
  assert.equal(result.tokens, 9);
  assert.deepEqual(JSON.parse(String(sent[0]?.input.body)), { inputText: "hello", dimensions: 256, normalize: true });
  assert.throws(() => new BedrockTitanEmbedder({ region: "us-east-1", modelId: "amazon.titan-embed-text-v2:0", dimensions: 300 }), /256, 512, 1024/);
});

test("Gemini embeddings use embedContent with task types; Vertex uses predict", async () => {
  const { seen, fetchImpl } = recorder((url) =>
    url.endsWith(":embedContent") ? { embedding: { values: [1, 0] } } : { predictions: [{ embeddings: { values: [0, 1], statistics: { token_count: 4 } } }] },
  );
  const studio = new GoogleEmbedder({ model: "gemini-embedding-001", dimensions: 256, endpoint: { kind: "studio", apiKey: "k" }, fetchImpl });
  assert.deepEqual((await studio.embed("q", "query")).vector, [1, 0]);
  assert.equal(seen[0]?.body.taskType, "RETRIEVAL_QUERY");
  assert.equal(seen[0]?.body.outputDimensionality, 256);

  const vertex = new GoogleEmbedder({ model: "text-embedding-005", dimensions: 256, endpoint: { kind: "vertex-express", apiKey: "k" }, fetchImpl });
  const result = await vertex.embed("doc", "document");
  assert.deepEqual(result.vector, [0, 1]);
  assert.equal(result.tokens, 4);
  assert.match(seen[1]?.url ?? "", /text-embedding-005:predict$/);
  assert.deepEqual(seen[1]?.body.instances, [{ content: "doc", task_type: "RETRIEVAL_DOCUMENT" }]);
});

test("OpenAI-compatible embeddings read data[0]", async () => {
  const { seen, fetchImpl } = recorder(() => ({ data: [{ embedding: [0.3, 0.4] }], usage: { prompt_tokens: 2 } }));
  const embedder = new OpenAiCompatibleEmbedder({ baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", dimensions: 256, apiKey: "sk", fetchImpl });
  const result = await embedder.embed("x");
  assert.deepEqual(result.vector, [0.3, 0.4]);
  assert.equal(seen[0]?.url, "https://api.openai.com/v1/embeddings");
});

test("embedder selection follows the config and defaults to local Ollama", () => {
  assert.equal(createEmbedder(loadConfig({ LOJO_LLM_PROVIDER: "grok" }))?.name, "ollama");
  assert.equal(createEmbedder(loadConfig({ LOJO_LLM_PROVIDER: "mock" }))?.name, "mock");
  assert.equal(createEmbedder(loadConfig({ LOJO_LLM_PROVIDER: "grok", LOJO_EMBED_PROVIDER: "none" })), null);
  assert.equal(createEmbedder(loadConfig({ LOJO_EMBED_PROVIDER: "bedrock" }))?.name, "bedrock");
  assert.throws(() => loadConfig({ LOJO_EMBED_PROVIDER: "opensearch" }), /LOJO_EMBED_PROVIDER/);
  assert.throws(() => loadConfig({ LOJO_EMBED_DIMENSIONS: "12.5" }), /whole number/);
});

test("secrets are read only for the selected providers, env first, then SSM", async () => {
  const asked: string[] = [];
  const read = async (name: string) => {
    asked.push(name);
    return `from-ssm:${name}`;
  };
  const env = {
    LOJO_GROK_KEY_PARAM: "/lojo-mail/grok-api-key",
    LOJO_OPENAI_KEY_PARAM: "/lojo-mail/openai-api-key",
    LOJO_GEMINI_KEY_PARAM: "/lojo-mail/gemini-api-key",
  };
  const secrets = await loadProviderSecrets({ llmProvider: "grok", embedProvider: "gemini" }, env, read);
  assert.deepEqual(asked.sort(), ["/lojo-mail/gemini-api-key", "/lojo-mail/grok-api-key"]);
  assert.equal(secrets.grokApiKey, "from-ssm:/lojo-mail/grok-api-key");
  assert.equal(secrets.openaiApiKey, undefined);

  const fromEnv = await loadProviderSecrets({ llmProvider: "openai", embedProvider: "none" }, { ...env, LOJO_OPENAI_API_KEY: "sk-env" }, read);
  assert.equal(fromEnv.openaiApiKey, "sk-env");
  assert.equal(asked.length, 2);
});
