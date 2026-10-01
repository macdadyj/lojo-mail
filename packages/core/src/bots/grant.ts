import { MailError } from "../errors.ts";
import { newId, utcDay } from "../ids.ts";
import type { MailStore } from "../store/types.ts";
import { chatSendLimits, DEFAULT_CHAT_SEND_LIMITS, type ChatSendLimits } from "./chat-send.ts";
import type { BotRecord, BotRegistry, BotScope } from "./registry.ts";

/**
 * A timed widening of bot send. After `expiresAt`, the next API request drops
 * `send-new` and puts the caps back to DEFAULT_CHAT_SEND_LIMITS. There is no
 * scheduler: auth and `lojo-bot admin` apply it, so a late clock still cannot send.
 */
export interface BotSendGrant {
  /** ISO time. Absent means the caps and scopes stay until Jon changes them. */
  expiresAt?: string;
  /**
   * Chat approval for `send_new`. False is allowed only with an expiry still
   * in the future: a time-boxed test window, never a standing waiver.
   */
  approvalRequired: boolean;
}

/** Suggested caps for an outside-test window. The safe values are the defaults, 10/h and 30/d. */
export const TEST_WINDOW_SEND_LIMITS: ChatSendLimits = { perHour: 30, perDay: 100 };

/** A forgotten window cannot outlive this. */
export const MAX_SEND_GRANT_MS = 30 * 24 * 60 * 60 * 1000;

export interface SendWindowInput {
  /** Drop send-new, restore 10/h and 30/d, and clear the grant. */
  revert?: boolean;
  perHour?: number;
  perDay?: number;
  /** A future ISO time, or null to clear the expiry. */
  expiresAt?: string | null;
  approvalRequired?: boolean;
  /** Add `send-new`. Other scopes stay. */
  enableSendNew?: boolean;
}

export function grantExpired(grant: BotSendGrant | undefined, now: Date): boolean {
  if (!grant?.expiresAt) return false;
  const at = Date.parse(grant.expiresAt);
  return Number.isFinite(at) && at <= now.getTime();
}

/** False only inside a live window Jon marked not-required. Anything else fails closed. */
export function sendNewApprovalRequired(bot: Pick<BotRecord, "sendGrant">, now: Date): boolean {
  const grant = bot.sendGrant;
  if (!grant || grant.approvalRequired !== false) return true;
  if (grantExpired(grant, now) || !grant.expiresAt) return true;
  return false;
}

export function parseGrantExpiry(value: string, now: Date): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw new MailError("expiresAt must be an ISO-8601 time", "invalid");
  if (at <= now.getTime()) throw new MailError("expiresAt must be in the future", "invalid");
  if (at - now.getTime() > MAX_SEND_GRANT_MS) throw new MailError("A send window is at most 30 days", "invalid");
  return new Date(at).toISOString();
}

function withoutSendNew(scopes: readonly BotScope[]): BotScope[] {
  return scopes.filter((scope) => scope !== "send-new");
}

/** The bot record after Jon's command. Does not write. */
export function applySendWindow(bot: BotRecord, input: SendWindowInput, now: Date): BotRecord {
  if (input.revert) {
    const { sendGrant: _grant, ...rest } = bot;
    return { ...rest, scopes: withoutSendNew(bot.scopes), sendLimits: { ...DEFAULT_CHAT_SEND_LIMITS } };
  }
  const limits = chatSendLimits({
    perHour: input.perHour ?? bot.sendLimits?.perHour ?? DEFAULT_CHAT_SEND_LIMITS.perHour,
    perDay: input.perDay ?? bot.sendLimits?.perDay ?? DEFAULT_CHAT_SEND_LIMITS.perDay,
  });
  const scopes = [...bot.scopes];
  if (input.enableSendNew && !scopes.includes("send-new")) {
    if (!scopes.includes("write") || !scopes.includes("send-approved")) {
      throw new MailError("send-new needs write and send-approved. Grant those first.", "invalid");
    }
    scopes.push("send-new");
  }
  let expiresAt = bot.sendGrant?.expiresAt;
  if (input.expiresAt === null) expiresAt = undefined;
  else if (typeof input.expiresAt === "string") expiresAt = parseGrantExpiry(input.expiresAt, now);
  let approvalRequired = input.approvalRequired ?? bot.sendGrant?.approvalRequired ?? true;
  if (input.approvalRequired === false && !scopes.includes("send-new")) {
    throw new MailError("approval not-required applies to send-new, which this bot does not have", "invalid");
  }
  if (!scopes.includes("send-new")) approvalRequired = true;
  if (!approvalRequired && (!expiresAt || Date.parse(expiresAt) <= now.getTime())) {
    throw new MailError("approval not-required is only for a time-boxed window: set an expiry in the future", "invalid");
  }
  if (input.expiresAt === null && input.approvalRequired === false) {
    throw new MailError("Clearing the expiry also clears a waiver. Pass approval required, or set a new expiry.", "invalid");
  }
  const next: BotRecord = { ...bot, scopes, sendLimits: limits };
  if (expiresAt) next.sendGrant = { approvalRequired, expiresAt };
  else if (!approvalRequired) next.sendGrant = { approvalRequired };
  else delete next.sendGrant;
  return next;
}

export function applySendGrantExpiry(registry: BotRegistry, now: Date): { registry: BotRegistry; expired: string[] } {
  const expired: string[] = [];
  const bots = registry.bots.map((bot) => {
    if (!grantExpired(bot.sendGrant, now)) return bot;
    expired.push(bot.name);
    const { sendGrant: _grant, ...rest } = bot;
    return { ...rest, scopes: withoutSendNew(bot.scopes), sendLimits: { ...DEFAULT_CHAT_SEND_LIMITS } };
  });
  if (expired.length === 0) return { registry, expired };
  return { registry: { ...registry, bots }, expired };
}

/**
 * Writes the revert when a window has passed. On a lost race, returns the
 * effective registry anyway so this request still treats send-new as off.
 */
export async function persistExpiredSendGrants(store: MailStore, now: Date): Promise<BotRegistry | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stored = await store.getBotRegistry();
    if (!stored) return null;
    const applied = applySendGrantExpiry(stored, now);
    if (applied.expired.length === 0) return stored;
    const next: BotRegistry = { ...applied.registry, version: stored.version + 1, updatedAt: now.toISOString() };
    if (await store.saveBotRegistry(next, stored.version)) {
      for (const name of applied.expired) {
        await store.putAudit({
          id: newId("aud"),
          day: utcDay(now),
          at: now.toISOString(),
          action: "bot.send_grant_expired",
          outcome: "reverted",
          detail: `bot:${name} send-new off perHour:${DEFAULT_CHAT_SEND_LIMITS.perHour} perDay:${DEFAULT_CHAT_SEND_LIMITS.perDay}`,
          actor: "system",
        });
      }
      return next;
    }
  }
  const stored = await store.getBotRegistry();
  if (!stored) return null;
  return applySendGrantExpiry(stored, now).registry;
}
