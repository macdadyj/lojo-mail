/**
 * `compose` lets Jon's own mail client (the local bridge) draft to any address;
 * other tokens may only draft to known correspondents. It never implies send.
 * `trash` is soft delete (restorable for the retention window); Jon grants it
 * per agent token and `admin` does not imply it. The API's `client-send` scope
 * belongs to the Thunderbird bridge alone and is never an MCP scope.
 */
export type Scope = "read" | "write" | "send" | "body" | "compose" | "trash" | "admin";

export function knownScope(value: string): Scope | null {
  switch (value) {
    case "read":
    case "write":
    case "send":
    case "body":
    case "compose":
    case "trash":
    case "admin":
      return value;
    default:
      return null;
  }
}

export function asScope(value: string): Scope {
  const scope = knownScope(value);
  if (!scope) throw new Error(`Unknown scope ${value}`);
  return scope;
}

export function hasScope(scopes: readonly Scope[], required: Scope): boolean {
  switch (required) {
    case "trash":
      return scopes.includes(required);
    case "read":
    case "write":
    case "send":
    case "body":
    case "compose":
    case "admin":
      return scopes.includes("admin") || scopes.includes(required);
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
