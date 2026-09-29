import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** Presigned attachment downloads come straight from the mail bucket. */
const DEFAULT_BLOB_ORIGIN = "https://*.s3.us-east-1.amazonaws.com";

function origin(url: string, name: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new Error(`${name} must be an absolute URL, got ${JSON.stringify(url)}`);
  }
}

/** Build-only: the dev server needs an inline React refresh preamble that this policy would block. */
function contentSecurityPolicy(env: Record<string, string>): Plugin {
  const connect = ["'self'"];
  if (env.VITE_LOJO_API_URL) connect.push(origin(env.VITE_LOJO_API_URL, "VITE_LOJO_API_URL"));
  connect.push(env.VITE_LOJO_BLOB_ORIGIN ? env.VITE_LOJO_BLOB_ORIGIN : DEFAULT_BLOB_ORIGIN);
  const policy = [
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
  ].join("; ");
  return {
    name: "lojo-csp",
    apply: "build",
    transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: policy }, injectTo: "head-prepend" }],
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [react(), contentSecurityPolicy(env)],
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        "/v1": "http://127.0.0.1:8787",
      },
    },
  };
});
