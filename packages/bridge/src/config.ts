import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { EcPrivateJwk } from "@lojo/core";

export const DEFAULT_IMAP_PORT = 1143;
export const DEFAULT_SMTP_PORT = 1587;
export const LOOPBACK = "127.0.0.1";

export interface BridgeConfig {
  apiUrl: string;
  address: string;
  /** Always 127.0.0.1. Present so a hand-edited config that tries to widen it is refused rather than ignored. */
  host: typeof LOOPBACK;
  imapPort: number;
  smtpPort: number;
  tokenFile?: string;
  tokenCommand?: string[];
  privateKeyFile?: string;
  privateKeyCommand?: string[];
  appPasswordHash: string;
  /** Full resync of the selected mailbox while Thunderbird idles. */
  pollSeconds: number;
  /** How often an idling connection checks the newest messages for new mail. */
  newMailSeconds: number;
  folderLimit: number;
  notify: boolean;
  /**
   * Thunderbird delete moves mail to Trash (a soft delete the service keeps for
   * its retention window) when this is true and the token holds `trash`.
   * Otherwise delete archives with a hidden label.
   */
  deleteToTrash: boolean;
  webUrl?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface BridgePaths {
  configDir: string;
  configFile: string;
  stateDir: string;
  stateFile: string;
}

export function bridgePaths(env: NodeJS.ProcessEnv = process.env): BridgePaths {
  const home = env.HOME || homedir();
  const configDir = join(env.XDG_CONFIG_HOME || join(home, ".config"), "lojo-mail");
  const stateDir = join(env.XDG_STATE_HOME || join(home, ".local", "state"), "lojo-mail");
  return { configDir, configFile: join(configDir, "bridge.json"), stateDir, stateFile: join(stateDir, "bridge-state.json") };
}

const LOCAL_API_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value) throw new ConfigError(`${key} must be a non-empty string`);
  return value;
}

function optionalArgv(raw: Record<string, unknown>, key: string): string[] | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new ConfigError(`${key} must be a non-empty argv array of strings, for example ["pass", "show", "lojo/bridge-token"]`);
  }
  return value as string[];
}

function port(raw: Record<string, unknown>, key: string, fallback: number): number {
  const value = raw[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535) {
    throw new ConfigError(`${key} must be a port number`);
  }
  return value;
}

function boundedInt(raw: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = raw[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function validateApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("apiUrl is not a URL");
  }
  if (url.protocol === "https:") return value.replace(/\/+$/, "");
  if (url.protocol === "http:" && LOCAL_API_HOSTS.has(url.hostname)) return value.replace(/\/+$/, "");
  throw new ConfigError("apiUrl must be https:// (plain http is only allowed for a local dev API on localhost)");
}

export function validateHost(value: unknown): typeof LOOPBACK {
  if (value === undefined || value === LOOPBACK) return LOOPBACK;
  throw new ConfigError(`host must be ${LOOPBACK}: the bridge serves unencrypted IMAP and SMTP and only listens on loopback`);
}

