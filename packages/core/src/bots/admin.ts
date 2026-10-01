import { keyFingerprint } from "../crypto/envelope.ts";
import { MailError } from "../errors.ts";
import type { MailStore } from "../store/types.ts";
import type { EcPublicJwk } from "../types.ts";
import { chatSendLimits } from "./chat-send.ts";
import { applySendWindow, persistExpiredSendGrants, type SendWindowInput } from "./grant.ts";
import {
  BOT_SCOPES,
  DEFAULT_BOT_SCOPES,
  emptyBotRegistry,
  hashBotToken,
  knownBotScope,
  newBotToken,
  summarizeBot,
  validBotName,
  type BotEnvelopeKey,
  type BotRegistry,
  type BotScope,
  type BotSummary,
} from "./registry.ts";

export interface BotAdminDeps {
  store: MailStore;
  /** Jon's envelope key. A bot key must be a different key. */
  publicJwk: EcPublicJwk;
  now: () => Date;
  audit: (action: string, outcome: string, detail: string) => Promise<void>;
}

export interface BotRegistryView {
  killSwitch: boolean;
  bots: BotSummary[];
  envelopeKey: BotEnvelopeKey | null;
  updatedAt: string | null;
}

const MAX_BOTS = 20;

function approvalFlag(value: unknown): boolean {
  if (value === true) return true;
  if (value === false) return false;
  throw new MailError("approvalRequired must be true or false", "invalid");
}

export function botScopes(value: unknown): BotScope[] {
  if (value === undefined) return [...DEFAULT_BOT_SCOPES];
  if (!Array.isArray(value) || value.length === 0) throw new MailError("scopes must be a non-empty list", "invalid");
  const scopes = value.map((item) => {
    const scope = typeof item === "string" ? knownBotScope(item) : null;
    if (!scope) throw new MailError(`A bot cannot hold the scope ${String(item)}. Bot scopes: ${BOT_SCOPES.join(", ")}`, "invalid");
    return scope;
  });
  if (!scopes.includes("read")) throw new MailError("Every bot needs the read scope", "invalid");
  if (scopes.includes("send-approved") && !scopes.includes("write")) throw new MailError("send-approved needs write (the bot drafts what it sends)", "invalid");
  if (scopes.includes("send-new") && !scopes.includes("send-approved")) throw new MailError("send-new only widens send-approved; grant both", "invalid");
  return [...new Set(scopes)];
}

