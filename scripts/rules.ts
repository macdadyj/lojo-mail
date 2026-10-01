import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { checkRulesFile, type RulesDocument } from "@lojo/core";

const USAGE = `Usage:
  npm run rules -- validate <file>
  npm run rules -- pull --api https://mail.example/api        (LOJO_TOKEN: a read token)
  npm run rules -- push <file> --api https://mail.example/api (asks for your passphrase)

Rules are saved only with a signed-in human session: push signs in with your
passphrase, shows what the file turns on, and asks you to confirm.`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function apiBase(args: string[]): string {
  const api = flag(args, "--api") ?? process.env.LOJO_API_URL;
  if (!api) throw new Error("--api or LOJO_API_URL is required");
  const url = new URL(api);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("The API URL must be https");
  return api.replace(/\/+$/, "");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

async function ask(question: string, hidden: boolean): Promise<string> {
  const muted = new Writable({ write: (_chunk, _enc, done) => done() });
  const rl = createInterface({ input: process.stdin, output: hidden ? muted : process.stdout, terminal: true });
  process.stdout.write(question);
  const answer = await new Promise<string>((resolve) => rl.once("line", resolve));
  rl.close();
  if (hidden) process.stdout.write("\n");
  return answer.trim();
}

async function call(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${new URL(url).pathname}: ${res.status} ${String(body.error ?? "")}`);
  return body;
}

interface DescribedAction {
  type: string;
  reply?: { mode?: string; allowSenders?: string[]; allowCategories?: string[] };
  unsubscribe?: { mode?: string; allowSenders?: string[] };
}

function describeAction(id: string, action: DescribedAction): string | null {
  const who = (senders: string[] | undefined, categories?: string[]) =>
    senders && senders.length > 0 ? senders.join(", ") : categories && categories.length > 0 ? `category ${categories.join(", ")}` : "any list sender";
  if (action.type === "trash") return `  ${id}: moves matching mail to trash (restorable)`;
  if (action.type === "reply" && action.reply?.mode === "autoSend") return `  ${id}: AUTO-SENDS replies to ${who(action.reply.allowSenders, action.reply.allowCategories)}`;
  if (action.type === "reply" && action.reply?.mode === "shadow") return `  ${id}: shadow reply (logs only) to ${who(action.reply.allowSenders, action.reply.allowCategories)}`;
  if (action.type === "unsubscribe" && action.unsubscribe?.mode === "auto") return `  ${id}: UNSUBSCRIBES from lists from ${who(action.unsubscribe.allowSenders)}`;
  if (action.type === "unsubscribe") return `  ${id}: shadow unsubscribe (logs only) from ${who(action.unsubscribe?.allowSenders)}`;
  return null;
}

function describe(input: unknown): string[] {
  const rules = (input as { rules?: Array<{ id: string; enabled?: boolean; actions: DescribedAction[] }> }).rules ?? [];
  return rules.flatMap((rule) =>
    rule.actions.flatMap((action) => {
      const line = describeAction(rule.id, action);
      return line ? [`${line}${rule.enabled === false ? " [disabled]" : ""}`] : [];
    }),
  );
}

async function main(args: string[]): Promise<void> {
  const [command, file] = args;
  switch (command) {
    case "validate": {
      if (!file) throw new Error(USAGE);
      const result = checkRulesFile(readJson(file));
      if (!result.ok) throw new Error(result.error);
      console.log(`${file}: ${result.rules} rule(s) OK`);
      for (const line of describe(readJson(file))) console.log(line);
      return;
    }
    case "pull": {
      const token = process.env.LOJO_TOKEN;
      if (!token) throw new Error("LOJO_TOKEN is required");
      const body = await call(`${apiBase(args)}/v1/rules`, { headers: { authorization: `Bearer ${token}` } });
      console.log(JSON.stringify(body.rules as RulesDocument, null, 2));
      return;
    }
    case "push": {
      if (!file) throw new Error(USAGE);
      const input = readJson(file);
      const result = checkRulesFile(input);
      if (!result.ok) throw new Error(result.error);
      const base = apiBase(args);
      const risky = describe(input);
      console.log(`${result.rules} rule(s). ${risky.length ? "These act without asking you:" : "Nothing acts without asking you."}`);
      for (const line of risky) console.log(line);
      if ((await ask("Save these rules? Type yes: ", false)) !== "yes") throw new Error("Not saved");
      const passphrase = process.env.LOJO_PASSPHRASE ?? (await ask("Passphrase: ", true));
      const login = await call(`${base}/v1/session/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      const saved = await call(`${base}/v1/rules`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${String(login.sessionToken)}` },
        body: JSON.stringify(input),
      });
      console.log(`Saved ${(saved.rules as RulesDocument).rules.length} rule(s).`);
      return;
    }
    default:
      console.log(USAGE);
      if (command && command !== "--help") process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
