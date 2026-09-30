#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import type { SealedBody } from "@lojo/core";
import { messageBodyContext, openJson } from "@lojo/core/crypto";
import { ApiClient, ApiError } from "./api.ts";
import { generateAppPassword, hashPassword } from "./auth.ts";
import { BRIDGE_VERSION, checkToken, ScopeError, startBridge } from "./bridge.ts";
import {
  assertPrivatePath,
  bridgePaths,
  ConfigError,
  DEFAULT_IMAP_PORT,
  DEFAULT_SMTP_PORT,
  ensurePrivateDir,
  loadConfig,
  loadPrivateKey,
  loadToken,
  LOOPBACK,
  parseConfig,
  saveConfig,
} from "./config.ts";
import { jsonLogger } from "./log.ts";

const USAGE = `lojo-bridge ${BRIDGE_VERSION}: local IMAP and SMTP bridge for lojo-mail (Thunderbird)

  lojo-bridge init [--api-url URL] [--address ADDRESS] [--web-url URL]
                   [--token-file PATH | --token-command JSON_ARGV]
                   [--private-key-file PATH | --private-key-command JSON_ARGV]
                   [--imap-port N] [--smtp-port N] [--no-trash] [--force]
  lojo-bridge serve            run IMAP on 127.0.0.1:1143 and SMTP on 127.0.0.1:1587
  lojo-bridge check            check file modes, the token's scopes, and the envelope key
  lojo-bridge reset-password   print a new app password (restart the service afterwards)

Options
  --config PATH   default $XDG_CONFIG_HOME/lojo-mail/bridge.json

JSON_ARGV is a command as a JSON array, run without a shell, for example
  --token-command '["pass","show","lojo/bridge-token"]'

Delete in Thunderbird moves mail to Trash when the service granted the bridge
token the trash scope (a soft delete, kept for the retention window). With
--no-trash, or without the scope, delete archives with a hidden label.

Mail submitted over SMTP becomes a draft in the approval queue. Nothing is
sent until Jon approves it in the lojo-mail web app.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    "api-url": { type: "string" },
    address: { type: "string" },
    "web-url": { type: "string" },
    "token-file": { type: "string" },
    "token-command": { type: "string" },
    "private-key-file": { type: "string" },
    "private-key-command": { type: "string" },
    "imap-port": { type: "string" },
    "smtp-port": { type: "string" },
    "no-trash": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const paths = bridgePaths();
const configPath = values.config ?? paths.configFile;

function argv(value: string | undefined, flag: string): string[] | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed as string[];
  } catch {
    throw new ConfigError(`${flag} must be a JSON array, for example '["pass","show","lojo/bridge-token"]'`);
  }
  throw new ConfigError(`${flag} must be a JSON array`);
}

function portFlag(value: string | undefined, fallback: number): number {
  return value === undefined ? fallback : Number(value);
}

function printPassword(password: string): void {
  console.log(`App password (shown once; use it for both IMAP and SMTP in Thunderbird):\n\n  ${password}\n`);
}

function exists(path: string): boolean {
  try {
    assertPrivatePath(path, "file");
    return true;
  } catch (error) {
    return !(error instanceof ConfigError && error.message.endsWith("does not exist"));
  }
}

async function init(): Promise<void> {
  if (exists(configPath) && !values.force) throw new ConfigError(`${configPath} already exists; use reset-password, or --force to overwrite it`);
  const tokenFile = values["token-file"];
  const privateKeyFile = values["private-key-file"];
  const raw: Record<string, unknown> = {
    apiUrl: values["api-url"],
    address: values.address ?? "lojo@cyberphysical.us",
    host: LOOPBACK,
    imapPort: portFlag(values["imap-port"], DEFAULT_IMAP_PORT),
    smtpPort: portFlag(values["smtp-port"], DEFAULT_SMTP_PORT),
    tokenFile,
    tokenCommand: argv(values["token-command"], "--token-command"),
    privateKeyFile,
    privateKeyCommand: argv(values["private-key-command"], "--private-key-command"),
    pollSeconds: 60,
    newMailSeconds: 15,
    folderLimit: 2000,
    notify: true,
    deleteToTrash: !values["no-trash"],
    webUrl: values["web-url"],
  };
  const password = generateAppPassword();
  const config = parseConfig({ ...raw, appPasswordHash: await hashPassword(password) });
  if (tokenFile) assertPrivatePath(tokenFile, "file");
  if (privateKeyFile) assertPrivatePath(privateKeyFile, "file");
  saveConfig(configPath, config);
  ensurePrivateDir(paths.stateDir);
  console.log(`Wrote ${configPath}`);
  printPassword(password);
}

async function resetPassword(): Promise<void> {
  const config = loadConfig(configPath);
  const password = generateAppPassword();
  saveConfig(configPath, { ...config, appPasswordHash: await hashPassword(password) });
  printPassword(password);
  console.log("Restart the bridge to use it: systemctl --user restart lojo-mail-bridge");
}

async function check(): Promise<void> {
  const config = loadConfig(configPath);
  console.log(`config        ${configPath} (owner-only)`);
  const token = await loadToken(config);
  console.log(`bridge token  ${config.tokenFile ? `${config.tokenFile} (owner-only)` : `from ${config.tokenCommand?.[0]}`}`);
  const privateJwk = await loadPrivateKey(config);
  console.log(`envelope key  ${config.privateKeyFile ? `${config.privateKeyFile} (owner-only)` : `from ${config.privateKeyCommand?.[0]}`}`);
  const api = new ApiClient({ baseUrl: config.apiUrl, token });
  const session = await checkToken(api);
  console.log(`api           ${config.apiUrl} reachable; token "${session.label}" scopes ${session.scopes.join(", ")}`);
  const toTrash = config.deleteToTrash && session.scopes.includes("trash");
  console.log(`delete        ${toTrash ? "moves to Trash (soft delete, recoverable for the retention window)" : "archives with a hidden label"}`);
  console.log(
    `send          ${session.scopes.includes("client-send") ? `Send in Thunderbird goes out at once, as ${(session.sendFrom ?? [config.address]).join(", ")}` : "Send in Thunderbird queues a draft for approval in the web app"}`,
  );
  const [newest] = await api.listFolder("inbox", 1);
  if (!newest) {
    console.log("decrypt       inbox is empty; nothing to test");
    return;
  }
  try {
    await openJson<SealedBody>(await api.bodyEnvelope(newest.id), privateJwk, messageBodyContext(newest.id));
    console.log("decrypt       the envelope key opens the newest inbox message");
  } catch {
    throw new ConfigError("The envelope key does not open the newest inbox message. Is it the key from npm run keygen for this mailbox?");
  }
}

async function serve(): Promise<void> {
  const logger = jsonLogger();
  const config = loadConfig(configPath);
  const bridge = await startBridge({
    config,
    token: await loadToken(config),
    privateJwk: await loadPrivateKey(config),
    statePath: paths.stateFile,
    logger,
  });
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("bridge.stopping", { signal });
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    bridge.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

async function main(): Promise<void> {
  const [command] = positionals;
  if (!command || values.help) {
    console.log(USAGE);
    return;
  }
  switch (command) {
    case "init":
      return init();
    case "serve":
      return serve();
    case "check":
      return check();
    case "reset-password":
      return resetPassword();
    default:
      console.error(`Unknown command ${command}\n\n${USAGE}`);
      process.exit(2);
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof ScopeError || error instanceof ApiError) {
    console.error(`lojo-bridge: ${error.message}`);
  } else {
    console.error(`lojo-bridge: ${error instanceof Error ? error.message : "failed"}`);
  }
  process.exit(1);
});