export function parseConfig(raw: unknown): BridgeConfig {
  if (!isObject(raw)) throw new ConfigError("bridge.json must contain a JSON object");
  const apiUrl = optionalString(raw, "apiUrl");
  const address = optionalString(raw, "address");
  const appPasswordHash = optionalString(raw, "appPasswordHash");
  if (!apiUrl) throw new ConfigError("apiUrl is required");
  if (!address || !/^[^\s@<>]+@[^\s@<>]+$/.test(address)) throw new ConfigError("address must be the mailbox address");
  if (!appPasswordHash || !appPasswordHash.startsWith("scrypt$")) throw new ConfigError("appPasswordHash is missing; run lojo-bridge init");
  const config: BridgeConfig = {
    apiUrl: validateApiUrl(apiUrl),
    address: address.toLowerCase(),
    host: validateHost(raw.host),
    imapPort: port(raw, "imapPort", DEFAULT_IMAP_PORT),
    smtpPort: port(raw, "smtpPort", DEFAULT_SMTP_PORT),
    appPasswordHash,
    pollSeconds: boundedInt(raw, "pollSeconds", 60, 5, 3600),
    newMailSeconds: boundedInt(raw, "newMailSeconds", 15, 5, 600),
    folderLimit: boundedInt(raw, "folderLimit", 2000, 1, 5000),
    notify: raw.notify === undefined ? true : raw.notify === true,
    deleteToTrash: raw.deleteToTrash === undefined ? true : raw.deleteToTrash === true,
  };
  if (raw.notify !== undefined && typeof raw.notify !== "boolean") throw new ConfigError("notify must be true or false");
  if (raw.deleteToTrash !== undefined && typeof raw.deleteToTrash !== "boolean") throw new ConfigError("deleteToTrash must be true or false");
  const tokenFile = optionalString(raw, "tokenFile");
  const tokenCommand = optionalArgv(raw, "tokenCommand");
  const privateKeyFile = optionalString(raw, "privateKeyFile");
  const privateKeyCommand = optionalArgv(raw, "privateKeyCommand");
  if (Boolean(tokenFile) === Boolean(tokenCommand)) throw new ConfigError("Set exactly one of tokenFile or tokenCommand");
  if (Boolean(privateKeyFile) === Boolean(privateKeyCommand)) throw new ConfigError("Set exactly one of privateKeyFile or privateKeyCommand");
  if (tokenFile) config.tokenFile = tokenFile;
  if (tokenCommand) config.tokenCommand = tokenCommand;
  if (privateKeyFile) config.privateKeyFile = privateKeyFile;
  if (privateKeyCommand) config.privateKeyCommand = privateKeyCommand;
  const webUrl = optionalString(raw, "webUrl");
  if (webUrl) {
    if (!/^https?:\/\//.test(webUrl)) throw new ConfigError("webUrl must be an http(s) URL");
    config.webUrl = webUrl;
  }
  return config;
}

function uid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/** Secrets and config must be owner-only: anything else on the machine could read the token or key. */
export function assertPrivatePath(path: string, kind: "file" | "directory"): void {
  let info;
  try {
    info = statSync(path);
  } catch {
    throw new ConfigError(`${path} does not exist`);
  }
  if (kind === "file" && !info.isFile()) throw new ConfigError(`${path} is not a regular file`);
  if (kind === "directory" && !info.isDirectory()) throw new ConfigError(`${path} is not a directory`);
  if ((info.mode & 0o077) !== 0) {
    const mode = (info.mode & 0o777).toString(8);
    throw new ConfigError(`${path} is accessible to group or others (mode ${mode}); run chmod ${kind === "file" ? "600" : "700"} ${path}`);
  }
  const me = uid();
  if (me !== null && info.uid !== me) throw new ConfigError(`${path} is not owned by the current user`);
}

export function loadConfig(path: string): BridgeConfig {
  assertPrivatePath(dirname(path), "directory");
  assertPrivatePath(path, "file");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ConfigError(`${path} is not valid JSON`);
  }
  return parseConfig(raw);
}

export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function writePrivateFile(path: string, contents: string): void {
  ensurePrivateDir(dirname(path));
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, contents, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export function saveConfig(path: string, config: BridgeConfig): void {
  writePrivateFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

function runCommand(argv: string[], what: string): Promise<string> {
  const [file, ...args] = argv;
  if (!file) return Promise.reject(new ConfigError(`${what} command is empty`));
  return new Promise((resolve, reject) => {
    execFile(file, args, { shell: false, timeout: 60_000, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(new ConfigError(`${what} command ${file} failed (${error.code ?? "error"})`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function readSecret(file: string | undefined, command: string[] | undefined, what: string): Promise<string> {
  if (file) {
    assertPrivatePath(file, "file");
    return readFileSync(file, "utf8");
  }
  if (command) return runCommand(command, what);
  throw new ConfigError(`No source configured for the ${what}`);
}

export async function loadToken(config: BridgeConfig): Promise<string> {
  const raw = await readSecret(config.tokenFile, config.tokenCommand, "bridge token");
  const token = raw.split(/\r?\n/)[0]?.trim() ?? "";
  const minimum = config.apiUrl.startsWith("http://") ? 1 : 32;
  if (token.length < minimum) throw new ConfigError(`The bridge token is missing or shorter than ${minimum} characters`);
  return token;
}

export function parsePrivateJwk(raw: string): EcPrivateJwk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("The envelope private key is not JSON (expected the envelope.private.jwk from npm run keygen)");
  }
  if (!isObject(parsed) || parsed.kty !== "EC" || parsed.crv !== "P-256") throw new ConfigError("The envelope private key must be a P-256 EC JWK");
  const { x, y, d } = parsed;
  if (typeof x !== "string" || typeof y !== "string" || typeof d !== "string") throw new ConfigError("The envelope private key needs x, y, and d");
  return { kty: "EC", crv: "P-256", x, y, d };
}

export async function loadPrivateKey(config: BridgeConfig): Promise<EcPrivateJwk> {
  return parsePrivateJwk(await readSecret(config.privateKeyFile, config.privateKeyCommand, "envelope private key"));
}
