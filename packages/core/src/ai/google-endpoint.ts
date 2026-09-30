import type { LojoConfig } from "../types.ts";
import { parseServiceAccount, ServiceAccountTokens, type GoogleEndpoint } from "./google-auth.ts";
import type { FetchLike } from "./http.ts";
import type { ProviderSecrets } from "./types.ts";

/**
 * `gemini` is the Gemini API with an AI Studio key. `vertex` is Vertex AI: a
 * service account key when one is configured, else express mode with an API key.
 */
export function googleEndpointFor(
  provider: "gemini" | "vertex",
  config: Pick<LojoConfig, "vertexProject" | "vertexLocation">,
  secrets: ProviderSecrets,
  fetchImpl?: FetchLike,
): GoogleEndpoint {
  if (provider === "gemini") {
    if (!secrets.geminiApiKey) throw new Error("Gemini is selected but no API key was provided");
    return { kind: "studio", apiKey: secrets.geminiApiKey };
  }
  if (secrets.vertexServiceAccount) {
    if (!config.vertexProject) throw new Error("Vertex needs LOJO_VERTEX_PROJECT with a service account key");
    const tokens = new ServiceAccountTokens(parseServiceAccount(secrets.vertexServiceAccount), fetchImpl ? { fetchImpl } : {});
    return { kind: "vertex", project: config.vertexProject, location: config.vertexLocation, tokens };
  }
  if (secrets.geminiApiKey) return { kind: "vertex-express", apiKey: secrets.geminiApiKey };
  throw new Error("Vertex is selected but neither a service account key nor an express-mode API key was provided");
}
