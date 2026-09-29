import { randomBytes } from "node:crypto";
import { memoryWorld, type WorldOptions } from "@lojo/core/testing";
import { createApp } from "./app.ts";
import { TokenBook } from "./auth.ts";
import { Sessions, hashPassphrase } from "./session.ts";

export const TEST_PASSPHRASE = "correct horse battery staple";

let cachedHash: string | null = null;

/** The API over an in-memory mailbox, with read/write/send/body tokens and human sign-in. */
export async function testApp(opts: WorldOptions & { dev?: boolean; now?: () => Date } = {}) {
  const world = await memoryWorld(opts);
  cachedHash ??= hashPassphrase(TEST_PASSPHRASE);
  const tokens = new TokenBook(!(opts.dev ?? false));
  tokens.add("read-token", { label: "read", scopes: ["read"] });
  tokens.add("write-token", { label: "write", scopes: ["read", "write"] });
  tokens.add("send-token", { label: "send", scopes: ["read", "write", "send"] });
  tokens.add("body-token", { label: "body", scopes: ["read", "body"] });
  tokens.add("admin-token", { label: "admin", scopes: ["admin"] });
  const sessions = new Sessions({
    secret: randomBytes(32),
    passphraseHash: cachedHash,
    ...(opts.now ? { now: () => (opts.now as () => Date)().getTime() } : {}),
  });
  const app = createApp({
    mailbox: world.mailbox,
    tokens,
    sessions,
    dev: opts.dev ?? false,
    info: { mailbox: world.config.mailbox, domain: world.config.domain, llmProvider: "mock", dailyTokenBudget: world.config.dailyTokenBudget },
  });

  const call = async (path: string, init: { method?: string; token?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = {};
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json: json as Record<string, unknown>, text, headers: res.headers };
  };

  const login = async (): Promise<string> => {
    const res = await call("/v1/session/login", { body: { passphrase: TEST_PASSPHRASE } });
    if (res.status !== 200) throw new Error(`login failed ${res.status} ${res.text}`);
    return String(res.json.sessionToken);
  };

  return { ...world, app, tokens, sessions, call, login };
}
