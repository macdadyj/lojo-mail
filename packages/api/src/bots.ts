import { AsyncLocalStorage } from "node:async_hooks";
import {
  BOT_TOKEN_PREFIX,
  BotAdmin,
  botBackfillCandidates,
  botScopes,
  checkBotToken,
  DEFAULT_CHAT_SEND_LIMITS,
  MailError,
  persistExpiredSendGrants,
  sendNewApprovalRequired,
  newId,
  readBotCopy,
  storeBotCopy,
  utcDay,
  type BotCheck,
  type Mailbox,
} from "@lojo/core";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { hasScope, type Principal, type Scope } from "./auth.ts";

/** Every bot principal's label starts with this; nothing else may. */
export const BOT_LABEL_PREFIX = "bot:";

/** Who the current request is, for the audit log. Set by the API's auth middleware around each handler. */
export const requestActor = new AsyncLocalStorage<string>();

export function auditActorFromRequest(): string | undefined {
  return requestActor.getStore();
}

export function actorLabel(principal: Principal): string {
  return principal.kind === "human" ? "human" : principal.label;
}

export function isBot(principal: Principal): boolean {
  return principal.kind === "token" && principal.label.startsWith(BOT_LABEL_PREFIX);
}

export function bearerOf(authorization: string | undefined): string {
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
}

export function isBotBearer(authorization: string | undefined): boolean {
  return bearerOf(authorization).startsWith(BOT_TOKEN_PREFIX);
}

type Refusal = Exclude<BotCheck, { ok: true }>["reason"];

function refusalMessage(reason: Refusal): string {
  switch (reason) {
    case "kill_switch":
      return "Bot access is switched off";
    case "revoked":
      return "This bot credential was revoked";
    case "malformed":
    case "unknown":
    case "bad_token":
      return "unauthorized";
    default: {
      const unexpected: never = reason;
      throw new Error(`Unknown refusal ${String(unexpected)}`);
    }
  }
}

/** One registry read per request, so revoke, rotate and the kill switch apply to the very next call. */
export async function botPrincipal(mailbox: Mailbox, authorization: string | undefined): Promise<{ principal: Principal } | { error: string }> {
  const registry = await persistExpiredSendGrants(mailbox.store, mailbox.currentTime());
  const check = checkBotToken(registry, bearerOf(authorization));
  if (!check.ok) return { error: refusalMessage(check.reason) };
  return { principal: { kind: "token", label: `${BOT_LABEL_PREFIX}${check.bot.name}`, scopes: check.bot.scopes as Scope[] } };
}

/** One audit row per bot request: method, path (ids, never query strings or bodies) and status. */
export async function auditBotRequest(mailbox: Mailbox, principal: Principal, method: string, path: string, status: number): Promise<void> {
  const at = new Date();
  await mailbox.store.putAudit({
    id: newId("aud"),
    day: utcDay(at),
    at: at.toISOString(),
    action: "bot.request",
    outcome: String(status),
    detail: `${method} ${path}`.slice(0, 300),
    actor: principal.label,
  });
}

type Vars = { principal: Principal };
type Env = { Variables: Vars };

export interface BotRouteDeps {
  mailbox: Mailbox;
  need: (requirement: Scope | "human") => MiddlewareHandler<Env>;
  body: <T>(c: Context<Env>) => Promise<Partial<T>>;
}

function requireBot(c: Context<Env>): string {
  const principal = c.get("principal");
  if (!isBot(principal)) throw new MailError("This route is for bot credentials", "forbidden");
  return principal.label;
}

function limitOf(value: string | undefined, fallback: number, max: number): number {
  const raw = Number(value ?? fallback);
  return Number.isInteger(raw) ? Math.min(Math.max(raw, 1), max) : fallback;
}

/**
 * `/v1/bots/*` is Jon's (human session): create, rotate, revoke, scopes, the
 * kill switch, the bot envelope key and backfill. `/v1/bot/*` and the bot-only
 * routes beside it are what a bot credential calls.
 */
