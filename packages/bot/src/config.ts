import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export class BotConfigError extends Error {}

/**
 * Everything the bot keeps on Santa, under the bot's own Unix user. Nothing
 * here is Jon's: his envelope key and bridge token stay in ~/.config/lojo-mail.
 */
export interface BotPaths {
  /** The bot credential (lbt_…), mode 600. */
  tokenFile: string;
  /** The bot envelope private key, mode 600. Optional: without it the bot sees metadata and AI-context text only. */
  keyFile: string;
  /** The digest cursor. */
  stateDir: string;
  /** attach_file only reads files under here. */
  attachDir: string;
}

export function botPaths(env: NodeJS.ProcessEnv = process.env): BotPaths {
  const home = env.LOJO_BOT_HOME ?? join(homedir(), ".config", "lojo-bot");
  return {
    tokenFile: env.LOJO_BOT_TOKEN_FILE ?? join(home, "token"),
    keyFile: env.LOJO_BOT_KEY_FILE ?? join(home, "envelope.private.jwk"),
    stateDir: env.LOJO_BOT_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "lojo-bot"),
    attachDir: env.LOJO_BOT_ATTACH_DIR ?? join(homedir(), "lojo-bot-files"),
  };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function apiUrlFrom(env: NodeJS.ProcessEnv = process.env, flag?: string): string {
  const value = flag ?? env.LOJO_API_URL;
  if (!value) throw new BotConfigError("Set LOJO_API_URL (or --api) to the lojo-mail API, for example https://<api-id>.execute-api.us-east-1.amazonaws.com");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BotConfigError(`LOJO_API_URL is not a URL: ${value}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new BotConfigError("LOJO_API_URL must be https (http only for localhost)");
  }
  return value.replace(/\/+$/, "");
}

/** Owner-only, owned by this user: anything else on Santa could read the credential or key. */
export function assertPrivateFile(path: string): void {
  let info;
  try {
    info = statSync(path);
  } catch {
    throw new BotConfigError(`${path} does not exist`);
  }
  if (!info.isFile()) throw new BotConfigError(`${path} is not a regular file`);
  if ((info.mode & 0o077) !== 0) throw new BotConfigError(`${path} is readable by group or others (mode ${(info.mode & 0o777).toString(8)}); run chmod 600 ${path}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new BotConfigError(`${path} is not owned by the current user`);
}

export function readPrivateFile(path: string): string {
  assertPrivateFile(path);
  return readFileSync(path, "utf8");
}

export function readOptionalPrivateFile(path: string): string | null {
  return existsSync(path) ? readPrivateFile(path) : null;
}

/** Atomic, mode 600, in a mode 700 directory. Refuses to replace an existing file unless `force`. */
export function writePrivateFile(path: string, contents: string, opts: { force?: boolean } = {}): void {
  if (!opts.force && existsSync(path)) throw new BotConfigError(`${path} already exists (pass --force to replace it)`);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, contents, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export function loadBotToken(paths: BotPaths): string {
  const token = readPrivateFile(paths.tokenFile).trim();
  if (!token.startsWith("lbt_")) throw new BotConfigError(`${paths.tokenFile} does not hold a lojo-mail bot credential (lbt_…)`);
  return token;
}
