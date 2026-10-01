import { readFileSync } from "node:fs";
import { botBodyContext, messageBodyContext, openJson, sealJson, type BotEnvelopeKey, type EnvelopeBlob, type SealedBody } from "@lojo/core";
import { BotApi, id, type FetchLike } from "./api.ts";
import { BotConfigError, readPrivateFile, writePrivateFile } from "./config.ts";
import { parsePrivateJwk } from "./keys.ts";

export interface AdminIo {
  ask(question: string, hidden: boolean): Promise<string>;
  print(line: string): void;
}

export const ADMIN_USAGE = `lojo-bot admin: Jon's commands (asks for your lojo-mail passphrase each time)

  lojo-bot admin list
  lojo-bot admin create <name> --out <file> [--scopes read,write,body,trash,rules,test-send]
  lojo-bot admin rotate <name> --out <file>
  lojo-bot admin revoke <name>
  lojo-bot admin scopes <name> --scopes read,write,body[,send-approved[,send-new]]
  lojo-bot admin send-limits <name> --per-hour N --per-day N   chat-approved sends (default 10/h, 30/day)
  lojo-bot admin kill-switch on|off
  lojo-bot admin rule-enable <rule id>                    shows the rule, asks you to type its id
  lojo-bot admin rule-mode <rule id> draft|shadow|live    live needs the rule in shadow first
  lojo-bot admin set-key <bot public JWK file>        from: lojo-bot key generate (run as the bot user)
  lojo-bot admin remove-key
  lojo-bot admin backfill --private-key-file <your envelope.private.jwk> [--limit N]

The credential is written to --out (mode 600) and never printed. Default scopes: read,write,body.
send-approved needs write; send-new needs send-approved.`;

export interface AdminArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function flag(args: AdminArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new BotConfigError(`${what} is required\n\n${ADMIN_USAGE}`);
  return value;
}

