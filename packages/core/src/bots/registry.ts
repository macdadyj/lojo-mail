import { randomBytes } from "node:crypto";
import { sameHash } from "../approval.ts";
import { sha256 } from "../ids.ts";
import type { EcPublicJwk } from "../types.ts";

import type { ChatSendLimits } from "./chat-send.ts";

/**
 * What a bot credential can hold. Never send, compose, client-send or admin:
 * a bot's drafts wait for Jon unless he grants `send-approved` (replies he
 * approved in chat, bots/chat-send.ts), and `test-send` only ever reaches
 * LOJO_TEST_RECIPIENT. `send-new` widens `send-approved` to new recipients.
 */
export type BotScope = "read" | "write" | "body" | "trash" | "rules" | "test-send" | "send-approved" | "send-new";

export const BOT_SCOPES = ["read", "write", "body", "trash", "rules", "test-send", "send-approved", "send-new"] as const satisfies readonly BotScope[];
export const DEFAULT_BOT_SCOPES: readonly BotScope[] = ["read", "write", "body"];

export const BOT_TOKEN_PREFIX = "lbt_";
const BOT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface BotRecord {
  name: string;
  /** SHA-256 of the whole token. The token itself is shown once, at create or rotate. */
  tokenHash: string;
  scopes: BotScope[];
  createdAt: string;
  rotatedAt?: string;
  revokedAt?: string;
  /** Chat-approved send limits Jon set; DEFAULT_CHAT_SEND_LIMITS when absent. */
  sendLimits?: ChatSendLimits;
}

/** The public half of the bot's envelope key. The private half stays on Santa with the bot. */
export interface BotEnvelopeKey {
  keyId: string;
  publicJwk: EcPublicJwk;
  addedAt: string;
}

export interface BotRegistry {
  /** Bumped on every save; saves are conditional on it. */
  version: number;
  /** On: every bot token is refused, whatever its own state. */
  killSwitch: boolean;
  bots: BotRecord[];
  envelopeKey?: BotEnvelopeKey;
  updatedAt: string;
}

/** A bot as the admin API shows it: never the hash. */
export type BotSummary = Omit<BotRecord, "tokenHash">;

export function emptyBotRegistry(at: Date): BotRegistry {
  return { version: 0, killSwitch: false, bots: [], updatedAt: at.toISOString() };
}

export function knownBotScope(value: string): BotScope | null {
  return (BOT_SCOPES as readonly string[]).includes(value) ? (value as BotScope) : null;
}

export function validBotName(name: string): boolean {
  return BOT_NAME.test(name);
}

export function newBotToken(name: string): string {
  if (!validBotName(name)) throw new Error("Bot names are 1-32 lowercase letters, digits, or dashes");
  return `${BOT_TOKEN_PREFIX}${name}_${randomBytes(32).toString("base64url")}`;
}

export function hashBotToken(token: string): string {
  return sha256(token);
}

/** The name a bot token claims. Names never contain `_`, so the first one after the prefix ends it. */
export function botNameOf(token: string): string | null {
  if (!token.startsWith(BOT_TOKEN_PREFIX)) return null;
  const rest = token.slice(BOT_TOKEN_PREFIX.length);
  const end = rest.indexOf("_");
  if (end <= 0) return null;
  const name = rest.slice(0, end);
  return validBotName(name) && rest.length - end - 1 >= 32 ? name : null;
}

export type BotCheck = { ok: true; bot: BotRecord } | { ok: false; reason: "malformed" | "kill_switch" | "unknown" | "revoked" | "bad_token" };

export function checkBotToken(registry: BotRegistry | null, token: string): BotCheck {
  const name = botNameOf(token);
  if (!name) return { ok: false, reason: "malformed" };
  if (!registry) return { ok: false, reason: "unknown" };
  if (registry.killSwitch) return { ok: false, reason: "kill_switch" };
  const bot = registry.bots.find((item) => item.name === name);
  if (!bot) return { ok: false, reason: "unknown" };
  if (bot.revokedAt) return { ok: false, reason: "revoked" };
  if (!sameHash(bot.tokenHash, hashBotToken(token))) return { ok: false, reason: "bad_token" };
  return { ok: true, bot };
}

export function summarizeBot(bot: BotRecord): BotSummary {
  const { tokenHash: _hash, ...rest } = bot;
  return rest;
}
