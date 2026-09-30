import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testApp } from "@lojo/api/testing";
import { sendFromList } from "@lojo/core";
import { ImapFlow } from "imapflow";
import { hashPassword } from "./auth.ts";
import { startBridge, type RunningBridge } from "./bridge.ts";
import { parseConfig, type BridgeConfig } from "./config.ts";

export const APP_PASSWORD = "test-app-password-not-a-secret";

let cachedHash: string | null = null;

export interface Harness {
  t: Awaited<ReturnType<typeof testApp>>;
  bridge: RunningBridge;
  config: BridgeConfig;
  address: string;
  statePath: string;
  imap(pass?: string): Promise<ImapFlow>;
  raw(): Promise<RawImap>;
  close(options?: { keepState?: boolean }): Promise<void>;
}

/** The bridge on ephemeral loopback ports over the in-memory API. The API is locked, as in production. */
export interface HarnessOptions {
  token?: string;
  pollSeconds?: number;
  newMailSeconds?: number;
  bridgeTrash?: boolean;
  bridgeSend?: boolean;
  deleteToTrash?: boolean;
  sendFrom?: string;
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const t = await testApp({
    unlocked: false,
    bridgeTrash: options.bridgeTrash ?? false,
    bridgeSend: options.bridgeSend ?? false,
    ...(options.sendFrom ? { config: { sendFrom: sendFromList("lojo@cyberphysical.us", options.sendFrom) } } : {}),
  });
  const dir = mkdtempSync(join(tmpdir(), "lojo-bridge-test-"));
  const statePath = join(dir, "bridge-state.json");
  cachedHash ??= await hashPassword(APP_PASSWORD);
  const address = t.config.mailbox;
  const config: BridgeConfig = {
    ...parseConfig({
      apiUrl: "http://127.0.0.1",
      address,
      imapPort: 0,
      smtpPort: 0,
      tokenFile: join(dir, "unused-token"),
      privateKeyFile: join(dir, "unused-key"),
      appPasswordHash: cachedHash,
      notify: false,
      deleteToTrash: options.deleteToTrash ?? true,
    }),
    pollSeconds: options.pollSeconds ?? 60,
    newMailSeconds: options.newMailSeconds ?? 60,
  };
  const bridge = await startBridge({
    config,
    token: options.token ?? "bridge-token",
    privateJwk: t.privateJwk,
    statePath,
    fetch: (url, init) => Promise.resolve(t.app.request(url, init)),
    notify: null,
    guard: { baseDelayMs: 1, maxDelayMs: 5 },
  });
  const clients: ImapFlow[] = [];
  const sockets: RawImap[] = [];
  return {
    t,
    bridge,
    config,
    address,
    statePath,
    imap: async (pass = APP_PASSWORD) => {
      const client = new ImapFlow({
        host: "127.0.0.1",
        port: bridge.imapPort,
        secure: false,
        doSTARTTLS: false,
        auth: { user: address, pass },
        logger: false,
        disableAutoIdle: true,
      });
      client.on("error", () => {});
      await client.connect();
      clients.push(client);
      return client;
    },
    raw: async () => {
      const socket = await RawImap.open(bridge.imapPort);
      sockets.push(socket);
      return socket;
    },
    close: async (closeOptions = {}) => {
      for (const client of clients) {
        try {
          await client.logout();
        } catch {
          client.close();
        }
      }
      for (const socket of sockets) socket.end();
      await bridge.close();
      if (!closeOptions.keepState) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A bare socket for commands no library sends, and for malformed input. */
export class RawImap {
  private buffer = "";
  private waiters: Array<() => void> = [];

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (const wake of this.waiters.splice(0)) wake();
    });
    socket.on("close", () => {
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  static open(port: number): Promise<RawImap> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port }, () => resolve(new RawImap(socket)));
      socket.once("error", reject);
    });
  }

  send(text: string): void {
    this.socket.write(text);
  }

  async until(pattern: RegExp, timeoutMs = 3000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = pattern.exec(this.buffer);
      if (match) {
        const end = match.index + match[0].length;
        const out = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end);
        return out;
      }
      if (Date.now() > deadline || this.socket.destroyed) throw new Error(`Timed out waiting for ${pattern}; have ${JSON.stringify(this.buffer.slice(-300))}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async command(tag: string, text: string): Promise<string> {
    this.send(`${tag} ${text}\r\n`);
    return this.until(new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n`, "m"));
  }

  async login(address: string, password = APP_PASSWORD): Promise<void> {
    await this.until(/^\* OK[^\r\n]*\r\n/m);
    const reply = await this.command("L1", `LOGIN "${address}" "${password}"`);
    if (!/^L1 OK/m.test(reply)) throw new Error(`login failed: ${reply}`);
  }

  end(): void {
    this.socket.destroy();
  }
}
