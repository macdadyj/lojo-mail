import type { EcPrivateJwk } from "@lojo/core";
import { ApiClient, type FetchLike, type SessionInfo } from "./api.ts";
import { LoginGuard, type LoginGuardOptions } from "./auth.ts";
import { LOOPBACK, validateHost, type BridgeConfig } from "./config.ts";
import { ImapServer } from "./imap-server.ts";
import { silentLogger, type Logger } from "./log.ts";
import { MailStore } from "./mailstore.ts";
import { desktopNotifier, type Notifier } from "./notify.ts";
import { SubmissionServer } from "./smtp.ts";
import { UidState } from "./state.ts";

export const BRIDGE_VERSION = "0.1.0";

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

const REQUIRED_SCOPES = ["read", "write", "body"] as const;
const FORBIDDEN_SCOPES = ["send", "admin"] as const;

/** The bridge runs only with a least-privilege token: it must never be able to send or administer. */
export async function checkToken(api: ApiClient, logger: Logger = silentLogger): Promise<SessionInfo> {
  const session = await api.session();
  const forbidden = FORBIDDEN_SCOPES.filter((scope) => session.scopes.includes(scope));
  if (forbidden.length > 0) {
    throw new ScopeError(`The bridge token has the ${forbidden.join(" and ")} scope. Use the dedicated bridge token (read, write, body, compose).`);
  }
  if (session.kind !== "token") throw new ScopeError("The bridge needs an API token, not a human session");
  const missing = REQUIRED_SCOPES.filter((scope) => !session.scopes.includes(scope));
  if (missing.length > 0) throw new ScopeError(`The bridge token is missing the ${missing.join(", ")} scope`);
  if (!session.scopes.includes("compose")) logger.warn("token.no_compose", { detail: "SMTP drafts can only go to known correspondents" });
  if (!session.scopes.includes("trash")) logger.info("token.no_trash", { detail: "Thunderbird delete archives with a hidden label" });
  return session;
}

export interface BridgeOptions {
  config: BridgeConfig;
  token: string;
  privateJwk: EcPrivateJwk;
  statePath: string | null;
  fetch?: FetchLike;
  blobFetch?: FetchLike;
  logger?: Logger;
  notify?: Notifier | null;
  guard?: LoginGuardOptions;
  cacheBytes?: number;
}

export interface RunningBridge {
  imapPort: number;
  smtpPort: number;
  close(): Promise<void>;
}

export async function startBridge(options: BridgeOptions): Promise<RunningBridge> {
  const { config } = options;
  const logger = options.logger ?? silentLogger;
  validateHost(config.host);
  const api = new ApiClient({
    baseUrl: config.apiUrl,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.blobFetch ? { blobFetch: options.blobFetch } : {}),
  });
  const session = await checkToken(api, logger);
  const state = new UidState(options.statePath, logger);
  const canTrash = config.deleteToTrash && session.scopes.includes("trash");
  const store = new MailStore(api, state, options.privateJwk, logger, {
    folderLimit: config.folderLimit,
    canTrash,
    ...(options.cacheBytes ? { cacheBytes: options.cacheBytes } : {}),
  });
  const guard = new LoginGuard(config.address, config.appPasswordHash, options.guard);
  const imap = new ImapServer({ store, guard, logger, pollSeconds: config.pollSeconds, version: BRIDGE_VERSION });
  const notify = options.notify === undefined ? (config.notify ? desktopNotifier : null) : options.notify;
  const smtp = new SubmissionServer({ api, guard, logger, address: config.address, notify, ...(config.webUrl ? { webUrl: config.webUrl } : {}) });
  const imapPort = await imap.listen(config.imapPort, LOOPBACK);
  let smtpPort: number;
  try {
    smtpPort = await smtp.listen(config.smtpPort, LOOPBACK);
  } catch (error) {
    await imap.close();
    throw error;
  }
  logger.info("bridge.started", { imapPort, smtpPort, host: LOOPBACK, token: session.label, scopes: session.scopes.join(","), deleteTo: canTrash ? "trash" : "archive" });
  return {
    imapPort,
    smtpPort,
    close: async () => {
      await Promise.all([imap.close(), smtp.close()]);
      state.flush();
      logger.info("bridge.stopped");
    },
  };
}
