import { BotApi, type FetchLike } from "./api.ts";
import { apiUrlFrom, botPaths, loadBotToken, readOptionalPrivateFile } from "./config.ts";
import type { OpContext } from "./context.ts";
import { loadedKey, parsePrivateJwk } from "./keys.ts";

/** Loads the bot credential and (optional) bot key, and asks the API what the credential may do. */
export async function botContext(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike): Promise<OpContext> {
  const paths = botPaths(env);
  const api = new BotApi(apiUrlFrom(env), loadBotToken(paths), fetchImpl);
  const rawKey = readOptionalPrivateFile(paths.keyFile);
  const key = rawKey ? await loadedKey(parsePrivateJwk(rawKey, paths.keyFile)) : null;
  const me = await api.get<{ scopes: string[]; sendFrom: string }>("/v1/bot/whoami");
  return { api, scopes: me.scopes, key, paths, mailbox: me.sendFrom, now: () => new Date() };
}
