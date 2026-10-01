#!/usr/bin/env -S npx tsx
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { keyFingerprint } from "@lojo/core";
import { ADMIN_USAGE, runAdmin, type AdminIo } from "./admin.ts";
import { opArgs, parseArgv } from "./args.ts";
import { apiUrlFrom, botPaths, BotConfigError, readPrivateFile, writePrivateFile } from "./config.ts";
import { newBotKey, parsePrivateJwk, publicOf } from "./keys.ts";
import { describeOp, serveStdio } from "./mcp.ts";
import { allowedOps, ops, runOp } from "./ops.ts";
import { botContext } from "./runtime.ts";

const USAGE = `lojo-bot: Jon's bot on lojo-mail (Grok Bot, or any shell agent on Santa)

  lojo-bot ops [--all]                 operations this credential may run
  lojo-bot <operation> [--arg value]   one operation; JSON on stdout
  lojo-bot <operation> --json '{...}'
  lojo-bot <operation> --json -        arguments as JSON on stdin (for ssh, where quoting is lost)
  lojo-bot digest [--peek]             new mail since the last digest, summary-ready JSON
  lojo-bot mcp                         stdio MCP server with the same operations
  lojo-bot key generate [--force]      bot envelope key (run as the bot user); prints the public half for Jon
  lojo-bot key show
  lojo-bot admin …                     Jon only, with his passphrase (lojo-bot admin help)

Environment
  LOJO_API_URL          the lojo-mail API (https)
  LOJO_BOT_HOME         default ~/.config/lojo-bot (token, envelope.private.jwk; both mode 600)
  LOJO_BOT_STATE_DIR    default ~/.local/state/lojo-bot (the digest cursor)
  LOJO_BOT_ATTACH_DIR   default ~/lojo-bot-files (the only place attach_file reads)

Nothing here sends mail except send_test_to_lojo_test, which reaches lojo-test@cyberphysical.us only.
Drafts wait for Jon in Thunderbird and the web app.`;

async function ask(question: string, hidden: boolean): Promise<string> {
  if (!process.stdin.isTTY) throw new BotConfigError("lojo-bot admin asks for your passphrase on a terminal");
  const muted = new Writable({ write: (_chunk, _enc, done) => done() });
  const rl = createInterface({ input: process.stdin, output: hidden ? muted : process.stdout, terminal: true });
  process.stdout.write(question);
  const answer = await new Promise<string>((resolve) => rl.once("line", resolve));
  rl.close();
  if (hidden) process.stdout.write("\n");
  return answer.trim();
}

const io: AdminIo = { ask, print: (line) => console.log(line) };

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function key(sub: string | undefined, force: boolean): Promise<void> {
  const paths = botPaths();
  switch (sub) {
    case "generate": {
      const generated = await newBotKey();
      writePrivateFile(paths.keyFile, `${JSON.stringify(generated.privateJwk)}\n`, { force });
      console.error(`Wrote the bot envelope private key to ${paths.keyFile} (mode 600). Key id ${generated.keyId}.`);
      console.error("Give Jon the public key below; he registers it with: lojo-bot admin set-key <file>");
      out(generated.publicJwk);
      return;
    }
    case "show": {
      const jwk = publicOf(parsePrivateJwk(readPrivateFile(paths.keyFile), paths.keyFile));
      out({ keyId: await keyFingerprint(jwk), publicJwk: jwk });
      return;
    }
    default:
      throw new BotConfigError("lojo-bot key generate|show");
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const parsed = parseArgv(rest);
  if (parsed.flags.json === "-") parsed.flags.json = readFileSync(0, "utf8");
  switch (command) {
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return;
    case "admin": {
      const [sub, ...positionals] = parsed.positionals;
      if (!sub || sub === "help") {
        console.log(ADMIN_USAGE);
        return;
      }
      const api = typeof parsed.flags.api === "string" ? parsed.flags.api : undefined;
      await runAdmin({ command: sub, positionals, flags: parsed.flags }, { apiUrl: apiUrlFrom(process.env, api), io });
      return;
    }
    case "key":
      await key(parsed.positionals[0], parsed.flags.force === true);
      return;
    case "mcp":
      await serveStdio(await botContext());
      return;
    case "ops": {
      const list = parsed.flags.all === true ? ops : allowedOps((await botContext()).scopes);
      out(list.map((item) => ({ name: item.name, scopes: item.scopes, description: describeOp(item) })));
      return;
    }
    default: {
      const found = ops.find((item) => item.name === command);
      if (!found) throw new BotConfigError(`Unknown command ${command}\n\n${USAGE}`);
      out(await runOp(found.name, opArgs(parsed, found.schema), await botContext()));
    }
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
