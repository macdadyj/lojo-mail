import { createSign } from "node:crypto";
import { trimSlash, type FetchLike } from "./http.ts";

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function parseServiceAccount(json: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Vertex service account key is not JSON");
  }
  const key = parsed as Partial<ServiceAccountKey>;
  if (typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    throw new Error("Vertex service account key needs client_email and private_key");
  }
  return { client_email: key.client_email, private_key: key.private_key, ...(key.token_uri ? { token_uri: key.token_uri } : {}) };
}

/**
 * OAuth access tokens for a Google service account (JWT bearer grant), cached
 * until a minute before expiry. The token endpoint is pinned to Google's so a
 * tampered key file cannot post a signed assertion elsewhere.
 */
export class ServiceAccountTokens {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly key: ServiceAccountKey,
    private readonly opts: { fetchImpl?: FetchLike; now?: () => number } = {},
  ) {
    const uri = trimSlash(key.token_uri ?? GOOGLE_TOKEN_URI);
    if (uri !== GOOGLE_TOKEN_URI) throw new Error(`Refusing token_uri ${uri}; only ${GOOGLE_TOKEN_URI} is allowed`);
  }

  async token(): Promise<string> {
    const now = this.opts.now?.() ?? Date.now();
    if (this.cached && this.cached.expiresAt - 60_000 > now) return this.cached.token;
    const iat = Math.floor(now / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({ iss: this.key.client_email, scope: SCOPE, aud: GOOGLE_TOKEN_URI, iat, exp: iat + 3600 }));
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const assertion = `${header}.${claims}.${b64url(signer.sign(this.key.private_key))}`;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const response = await fetchImpl(GOOGLE_TOKEN_URI, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Google token exchange failed (${response.status})`);
    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) throw new Error("Google token exchange returned no access_token");
    this.cached = { token: payload.access_token, expiresAt: now + (payload.expires_in ?? 3600) * 1000 };
    return payload.access_token;
  }
}

/** Where a Gemini-family request goes and how it is authorized. */
export type GoogleEndpoint =
  | { kind: "studio"; apiKey: string }
  | { kind: "vertex-express"; apiKey: string }
  | { kind: "vertex"; project: string; location: string; tokens: Pick<ServiceAccountTokens, "token"> };

export function googleModelUrl(endpoint: GoogleEndpoint, model: string, method: string): string {
  const name = encodeURIComponent(model);
  switch (endpoint.kind) {
    case "studio":
      return `https://generativelanguage.googleapis.com/v1beta/models/${name}:${method}`;
    case "vertex-express":
      return `https://aiplatform.googleapis.com/v1/publishers/google/models/${name}:${method}`;
    case "vertex": {
      const host = endpoint.location === "global" ? "aiplatform.googleapis.com" : `${endpoint.location}-aiplatform.googleapis.com`;
      const project = encodeURIComponent(endpoint.project);
      const location = encodeURIComponent(endpoint.location);
      return `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${name}:${method}`;
    }
    default: {
      const unexpected: never = endpoint;
      throw new Error(`Unknown Google endpoint ${String(unexpected)}`);
    }
  }
}

export async function googleHeaders(endpoint: GoogleEndpoint): Promise<Record<string, string>> {
  switch (endpoint.kind) {
    case "studio":
    case "vertex-express":
      return { "x-goog-api-key": endpoint.apiKey };
    case "vertex":
      return { authorization: `Bearer ${await endpoint.tokens.token()}` };
    default: {
      const unexpected: never = endpoint;
      throw new Error(`Unknown Google endpoint ${String(unexpected)}`);
    }
  }
}
