export type Scope = "read" | "write" | "send" | "admin";

export interface Principal {
  label: string;
  scopes: Scope[];
}

export const DEV_TOKEN_VALUES = ["dev-only-change-me", "dev-read-only", "dev-send-change-me"] as const;

function knownScope(value: string): Scope | null {
  switch (value) {
    case "read":
    case "write":
    case "send":
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
    case "admin":
      return scopes.includes(required);
    default: {
      const unexpected: never = required;
      throw new Error(`Unknown scope ${String(unexpected)}`);
    }
  }
}

export class TokenBook {
  private readonly tokens = new Map<string, Principal>();

  constructor(private readonly production: boolean) {}

  add(token: string, principal: Principal): void {
    if (this.production && (DEV_TOKEN_VALUES as readonly string[]).includes(token)) {
      throw new Error(`Refusing to register a well-known dev token in production (${principal.label})`);
    }
    this.tokens.set(token, principal);
  }

  principal(authorization: string | undefined): Principal | null {
    if (!authorization?.startsWith("Bearer ")) return null;
    const token = authorization.slice("Bearer ".length).trim();
    if (!token) return null;
    if (this.production && (DEV_TOKEN_VALUES as readonly string[]).includes(token)) return null;
    return this.tokens.get(token) ?? null;
  }
}

export function tokenBookFromEnv(env: NodeJS.ProcessEnv, production: boolean): TokenBook {
  const book = new TokenBook(production);
  const apiToken = env.LOJO_API_TOKEN ?? (production ? "" : "dev-only-change-me");
  if (apiToken) {
    book.add(apiToken, {
      label: "api",
      scopes: parseScopes(env.LOJO_API_SCOPES, production ? ["read", "write"] : ["read", "write", "send", "admin"]),
    });
  }
  const readToken = env.LOJO_READ_TOKEN ?? (production ? "" : "dev-read-only");
  if (readToken && readToken !== apiToken) {
    book.add(readToken, { label: "read", scopes: ["read"] });
  }
  const sendToken = env.LOJO_SEND_TOKEN ?? (production ? "" : "dev-send-change-me");
  if (sendToken && sendToken !== apiToken) {
    book.add(sendToken, {
      label: "send",
      scopes: parseScopes(env.LOJO_SEND_SCOPES, ["read", "write", "send"]),
    });
  }
  return book;
}
