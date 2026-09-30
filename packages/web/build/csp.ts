export interface CspEnv {
  VITE_LOJO_API_URL?: string;
  VITE_LOJO_BLOB_ORIGIN?: string;
}

export interface SecurityHeaders {
  /** For the `<meta>` tag. Browsers ignore `frame-ancestors` there, so it is left out. */
  metaPolicy: string;
  /** Full policy, sent as an HTTP header by the host. */
  headerPolicy: string;
  /** Netlify / Cloudflare Pages `_headers` file. */
  headersFile: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** One exact origin: https (or http on loopback), no wildcard, no path. */
export function exactOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${name} must be an absolute URL, got ${JSON.stringify(value)}`);
  }
  if (value.includes("*")) throw new Error(`${name} must be one exact origin, not a wildcard: ${value}`);
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  if (!secure) throw new Error(`${name} must use https, got ${value}`);
  if (url.username || url.password || url.search || url.hash) throw new Error(`${name} must be a bare origin, got ${value}`);
  return url.origin;
}

export function securityHeaders(env: CspEnv): SecurityHeaders {
  const connect = ["'self'"];
  if (env.VITE_LOJO_API_URL) {
    connect.push(exactOrigin(env.VITE_LOJO_API_URL, "VITE_LOJO_API_URL"));
    if (!env.VITE_LOJO_BLOB_ORIGIN) {
      throw new Error(
        "VITE_LOJO_BLOB_ORIGIN is required with VITE_LOJO_API_URL, so attachment downloads are allowed from the mail bucket only. " +
          "Use: terraform -chdir=infra/terraform output -raw web_blob_origin",
      );
    }
  }
  if (env.VITE_LOJO_BLOB_ORIGIN) {
    const blob = exactOrigin(env.VITE_LOJO_BLOB_ORIGIN, "VITE_LOJO_BLOB_ORIGIN");
    if (!connect.includes(blob)) connect.push(blob);
  }
  const directives = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect.join(" ")}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ];
  const metaPolicy = directives.join("; ");
  const headerPolicy = [...directives, "frame-ancestors 'none'"].join("; ");
  const headersFile = [
    "/*",
    `  Content-Security-Policy: ${headerPolicy}`,
    "  X-Frame-Options: DENY",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: no-referrer",
    "",
  ].join("\n");
  return { metaPolicy, headerPolicy, headersFile };
}
