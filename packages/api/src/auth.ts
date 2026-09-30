import type { Sessions } from "./session.ts";

/**
 * `compose` lets Jon's own mail client (the local bridge) draft to any address;
 * other tokens may only draft to known correspondents. It never implies send.
 */
export type Scope = "read" | "write" | "send" | "body" | "compose" | "admin";

export type PrincipalKind = "token" | "human";

export interface Principal {
  kind: PrincipalKind;
  label: string;
  scopes: Scope[];
}

export const DEV_TOKEN_VALUES = ["dev-only-change-me", "dev-read-only", "dev-send-change-me", "dev-bridge-change-me"] as const;

/** The Thunderbird bridge: reads and decrypts locally, syncs flags and moves, and turns SMTP submissions into drafts. */
export const BRIDGE_SCOPES: readonly Scope[] = ["read", "write", "body", "compose"];

/** Prefixes reserved for human sessions and approval tokens. An API token can never look like either. */
const RESERVED_PREFIXES = ["hs_", "apv_"] as const;

function knownScope(value: string): Scope | null {
  switch (value) {
    case "read":
    case "write":
    case "send":
    case "body":
    case "compose":
    case "admin":
      return value;
    default:
      return null;
  }
}

export function parseScopes(value: string | undefined, fallback: Scope[]): Scope[] {
  if (!value) return fallback;
  const scopes: Scope[] = [];
  for (const part of value.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const scope = knownScope(token);
    if (!scope) throw new Error(`Unknown scope ${token}`);
    scopes.push(scope);
  }
  return scopes.length > 0 ? scopes : fallback;
}

export function hasScope(scopes: readonly Scope[], required: Scope): boolean {
  if (scopes.includes("admin")) return true;
  switch (required) {
    case "read":
    case "write":
    case "send":
    case "body":
    case "compose":
    case "admin":
      return scopes.includes(required);
    default: {
      const unexpected: never = required;
      throw new Error(`Unknown scope ${String(unexpected)}`);
    }
  }
}

export const HUMAN: Principal = { kind: "human", label: "jon", scopes: ["admin"] };

export class TokenBook {
  private readonly tokens = new Map<string, Principal>();

  constructor(private readonly production: boolean) {}

  add(token: string, principal: Omit<Principal, "kind">): void {
    if (this.production && (DEV_TOKEN_VALUES as readonly string[]).includes(token)) {
      throw new Error(`Refusing to register a well-known dev token in production (${principal.label})`);
    }
    if (RESERVED_PREFIXES.some((prefix) => token.startsWith(prefix))) {
      throw new Error(`API token for ${principal.label} uses a reserved prefix`);
    }
    this.tokens.set(token, { ...principal, kind: "token" });
  }

  principal(authorization: string | undefined, sessions?: Sessions | null): Principal | null {
    if (!authorization?.startsWith("Bearer ")) return null;
    const token = authorization.slice("Bearer ".length).trim();
    if (!token) return null;
    if (token.startsWith("hs_")) return sessions?.verify(token) ? HUMAN : null;
    if (this.production && (DEV_TOKEN_VALUES as readonly string[]).includes(token)) return null;
    return this.tokens.get(token) ?? null;
  }
}

export interface AgentToken {
  label: string;
  token: string;
  scopes: Scope[];
}

const AGENT_SCOPES: readonly Scope[] = ["read", "write", "body"];
const MIN_AGENT_TOKEN_CHARS = 32;

/**
 * Extra tokens for assistants (Cursor, Grok, a local model), one per client so
 * each can be revoked alone. JSON: `[{ "label": "grok", "token": "...", "scopes": ["read"] }]`.
 * send and admin are refused here: sending needs Jon's approval token, and admin
 * implies send.
 */
/**
 * A malformed agent-token list disables every agent token and keeps the API up,
 * so a typo in one entry cannot lock Jon out of the web app.
 */
export function agentTokensOrNone(json: string | undefined, production: boolean, warn: (message: string) => void): AgentToken[] {
  if (!json) return [];
  try {
    return parseAgentTokens(json, production);
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return [];
  }
}

export function parseAgentTokens(json: string, production: boolean): AgentToken[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("agent tokens must be a JSON array");
  }
  if (!Array.isArray(parsed)) throw new Error("agent tokens must be a JSON array");
  const labels = new Set<string>();
  return parsed.map((entry: unknown, index) => {
    const item = (entry ?? {}) as Partial<{ label: unknown; token: unknown; scopes: unknown }>;
    if (typeof item.label !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(item.label)) {
      throw new Error(`agent token ${index}: label must be 1-32 lowercase letters, digits, or dashes`);
    }
    if (labels.has(item.label)) throw new Error(`agent token ${item.label}: duplicate label`);
    labels.add(item.label);
    if (typeof item.token !== "string" || (production && item.token.length < MIN_AGENT_TOKEN_CHARS)) {
      throw new Error(`agent token ${item.label}: token must be a string of at least ${MIN_AGENT_TOKEN_CHARS} characters`);
    }
    if (!Array.isArray(item.scopes) || item.scopes.length === 0 || !item.scopes.every((scope) => typeof scope === "string")) {
      throw new Error(`agent token ${item.label}: scopes must be a non-empty array`);
    }
    const scopes = item.scopes.map((scope: string) => {
      const known = knownScope(scope);
      if (!known) throw new Error(`agent token ${item.label}: unknown scope ${scope}`);
      if (!AGENT_SCOPES.includes(known)) throw new Error(`agent token ${item.label}: scope ${known} is not allowed for agents`);
      return known;
    });
    return { label: `agent:${item.label}`, token: item.token, scopes };
  });
}

export function tokenBookFromEnv(env: NodeJS.ProcessEnv, production: boolean): TokenBook {
  const book = new TokenBook(production);
  const apiToken = env.LOJO_API_TOKEN ?? (production ? "" : "dev-only-change-me");
  if (apiToken) {
    book.add(apiToken, { label: "api", scopes: parseScopes(env.LOJO_API_SCOPES, ["read", "write"]) });
  }
  const readToken = env.LOJO_READ_TOKEN ?? (production ? "" : "dev-read-only");
  if (readToken && readToken !== apiToken) {
    book.add(readToken, { label: "read", scopes: ["read"] });
  }
  const sendToken = env.LOJO_SEND_TOKEN ?? (production ? "" : "dev-send-change-me");
  if (sendToken && sendToken !== apiToken) {
    book.add(sendToken, { label: "send", scopes: parseScopes(env.LOJO_SEND_SCOPES, ["read", "write", "send"]) });
  }
  if (env.LOJO_AGENT_TOKENS) {
    for (const agent of parseAgentTokens(env.LOJO_AGENT_TOKENS, production)) book.add(agent.token, { label: agent.label, scopes: agent.scopes });
  }
  const bridgeToken = env.LOJO_BRIDGE_TOKEN ?? (production ? "" : "dev-bridge-change-me");
  if (bridgeToken) addBridgeToken(book, bridgeToken, production);
  return book;
}

/** The bridge token always has exactly BRIDGE_SCOPES: never send, never admin. */
export function addBridgeToken(book: TokenBook, token: string, production: boolean): void {
  if (production && token.length < MIN_AGENT_TOKEN_CHARS) {
    throw new Error(`The bridge token must be at least ${MIN_AGENT_TOKEN_CHARS} characters`);
  }
  book.add(token, { label: "bridge", scopes: [...BRIDGE_SCOPES] });
}