function cleanPublicJwk(value: unknown): EcPublicJwk {
  const jwk = (value ?? {}) as Partial<EcPublicJwk & { d: unknown }>;
  if ("d" in jwk) throw new MailError("That is a private key. Register only the public half; the private key stays with the bot.", "invalid");
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string" || !jwk.x || !jwk.y) {
    throw new MailError("publicJwk must be a P-256 EC public JWK", "invalid");
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

/** Human session only (the API enforces it). Every change is a conditional save of the one registry item. */
export class BotAdmin {
  constructor(private readonly deps: BotAdminDeps) {}

  async view(): Promise<BotRegistryView> {
    const registry = await persistExpiredSendGrants(this.deps.store, this.deps.now());
    return {
      killSwitch: registry?.killSwitch ?? false,
      bots: (registry?.bots ?? []).map(summarizeBot),
      envelopeKey: registry?.envelopeKey ?? null,
      updatedAt: registry?.updatedAt ?? null,
    };
  }

  private async change(apply: (registry: BotRegistry, at: string) => void): Promise<BotRegistry> {
    const at = this.deps.now();
    await persistExpiredSendGrants(this.deps.store, at);
    const stored = await this.deps.store.getBotRegistry();
    const next: BotRegistry = structuredClone(stored ?? emptyBotRegistry(at));
    apply(next, at.toISOString());
    next.version = (stored?.version ?? 0) + 1;
    next.updatedAt = at.toISOString();
    if (!(await this.deps.store.saveBotRegistry(next, stored ? stored.version : null))) {
      throw new MailError("The bot registry changed at the same time. Try again.", "conflict");
    }
    return next;
  }

  /** Returns the token once. A revoked name can be reused; a live one cannot. */
  async create(name: string, scopes: BotScope[]): Promise<{ token: string; bot: BotSummary }> {
    if (!validBotName(name)) throw new MailError("Bot names are 1-32 lowercase letters, digits, or dashes", "invalid");
    const token = newBotToken(name);
    const registry = await this.change((registry, at) => {
      const existing = registry.bots.find((bot) => bot.name === name);
      if (existing && !existing.revokedAt) throw new MailError(`A bot named ${name} already exists. Rotate or revoke it.`, "conflict");
      if (!existing && registry.bots.length >= MAX_BOTS) throw new MailError(`At most ${MAX_BOTS} bots`, "invalid");
      registry.bots = [...registry.bots.filter((bot) => bot.name !== name), { name, tokenHash: hashBotToken(token), scopes, createdAt: at }];
    });
    await this.deps.audit("bot.created", "ok", `bot:${name} scopes:${scopes.join(",")}`);
    return { token, bot: this.summary(registry, name) };
  }

  /** The old token stops working on the next request. */
  async rotate(name: string): Promise<{ token: string; bot: BotSummary }> {
    const token = newBotToken(name);
    const registry = await this.change((registry, at) => {
      const bot = this.live(registry, name);
      bot.tokenHash = hashBotToken(token);
      bot.rotatedAt = at;
    });
    await this.deps.audit("bot.rotated", "ok", `bot:${name}`);
    return { token, bot: this.summary(registry, name) };
  }

  async revoke(name: string): Promise<BotSummary> {
    const registry = await this.change((registry, at) => {
      const bot = registry.bots.find((item) => item.name === name);
      if (!bot) throw new MailError(`No bot ${name}`, "not_found");
      bot.revokedAt ??= at;
    });
    await this.deps.audit("bot.revoked", "ok", `bot:${name}`);
    return this.summary(registry, name);
  }

  async setScopes(name: string, scopes: BotScope[]): Promise<BotSummary> {
    const registry = await this.change((registry) => {
      this.live(registry, name).scopes = scopes;
    });
    await this.deps.audit("bot.scopes", "ok", `bot:${name} scopes:${scopes.join(",")}`);
    return this.summary(registry, name);
  }

  async setSendLimits(name: string, value: unknown): Promise<BotSummary> {
    const body = (value ?? {}) as { expiresAt?: unknown; approvalRequired?: unknown };
    const limits = chatSendLimits(value);
    const input: SendWindowInput = { perHour: limits.perHour, perDay: limits.perDay };
    if (body.expiresAt !== undefined) input.expiresAt = body.expiresAt === null ? null : String(body.expiresAt);
    if (body.approvalRequired !== undefined) input.approvalRequired = approvalFlag(body.approvalRequired);
    return this.writeWindow(name, input, "bot.send_limits");
  }

  /** Adds send-new (or removes it, on revert) and sets the caps, expiry, and approval mode together. */
  async setSendWindow(name: string, value: unknown): Promise<BotSummary> {
    const body = (value ?? {}) as Partial<SendWindowInput>;
    if (body.revert === true) return this.writeWindow(name, { revert: true }, "bot.send_window");
    const limits = chatSendLimits({ perHour: body.perHour, perDay: body.perDay });
    const input: SendWindowInput = { perHour: limits.perHour, perDay: limits.perDay, enableSendNew: true };
    if (body.expiresAt !== undefined) input.expiresAt = body.expiresAt === null ? null : String(body.expiresAt);
    if (body.approvalRequired !== undefined) input.approvalRequired = approvalFlag(body.approvalRequired);
    return this.writeWindow(name, input, "bot.send_window");
  }

  private async writeWindow(name: string, input: SendWindowInput, action: string): Promise<BotSummary> {
    const registry = await this.change((registry, at) => {
      const index = registry.bots.findIndex((item) => item.name === name);
      const bot = this.live(registry, name);
      registry.bots[index] = applySendWindow(bot, input, new Date(at));
    });
    const bot = this.summary(registry, name);
    const grant = bot.sendGrant;
    await this.deps.audit(
      action,
      input.revert ? "reverted" : "ok",
      `bot:${name} scopes:${bot.scopes.join(",")} perHour:${bot.sendLimits?.perHour ?? ""} perDay:${bot.sendLimits?.perDay ?? ""} approval:${grant?.approvalRequired === false ? "not-required" : "required"} expires:${grant?.expiresAt ?? "none"}`,
    );
    return bot;
  }

  async setKillSwitch(on: boolean): Promise<BotRegistryView> {
    await this.change((registry) => {
      registry.killSwitch = on;
    });
    await this.deps.audit("bot.kill_switch", on ? "on" : "off", `killSwitch:${on}`);
    return this.view();
  }

  /** Mail stored from now on also gets a copy sealed to this key. Replacing a key orphans copies made for the old one. */
  async setEnvelopeKey(value: unknown): Promise<BotEnvelopeKey> {
    const publicJwk = cleanPublicJwk(value);
    const keyId = await keyFingerprint(publicJwk);
    if (keyId === (await keyFingerprint(this.deps.publicJwk))) {
      throw new MailError("That is Jon's envelope key. Generate a separate key for the bot (lojo-bot key generate).", "invalid");
    }
    const registry = await this.change((registry, at) => {
      registry.envelopeKey = { keyId, publicJwk, addedAt: at };
    });
    await this.deps.audit("bot.envelope_key", "set", `keyId:${keyId}`);
    if (!registry.envelopeKey) throw new Error("envelope key was not saved");
    return registry.envelopeKey;
  }

  async removeEnvelopeKey(): Promise<void> {
    let removed = "";
    await this.change((registry) => {
      removed = registry.envelopeKey?.keyId ?? "";
      delete registry.envelopeKey;
    });
    await this.deps.audit("bot.envelope_key", "removed", `keyId:${removed || "none"}`);
  }

  private live(registry: BotRegistry, name: string) {
    const bot = registry.bots.find((item) => item.name === name);
    if (!bot) throw new MailError(`No bot ${name}`, "not_found");
    if (bot.revokedAt) throw new MailError(`Bot ${name} is revoked. Create it again for a new token.`, "invalid");
    return bot;
  }

  private summary(registry: BotRegistry, name: string): BotSummary {
    const bot = registry.bots.find((item) => item.name === name);
    if (!bot) throw new Error(`bot ${name} vanished`);
    return summarizeBot(bot);
  }
}
