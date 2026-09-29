export type Scope = "read" | "write" | "send" | "admin";

export function asScope(value: string): Scope {
  switch (value) {
    case "read":
    case "write":
    case "send":
    case "admin":
      return value;
    default:
      throw new Error(`Unknown scope ${value}`);
  }
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

export function parseScopes(value: string | undefined): Scope[] {
  if (!value) return ["read"];
  const scopes: Scope[] = [];
  for (const part of value.split(",")) {
    const token = part.trim();
    if (!token) continue;
    switch (token) {
      case "read":
      case "write":
      case "send":
      case "admin":
        scopes.push(token);
        break;
      default:
        throw new Error(`Unknown scope ${token}`);
    }
  }
  return scopes.length > 0 ? scopes : ["read"];
}
