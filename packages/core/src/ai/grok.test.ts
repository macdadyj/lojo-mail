import assert from "node:assert/strict";
import test from "node:test";
import { GrokLlm, OllamaLlm, createLlmClient } from "./providers.ts";
import { loadConfig } from "../config.ts";

test("grok client posts to the OpenAI-compatible endpoint", async () => {
  const seen: { url?: string; auth?: string } = {};
  const client = new GrokLlm({
    apiKey: "test-key",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-3-mini",
    fetchImpl: async (url, init) => {
      seen.url = String(url);
      seen.auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "{\"summary\":\"ok\"}" } }],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        }),
        { status: 200 },
      );
    },
  });
  const result = await client.complete({ system: "sys", user: "user", maxTokens: 20 });
  assert.equal(seen.url, "https://api.x.ai/v1/chat/completions");
  assert.equal(seen.auth, "Bearer test-key");
  assert.equal(result.inputTokens, 3);
  assert.match(result.text, /summary/);
});

test("ollama client reads chat and embed payloads", async () => {
  const client = new OllamaLlm({
    baseUrl: "http://100.96.1.90:11434",
    model: "llama3.2:1b",
    embedModel: "nomic-embed-text",
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/embed")) {
        return new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: { content: "hello" }, prompt_eval_count: 2, eval_count: 1 }), { status: 200 });
    },
  });
  const completion = await client.complete({ system: "s", user: "u", maxTokens: 10 });
  assert.equal(completion.text, "hello");
  const embedded = await client.embed("lease");
  assert.deepEqual(embedded.vector, [0.1, 0.2]);
});

test("factory refuses grok without a key and accepts mock", () => {
  const grok = loadConfig({ LOJO_LLM_PROVIDER: "grok" });
  assert.throws(() => createLlmClient(grok));
  const mock = createLlmClient(loadConfig({ LOJO_LLM_PROVIDER: "mock" }));
  assert.equal(mock.name, "mock");
});