async function signIn(apiUrl: string, io: AdminIo, fetchImpl: FetchLike): Promise<BotApi> {
  const passphrase = await io.ask("lojo-mail passphrase: ", true);
  const response = await fetchImpl(`${apiUrl}/v1/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase }) });
  const body = (await response.json().catch(() => ({}))) as { sessionToken?: string; error?: string };
  if (!response.ok || !body.sessionToken) throw new BotConfigError(`Sign-in failed: ${response.status} ${body.error ?? ""}`.trim());
  return new BotApi(apiUrl, body.sessionToken, fetchImpl);
}

function writeCredential(args: AdminArgs, name: string, token: string, io: AdminIo): void {
  const out = need(flag(args, "out"), "--out <file>");
  writePrivateFile(out, `${token}\n`, { force: args.flags.force === true });
  io.print(`Wrote the credential for bot ${name} to ${out} (mode 600). It is not shown anywhere else.`);
  io.print(`Install it for the bot user, then delete this copy:`);
  io.print(`  sudo install -o lojo-bot -g lojo-bot -m 600 ${out} ~lojo-bot/.config/lojo-bot/token && shred -u ${out}`);
}

/** Re-seals mail for the bot key: opened here with Jon's key, sealed to the bot's public key. Plaintext never leaves this machine. */
async function backfill(api: BotApi, args: AdminArgs, io: AdminIo): Promise<void> {
  const keyFile = need(flag(args, "private-key-file"), "--private-key-file");
  const jon = parsePrivateJwk(readPrivateFile(keyFile), keyFile);
  const { envelopeKey } = await api.get<{ envelopeKey: BotEnvelopeKey | null }>("/v1/bots");
  if (!envelopeKey) throw new BotConfigError("No bot envelope key is registered. Run lojo-bot admin set-key first.");
  const limit = Number(flag(args, "limit") ?? "200");
  const { messageIds } = await api.get<{ messageIds: string[] }>(`/v1/bots/backfill?limit=${Number.isInteger(limit) ? limit : 200}`);
  let sealed = 0;
  let failed = 0;
  for (const messageId of messageIds) {
    try {
      const { envelope } = await api.get<{ envelope: EnvelopeBlob }>(`/v1/messages/${id(messageId)}/body`);
      const body = await openJson<SealedBody>(envelope, jon, messageBodyContext(messageId));
      const copy = await sealJson({ text: body.text, html: body.html }, envelopeKey.publicJwk, botBodyContext(messageId, envelopeKey.keyId));
      await api.post(`/v1/bots/copies/${id(messageId)}`, { keyId: envelopeKey.keyId, envelope: copy });
      sealed += 1;
    } catch (error) {
      failed += 1;
      io.print(`  ${messageId}: ${error instanceof Error ? error.message : "failed"}`);
    }
  }
  io.print(`Backfill for bot key ${envelopeKey.keyId}: ${sealed} sealed, ${failed} failed, of ${messageIds.length} without a copy.`);
}

function count(args: AdminArgs, name: string): number {
  const raw = Number(need(flag(args, name), `--${name} <N>`));
  if (!Number.isInteger(raw)) throw new BotConfigError(`--${name} must be a whole number`);
  return raw;
}

/** Jon reads the exact rule and types its id; the fingerprint makes the API refuse if it changed in between. */
async function confirmRule(api: BotApi, ruleId: string, what: string, io: AdminIo): Promise<string | null> {
  const listed = await api.get<{ rules: { rules: Array<{ id: string }> }; fingerprints: Record<string, string> }>("/v1/rules");
  const rule = listed.rules.rules.find((item) => item.id === ruleId);
  const sha256 = listed.fingerprints[ruleId];
  if (!rule || !sha256) throw new BotConfigError(`No rule ${ruleId}`);
  io.print(JSON.stringify(rule, null, 2));
  const typed = (await io.ask(`Type the rule id to ${what}: `, false)).trim();
  if (typed !== ruleId) {
    io.print("Not confirmed. Nothing changed.");
    return null;
  }
  return sha256;
}

const RULE_MODES = ["draft", "shadow", "live"] as const;

export async function runAdmin(args: AdminArgs, opts: { apiUrl: string; io: AdminIo; fetchImpl?: FetchLike }): Promise<void> {
  const { io } = opts;
  const scopes = flag(args, "scopes")?.split(",").map((scope) => scope.trim()).filter(Boolean);
  const name = args.positionals[0];
  const known = ["list", "create", "rotate", "revoke", "scopes", "send-limits", "kill-switch", "rule-enable", "rule-mode", "set-key", "remove-key", "backfill"];
  if (!known.includes(args.command)) throw new BotConfigError(ADMIN_USAGE);
  const api = await signIn(opts.apiUrl, io, opts.fetchImpl ?? fetch);
  switch (args.command) {
    case "list":
      io.print(JSON.stringify(await api.get("/v1/bots"), null, 2));
      return;
    case "create": {
      const bot = need(name, "<name>");
      need(flag(args, "out"), "--out <file>");
      const created = await api.post<{ token: string; bot: unknown }>("/v1/bots", { name: bot, ...(scopes ? { scopes } : {}) });
      writeCredential(args, bot, created.token, io);
      io.print(JSON.stringify(created.bot, null, 2));
      return;
    }
    case "rotate": {
      const bot = need(name, "<name>");
      need(flag(args, "out"), "--out <file>");
      const rotated = await api.post<{ token: string }>(`/v1/bots/${id(bot)}/rotate`);
      writeCredential(args, bot, rotated.token, io);
      io.print("The old credential stopped working.");
      return;
    }
    case "revoke":
      io.print(JSON.stringify(await api.post(`/v1/bots/${id(need(name, "<name>"))}/revoke`), null, 2));
      return;
    case "scopes":
      io.print(JSON.stringify(await api.post(`/v1/bots/${id(need(name, "<name>"))}/scopes`, { scopes: scopes ?? [] }), null, 2));
      return;
    case "send-limits": {
      const bot = need(name, "<name>");
      const limits = { perHour: count(args, "per-hour"), perDay: count(args, "per-day") };
      io.print(JSON.stringify(await api.post(`/v1/bots/${id(bot)}/send-limits`, limits), null, 2));
      return;
    }
    case "rule-enable": {
      const ruleId = need(name, "<rule id>");
      const sha256 = await confirmRule(api, ruleId, "enable it", io);
      if (!sha256) return;
      await api.post(`/v1/rules/${id(ruleId)}/enable`, { sha256 });
      io.print(`Rule ${ruleId} is enabled and is now yours: the bot can no longer edit it.`);
      return;
    }
    case "rule-mode": {
      const ruleId = need(name, "<rule id>");
      const mode = args.positionals[1];
      if (!RULE_MODES.some((item) => item === mode)) throw new BotConfigError("rule-mode <rule id> draft|shadow|live");
      const sha256 = await confirmRule(api, ruleId, `set it to ${mode}`, io);
      if (!sha256) return;
      await api.post(`/v1/rules/${id(ruleId)}/automation`, { mode, sha256 });
      io.print(`Rule ${ruleId} is now ${mode}.${mode === "live" ? " It sends only where LOJO_AUTO_SEND=on (Terraform auto_send_enabled)." : ""}`);
      return;
    }
    case "kill-switch": {
      if (name !== "on" && name !== "off") throw new BotConfigError("kill-switch on|off");
      const view = await api.post<{ killSwitch: boolean }>("/v1/bots/kill-switch", { on: name === "on" });
      io.print(`Bot kill switch is ${view.killSwitch ? "ON: every bot credential is refused" : "off"}.`);
      return;
    }
    case "set-key": {
      const file = need(name, "<bot public JWK file>");
      const key = await api.put<{ keyId: string }>("/v1/bots/envelope-key", { publicJwk: JSON.parse(readFileSync(file, "utf8")) as unknown });
      io.print(`Registered bot envelope key ${key.keyId}. New mail is sealed to it too. Run lojo-bot admin backfill for older mail.`);
      return;
    }
    case "remove-key":
      await api.post("/v1/bots/envelope-key/remove");
      io.print("Removed the bot envelope key. Bots can no longer fetch any body copy. Delete the private key on Santa: shred -u ~lojo-bot/.config/lojo-bot/envelope.private.jwk");
      return;
    case "backfill":
      await backfill(api, args, io);
      return;
    default:
      throw new BotConfigError(ADMIN_USAGE);
  }
}