export function registerBotRoutes(app: Hono<Env>, deps: BotRouteDeps): void {
  const { mailbox, need, body } = deps;
  const admin = new BotAdmin({
    store: mailbox.store,
    publicJwk: mailbox.publicJwk,
    now: () => mailbox.currentTime(),
    audit: async (action, outcome, detail) => {
      const at = mailbox.currentTime();
      await mailbox.store.putAudit({ id: newId("aud"), day: utcDay(at), at: at.toISOString(), action, outcome, detail, actor: "human" });
    },
  });

  app.get("/v1/bots", need("human"), async (c) => c.json(await admin.view()));
  app.post("/v1/bots", need("human"), async (c) => {
    const input = await body<{ name: string; scopes: string[] }>(c);
    if (typeof input.name !== "string") throw new MailError("name is required", "invalid");
    return c.json(await admin.create(input.name, botScopes(input.scopes)), 201);
  });
  app.post("/v1/bots/kill-switch", need("human"), async (c) => {
    const input = await body<{ on: boolean }>(c);
    if (typeof input.on !== "boolean") throw new MailError("on must be true or false", "invalid");
    return c.json(await admin.setKillSwitch(input.on));
  });
  app.put("/v1/bots/envelope-key", need("human"), async (c) => c.json(await admin.setEnvelopeKey((await body<{ publicJwk: unknown }>(c)).publicJwk)));
  app.post("/v1/bots/envelope-key/remove", need("human"), async (c) => {
    await admin.removeEnvelopeKey();
    return c.json(await admin.view());
  });
  app.get("/v1/bots/backfill", need("human"), async (c) => c.json(await botBackfillCandidates(mailbox.store, limitOf(c.req.query("limit"), 100, 1000))));
  app.post("/v1/bots/copies/:messageId", need("human"), async (c) => {
    const input = await body<{ keyId: string; envelope: unknown }>(c);
    return c.json(await storeBotCopy(mailbox.store, mailbox.blobs, c.req.param("messageId"), input.keyId, input.envelope));
  });
  app.post("/v1/bots/:name/rotate", need("human"), async (c) => c.json(await admin.rotate(c.req.param("name"))));
  app.post("/v1/bots/:name/revoke", need("human"), async (c) => c.json(await admin.revoke(c.req.param("name"))));
  app.post("/v1/bots/:name/scopes", need("human"), async (c) => c.json(await admin.setScopes(c.req.param("name"), botScopes((await body<{ scopes: string[] }>(c)).scopes))));

  app.get("/v1/bot/whoami", async (c) => {
    const label = requireBot(c);
    const view = await admin.view();
    const me = view.bots.find((bot) => `${BOT_LABEL_PREFIX}${bot.name}` === label);
    return c.json({
      bot: label,
      scopes: c.get("principal").scopes,
      envelopeKeyId: view.envelopeKey?.keyId ?? null,
      sendFrom: mailbox.config.mailbox,
      sendLimits: me?.sendLimits ?? DEFAULT_CHAT_SEND_LIMITS,
      sendGrant: me?.sendGrant ?? null,
    });
  });
  /** The bot's sealed copy of the body. Only the bot's private key, on Santa, opens it. */
  app.get("/v1/messages/:id/bot-copy", need("read"), need("body"), async (c) => {
    requireBot(c);
    return c.json({ id: c.req.param("id"), ...(await readBotCopy(mailbox.store, mailbox.blobs, c.req.param("id"))) });
  });
  app.put("/v1/rules/bot-rules/:id", need("rules"), async (c) => {
    requireBot(c);
    const input = await body<Record<string, unknown>>(c);
    if (input.id !== undefined && input.id !== c.req.param("id")) throw new MailError("The rule id in the body must match the path", "invalid");
    return c.json({ rules: await mailbox.putBotRule({ ...input, id: c.req.param("id") }) });
  });
  app.post("/v1/rules/bot-rules/:id/delete", need("rules"), async (c) => {
    requireBot(c);
    return c.json({ rules: await mailbox.deleteBotRule(c.req.param("id")) });
  });
  app.post("/v1/bots/:name/send-limits", need("human"), async (c) => c.json(await admin.setSendLimits(c.req.param("name"), await body<unknown>(c))));
  app.post("/v1/bots/:name/send-window", need("human"), async (c) => c.json(await admin.setSendWindow(c.req.param("name"), await body<unknown>(c))));

  /**
   * Chat-approved replies (`send-approved`). The server cannot see the chat:
   * it checks the content hash, recipients, note and rate, and the approval
   * itself is the bot's attestation (docs/BOT.md).
   */
  app.get("/v1/bot/drafts/:id/review", need("send-approved"), async (c) => {
    requireBot(c);
    return c.json(await mailbox.chatSendReview(c.req.param("id"), hasScope(c.get("principal").scopes, "send-new")));
  });
  app.post("/v1/bot/drafts/:id/send-approved", need("send-approved"), async (c) => {
    const bot = requireBot(c);
    const input = await body<{ contentHash: string; approvalSource: string; approvalNote: string }>(c);
    const registry = await persistExpiredSendGrants(mailbox.store, mailbox.currentTime());
    const record = registry?.bots.find((item) => `${BOT_LABEL_PREFIX}${item.name}` === bot);
    return c.json(
      await mailbox.botChatSend({
        bot,
        draftId: c.req.param("id"),
        contentHash: input.contentHash,
        approvalSource: input.approvalSource,
        approvalNote: input.approvalNote,
        allowNew: record?.scopes.includes("send-new") ?? false,
        limits: record?.sendLimits ?? DEFAULT_CHAT_SEND_LIMITS,
      }),
    );
  });
  /**
   * Brand-new mail (`send-new`). Without contentHash this composes or reviews
   * and does not send. With it, the server sends that exact content.
   */
  app.post("/v1/bot/send-new", need("write"), need("send-new"), async (c) => {
    const bot = requireBot(c);
    const input = await body<{ draftId?: string; contentHash?: string; approvalNote?: string; to?: string[]; cc?: string[]; bcc?: string[]; subject?: string; text?: string }>(c);
    const now = mailbox.currentTime();
    const registry = await persistExpiredSendGrants(mailbox.store, now);
    const record = registry?.bots.find((item) => `${BOT_LABEL_PREFIX}${item.name}` === bot);
    if (!record?.scopes.includes("send-new")) throw new MailError("send-new is off", "forbidden");
    const approvalRequired = sendNewApprovalRequired(record, now);
    const expiresAt = record.sendGrant?.expiresAt ?? null;
    if (typeof input.draftId === "string" && input.draftId) {
      if (typeof input.contentHash !== "string") {
        const review = await mailbox.chatSendReview(input.draftId, true);
        const blocks = mailbox.sendNewBlocks(await mailbox.getDraft(input.draftId).then((view) => view.draft));
        return c.json({ ...review, recipientRefusals: [...review.recipientRefusals, ...blocks], sendable: review.sendable && blocks.length === 0, sent: false, approvalRequired, expiresAt });
      }
      return c.json(
        await mailbox.botSendNew({
          bot,
          draftId: input.draftId,
          contentHash: input.contentHash,
          approvalNote: input.approvalNote,
          approvalRequired,
          limits: record.sendLimits ?? DEFAULT_CHAT_SEND_LIMITS,
        }),
      );
    }
    const draft = await mailbox.composeBotSendNew(input);
    const review = await mailbox.chatSendReview(draft.id, true);
    return c.json({ ...review, sent: false, approvalRequired, expiresAt }, 201);
  });
  app.post("/v1/bot/test-send", need("test-send"), async (c) => {
    const bot = requireBot(c);
    const input = await body<{ subject: string; text: string }>(c);
    if (typeof input.subject !== "string" || typeof input.text !== "string") throw new MailError("subject and text are required", "invalid");
    return c.json(await mailbox.botTestSend({ bot, subject: input.subject, text: input.text }));
  });
}
