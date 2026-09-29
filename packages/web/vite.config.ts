import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { securityHeaders } from "./build/csp.ts";

/** Build-only: the dev server needs an inline React refresh preamble that this policy would block. */
function contentSecurityPolicy(env: Record<string, string>): Plugin {
  const headers = securityHeaders(env);
  return {
    name: "lojo-csp",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: headers.metaPolicy }, injectTo: "head-prepend" },
    ],
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: headers.headersFile });
    },
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
