import { readFileSync, writeFileSync } from "node:fs";
import type { EcPrivateJwk } from "@lojo/core";
import { generateKeyPassphrase, unwrapPrivateKey, unwrapToJwk, wrapPrivateKey } from "@lojo/core/wrap";
import { ConfigError } from "./config.ts";

/** Terminal and file access, injected so the commands can be tested without a TTY. */
export interface KeyToolIo {
  print(text: string): void;
  readSecret(prompt: string): Promise<string>;
  readText(path: string): string;
  /** Owner-only (0600). Refuses to replace an existing file unless `force`. */
  writePrivate(path: string, contents: string, force: boolean): void;
}

export interface ExportResult {
  blob: string;
  passphrase: string;
  fingerprint: string;
}

/**
 * `lojo-bridge key export-wrapped`: wraps the envelope key under a new
 * generated key passphrase, checks the result unwraps, and shows the
 * passphrase once. The passphrase is never written anywhere.
 */
export async function exportWrapped(privateJwk: EcPrivateJwk, options: { out?: string; force?: boolean }, io: KeyToolIo): Promise<ExportResult> {
  const passphrase = generateKeyPassphrase();
  const blob = await wrapPrivateKey(privateJwk, passphrase);
  const check = await unwrapPrivateKey(blob, passphrase);
  if (check.publicJwk.x !== privateJwk.x || check.publicJwk.y !== privateJwk.y) throw new ConfigError("The wrapped key did not round-trip; nothing was written");
  if (options.out) io.writePrivate(options.out, `${blob}\n`, options.force ?? false);
  io.print(
    [
      "Wrapped envelope key (safe to keep in a password manager; useless without the key passphrase):",
      "",
      blob,
      "",
      ...(options.out ? [`Also written to ${options.out} (mode 600).`, ""] : []),
      "Key passphrase (shown once, never stored; put it in its own password-manager field):",
      "",
      `  ${passphrase}`,
      "",
      `Key fingerprint ${check.fingerprint}. The web app shows the same fingerprint in Settings when it unlocks.`,
      "Clear your terminal scrollback when you have saved both.",
    ].join("\n"),
  );
  return { blob, passphrase, fingerprint: check.fingerprint };
}

function readBlob(path: string, io: KeyToolIo): string {
  const text = io.readText(path).trim();
  if (!text) throw new ConfigError(`${path} is empty`);
  return text;
}

/** `lojo-bridge key verify-wrapped`: proves a backup opens, and that it is this Santa's key if one is configured. */
export async function verifyWrapped(options: { in: string; expected?: EcPrivateJwk }, io: KeyToolIo): Promise<string> {
  const unwrapped = await unwrapPrivateKey(readBlob(options.in, io), await io.readSecret("Key passphrase: "));
  if (options.expected && (options.expected.x !== unwrapped.publicJwk.x || options.expected.y !== unwrapped.publicJwk.y)) {
    throw new ConfigError(`The backup opens, but it is a different key (fingerprint ${unwrapped.fingerprint}) from the bridge's envelope key`);
  }
  io.print(`The wrapped key opens with that passphrase. Fingerprint ${unwrapped.fingerprint}, wrapped ${unwrapped.created}.${options.expected ? " It matches the bridge's envelope key." : ""}`);
  return unwrapped.fingerprint;
}

/** `lojo-bridge key import-wrapped`: recovery, back to an envelope.private.jwk for a new machine. */
export async function importWrapped(options: { in: string; out: string; force?: boolean }, io: KeyToolIo): Promise<void> {
  const jwk = await unwrapToJwk(readBlob(options.in, io), await io.readSecret("Key passphrase: "));
  io.writePrivate(options.out, `${JSON.stringify(jwk, null, 2)}\n`, options.force ?? false);
  io.print(`Wrote the envelope private key to ${options.out} (mode 600). Point the bridge at it with --private-key-file.`);
}

function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk: string) => {
        data += chunk;
      });
      stdin.on("end", () => resolve(data.split(/\r?\n/)[0] ?? ""));
      stdin.on("error", reject);
    });
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003") {
          stdin.setRawMode(false);
          process.exit(130);
        }
        value = char === "\u007f" || char === "\b" ? value.slice(0, -1) : value + char;
      }
    };
    stdin.on("data", onData);
  });
}

export const terminalIo: KeyToolIo = {
  print: (text) => console.log(text),
  readSecret: readHidden,
  readText: (path) => readFileSync(path, "utf8"),
  writePrivate: (path, contents, force) => {
    try {
      writeFileSync(path, contents, { mode: 0o600, flag: force ? "w" : "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ConfigError(`${path} already exists; use --force to replace it`);
      throw error;
    }
  },
};
