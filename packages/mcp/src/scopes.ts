/**
 * `compose` lets Jon's own mail client (the local bridge) draft to any address;
 * other tokens may only draft to known correspondents. It never implies send.
 */
export type Scope = "read" | "write" | "send" | "body" | "compose" | "admin";

export function asScope(value: string): Scope {
  switch (value) {
    case "read":
    case "write":
    case "send":
    case "body":
    case "compose":
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

export function parseScopes(value: string | undefined): Scope[] {
  if (!value) return ["read"];
  const scopes = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => asScope(part));
  return scopes.length > 0 ? scopes : ["read"];
}
