import { testApp } from "@lojo/api/testing";
import type { WorldOptions } from "@lojo/core/testing";
import { HttpMailClient } from "./http.ts";
import type { Scope } from "./scopes.ts";
import type { ToolContext } from "./tools.ts";

const TOKEN_FOR: Record<string, string> = {
  read: "read-token",
  "read,write": "write-token",
  "read,send,write": "send-token",
  "body,read": "body-token",
  admin: "admin-token",
};

/** An MCP agent wired to the real API over an in-process fetch, holding an API token like it would in production. */
export async function agentWorld(scopes: Scope[], opts: WorldOptions = {}) {
  const api = await testApp(opts);
  const key = [...scopes].sort().join(",");
  const token = TOKEN_FOR[key];
  if (!token) throw new Error(`No test token for scopes ${key}`);
  const client = new HttpMailClient("http://api.test", token, (url, init) => Promise.resolve(api.app.request(url, init)));
  const ctx: ToolContext = { mailbox: client, scopes };
  return { ...api, ctx, token };
}
