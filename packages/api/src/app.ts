import { FOLDERS, keyFingerprint, MailError, type Actor, type Folder, type Mailbox, type PgpMode, type ReviewedDraft, type TrashActor, type ViewOptions } from "@lojo/core";
import { HttpMailClient } from "@lojo/mcp/http";
import { handleMcpPost, mcpMethodNotAllowed, type McpHttpReply } from "@lojo/mcp/remote";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { BRIDGE_LABEL, hasScope, type Principal, type Scope, type TokenBook } from "./auth.ts";
import { actorLabel, auditBotRequest, BOT_LABEL_PREFIX, botPrincipal, isBot, isBotBearer, registerBotRoutes, requestActor } from "./bots.ts";
import { LoginRateLimited, sourceKey, type LoginThrottle, type Sessions } from "./session.ts";

interface AppDeps {
  mailbox: Mailbox;
  tokens: TokenBook;
  /** Human sign-in. Without it no route that needs a human can be reached. */
  sessions?: Sessions | null;
  loginThrottle: LoginThrottle;
  /** The caller's address as the platform reports it (API Gateway `sourceIp`, the socket locally). Never a request header. */
  clientAddress: (c: Context<Env>) => string | undefined;
  dev: boolean;
  corsOrigin?: string[];
  info: { mailbox: string; domain: string; llmProvider: string; embedProvider?: string; dailyTokenBudget: number; autoSendEnabled?: boolean };
  /** One entry per authenticated request, so each token's use can be traced. Never bodies or query strings. */
  accessLog?: (entry: AccessLogEntry) => void;
}

export interface AccessLogEntry {
  principal: string;
  method: string;
  path: string;
  status: number;
}

type Vars = { principal: Principal };
type Env = { Variables: Vars };
type Requirement = Scope | "human";

const PUBLIC_PATHS = new Set(["/v1/health", "/v1/session/login"]);

function statusFor(error: MailError): 400 | 403 | 404 | 409 | 413 | 423 | 429 | 502 | 503 {
  switch (error.code) {
    case "not_found":
      return 404;
    case "locked":
      return 423;
    case "forbidden":
      return 403;
    case "conflict":
      return 409;
    case "upstream":
      return 502;
    case "unavailable":
      return 503;
    case "rate_limited":
      return 429;
    case "too_large":
      return 413;
    case "invalid":
    case "budget":
      return 400;
    default: {
      const unexpected: never = error.code;
      throw new Error(`Unhandled mail error ${String(unexpected)}`);
    }
  }
}

function satisfies(principal: Principal, requirement: Requirement): boolean {
  if (requirement === "human") return principal.kind === "human";
  return hasScope(principal.scopes, requirement);
}

const need = (requirement: Requirement) =>
  createMiddleware<Env>(async (c, next) => {
    if (!satisfies(c.get("principal"), requirement)) {
      return c.json({ error: requirement === "human" ? "This needs a signed-in human session" : "forbidden", scope: requirement }, 403);
    }
    await next();
  });

async function body<T>(c: Context<Env>): Promise<Partial<T>> {
  try {
    const parsed: unknown = await c.req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Partial<T>;
  } catch {
    throw new MailError("Request body must be a JSON object", "invalid");
  }
}

function actorOf(principal: Principal): Actor {
  return principal.kind === "human" ? "human" : "agent";
}

/** Soft delete is Jon's session, or a token Jon granted `trash`: the bridge, or an agent (capped per day in the mailbox). */
function trashActorOf(principal: Principal): TrashActor {
  if (principal.kind === "human") return "human";
  if (hasScope(principal.scopes, "trash")) {
    if (principal.label === BRIDGE_LABEL) return "bridge";
    if (principal.label.startsWith("agent:")) return `agent:${principal.label.slice("agent:".length)}`;
    if (isBot(principal)) return `bot:${principal.label.slice(BOT_LABEL_PREFIX.length)}`;
  }
  throw new MailError("Moving mail to trash needs a signed-in human or a token with the trash scope", "forbidden");
}

/** Jon's mail client. Its credential is never an agent: it cannot reach MCP. */
function isBridge(principal: Principal): boolean {
  return principal.label === BRIDGE_LABEL || principal.scopes.includes("client-send");
}

function isMcpScope(scope: Scope): scope is Exclude<Scope, "client-send" | "rules" | "test-send"> {
  return scope !== "client-send" && scope !== "rules" && scope !== "test-send";
}

const MAX_CLIENT_SEND_BASE64 = 6_000_000;
/** One file per request, base64 in JSON, inside Lambda's 6 MB synchronous payload limit. */
const MAX_ATTACHMENT_BASE64 = 5_600_000;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function sha256List(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && SHA256_HEX.test(item))) return null;
  return value as string[];
}

/** Only Jon's own mail client (the `compose` scope) may draft to people the mailbox has never written to. */
function draftOriginOf(principal: Principal): "human" | "agent" | "client" {
  if (principal.kind === "human") return "human";
  return principal.scopes.includes("compose") ? "client" : "agent";
}

/** Draft text can quote sealed mail, so it needs `body` or a human session. */
function canReadText(principal: Principal): boolean {
  return principal.kind === "human" || hasScope(principal.scopes, "body");
}

function wantsFlag(c: Context<Env>, name: string): boolean {
  const value = c.req.query(name);
  return value === "1" || value === "true";
}

function requireBodyScope(c: Context<Env>, wanted: boolean): boolean {
  if (wanted && !canReadText(c.get("principal"))) throw new MailError("Reading mail text needs the body scope", "forbidden");
  return wanted;
}

/** Views never carry body text or sealed AI output for a caller without `body`, even where the server could open them. */
function views(c: Context<Env>, withContext = false): ViewOptions {
  return { withContext: requireBodyScope(c, withContext), withBody: canReadText(c.get("principal")) };
}

function strings(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new MailError(`${field} must be an array of strings`, "invalid");
  }
  return value;
}

function pgpMode(value: unknown): PgpMode | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "off") return value;
  throw new MailError("pgp must be auto or off", "invalid");
}

function folder(value: unknown): Folder {
  if (typeof value === "string" && (FOLDERS as readonly string[]).includes(value)) return value as Folder;
  throw new MailError(`folder must be one of ${FOLDERS.join(", ")}`, "invalid");
}

function mcpResponse(out: McpHttpReply): Response {
  return new Response(out.body, { status: out.status, headers: out.headers });
}

const MCP_CHALLENGE = { "www-authenticate": 'Bearer realm="lojo-mail", error="invalid_token"' };

function safeFilename(name: string): string {
  return name.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "attachment";
}

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();
  const { mailbox } = deps;
  if (deps.corsOrigin && deps.corsOrigin.length > 0) {
    app.use("*", cors({ origin: deps.corsOrigin, allowHeaders: ["authorization", "content-type"] }));
  }

  // API Gateway forwards OPTIONS to the $default route instead of answering the preflight itself.
  // The gateway's CORS configuration adds the allow-* headers to this response; the browser needs a 2xx.
  app.options("*", (c) => c.body(null, 204));

  app.get("/v1/health", (c) => c.json({ ok: true, unlocked: mailbox.unlocked }));

  app.post("/v1/session/login", async (c) => {
    if (!deps.sessions) return c.json({ error: "Human sign-in is not configured" }, 503);
    const input = await body<{ passphrase: string }>(c);
    const source = sourceKey(deps.clientAddress(c));
    try {
      await deps.loginThrottle.check(source);
    } catch (error) {
      if (!(error instanceof LoginRateLimited)) throw error;
      return c.json({ error: error.message }, 429, { "retry-after": String(error.retryAfterSeconds) });
    }
    try {
      return c.json(deps.sessions.login(typeof input.passphrase === "string" ? input.passphrase : ""));
    } catch {
      await deps.loginThrottle.fail(source);
      return c.json({ error: "Wrong passphrase" }, 401);
    }
  });

  /**
   * Remote MCP (Streamable HTTP). API tokens only: a web session bearer
   * is refused so a browser tab can never be turned into an agent. Tool
   * calls re-enter this app with the caller's token, so the same `need()`
   * checks guard every route and nothing here can send mail.
   */
  app.post("/mcp", async (c) => {
    const origin = c.req.header("origin");
    if (origin && !(deps.corsOrigin ?? []).includes(origin)) return c.json({ error: "origin not allowed" }, 403);
    const authorization = c.req.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
    if (token.startsWith("hs_")) return c.json({ error: "MCP takes an API token, not a web session" }, 403);
    if (isBotBearer(authorization)) return c.json({ error: "Bot credentials use the lojo-bot MCP server on Santa, not remote MCP" }, 403);
    const principal = deps.tokens.principal(authorization, null);
    if (!principal) return c.json({ error: "unauthorized" }, 401, MCP_CHALLENGE);
    if (isBridge(principal)) return c.json({ error: "The Thunderbird bridge token cannot be used for MCP" }, 403);
    const mailbox = new HttpMailClient("http://lojo.internal", token, (url, init) => Promise.resolve(app.request(url, init)));
    const reply = mcpResponse(await handleMcpPost(await c.req.text(), c.req.raw.headers, { label: principal.label, scopes: principal.scopes.filter(isMcpScope), mailbox }));
    deps.accessLog?.({ principal: principal.label, method: "POST", path: "/mcp", status: reply.status });
    return reply;
  });
  app.on(["GET", "DELETE", "PUT", "PATCH"], "/mcp", () => mcpResponse(mcpMethodNotAllowed()));

  app.use("/v1/*", async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();
    const authorization = c.req.header("authorization");
    let principal: Principal | null;
    if (isBotBearer(authorization)) {
      const bot = await botPrincipal(mailbox, authorization);
      if ("error" in bot) return c.json({ error: bot.error }, 401);
      principal = bot.principal;
    } else {
      principal = deps.tokens.principal(authorization, deps.sessions);
    }
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    c.set("principal", principal);
    await requestActor.run(actorLabel(principal), next);
    deps.accessLog?.({ principal: principal.label, method: c.req.method, path: c.req.path, status: c.res.status });
    if (isBot(principal)) await auditBotRequest(mailbox, principal, c.req.method, c.req.path, c.res.status);
  });

  app.get("/v1/session", (c) => {
    const { kind, label, scopes } = c.get("principal");
    return c.json({ kind, label, scopes, sendFrom: mailbox.config.sendFrom });
  });

  app.get("/v1/inbox", need("read"), async (c) => c.json({ messages: await mailbox.listInbox(50, views(c)) }));
  /** Newest first, up to `limit` (1-5000, default 500). Metadata only unless the caller has `body`. */
  app.get("/v1/folders/:folder/messages", need("read"), async (c) => {
    const raw = Number(c.req.query("limit") ?? "500");
    const limit = Number.isInteger(raw) ? Math.min(Math.max(raw, 1), 5000) : 500;
    return c.json({ messages: await mailbox.listFolder(folder(c.req.param("folder")), limit, views(c)) });
  });
  app.get("/v1/triage", need("read"), async (c) => c.json({ messages: await mailbox.triage(50, views(c)) }));
  app.get("/v1/threads/:id", need("read"), async (c) => c.json(await mailbox.readThread(c.req.param("id"), views(c, wantsFlag(c, "context")))));
  /** A summary is message text, so it needs `body`; `write` because it spends tokens. */
  app.post("/v1/threads/:id/summarize", need("write"), need("body"), async (c) =>
    c.json({ summary: await mailbox.summarizeThread(c.req.param("id")) }),
  );
  app.get("/v1/messages/:id", need("read"), async (c) =>
    c.json(await mailbox.present(await mailbox.getMessage(c.req.param("id")), views(c, wantsFlag(c, "context")))),
  );
  app.get("/v1/messages/:id/body", need("read"), async (c) => {
    const message = await mailbox.getMessage(c.req.param("id"));
    return c.json({ id: message.id, envelope: await mailbox.bodyEnvelope(message) });
  });
  app.get("/v1/messages/:id/attachments/:attId", need("read"), async (c) => {
    const payload = await mailbox.attachment(c.req.param("id"), c.req.param("attId"));
    if (payload.url) return c.json({ meta: payload.meta, url: payload.url });
    if (payload.envelope) return c.json({ meta: payload.meta, envelope: payload.envelope });
    if (!payload.bytes) throw new MailError("Attachment is unavailable", "not_found");
    return c.body(payload.bytes as Uint8Array<ArrayBuffer>, 200, {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${safeFilename(payload.meta.filename)}"`,
      "x-content-type-options": "nosniff",
    });
  });
  app.post("/v1/search", need("read"), async (c) => {
    const input = await body<{ query: string; mode: "keyword" | "semantic"; context: boolean }>(c);
    if (typeof input.query !== "string" || !input.query) throw new MailError("query is required", "invalid");
    const mode = input.mode === "semantic" ? "semantic" : "keyword";
    // Vectors are derived from body text, so ranking by them is a body-text oracle.
    requireBodyScope(c, mode === "semantic");
    return c.json({ messages: await mailbox.search(input.query, mode, views(c, input.context === true)) });
  });

  /** Embeds recent mail that has no vector from the current embedder. Reads server-side text, so it needs `body`. */
  app.post("/v1/vectors/backfill", need("write"), need("body"), async (c) => {
    const input = c.req.header("content-type")?.includes("application/json") ? await body<{ limit: number }>(c) : {};
    const limit = typeof input.limit === "number" && Number.isInteger(input.limit) ? Math.min(Math.max(input.limit, 1), 50) : 25;
    return c.json(await mailbox.backfillVectors(limit));
  });

  app.get("/v1/drafts", need("read"), async (c) => {
    const withText = requireBodyScope(c, wantsFlag(c, "text"));
    return c.json({ drafts: await mailbox.listDrafts({ withText }) });
  });
  app.get("/v1/drafts/:id", need("read"), async (c) => {
    const withText = requireBodyScope(c, wantsFlag(c, "text"));
    return c.json(await mailbox.getDraft(c.req.param("id"), { withText }));
  });
  app.post("/v1/drafts", need("write"), async (c) => {
    const input = await body<{ to: string[]; cc: string[]; subject: string; text: string; threadId: string; inReplyTo: string; pgp: PgpMode; clientMessageId: string }>(c);
    const to = strings(input.to, "to");
    const principal = c.get("principal");
    const origin = draftOriginOf(principal);
    if (!to || (to.length === 0 && origin !== "client") || typeof input.subject !== "string" || typeof input.text !== "string") {
      throw new MailError("to, subject, and text are required", "invalid");
    }
    const pgp = pgpMode(input.pgp);
    const draft = await mailbox.createDraft({
      to,
      cc: strings(input.cc, "cc"),
      subject: input.subject,
      text: input.text,
      ...(typeof input.threadId === "string" ? { threadId: input.threadId } : {}),
      ...(typeof input.inReplyTo === "string" ? { inReplyTo: input.inReplyTo } : {}),
      ...(pgp ? { pgp } : {}),
      ...(origin === "client" && typeof input.clientMessageId === "string" ? { clientMessageId: input.clientMessageId } : {}),
      origin,
    });
    return c.json(await mailbox.getDraft(draft.id, { withText: canReadText(principal) }), 201);
  });
  app.post("/v1/messages/:id/draft-reply", need("write"), async (c) => {
    const input = c.req.header("content-type")?.includes("application/json") ? await body<{ sourceText: string }>(c) : {};
    const draft = await mailbox.draftReply(c.req.param("id"), typeof input.sourceText === "string" ? { sourceText: input.sourceText } : {});
    return c.json(await mailbox.getDraft(draft.id, { withText: canReadText(c.get("principal")) }), 201);
  });
  app.post("/v1/drafts/:id", need("write"), async (c) => {
    const input = await body<{ text: string; to: string[]; cc: string[]; subject: string; pgp: PgpMode }>(c);
    const principal = c.get("principal");
    const pgp = pgpMode(input.pgp);
    const to = strings(input.to, "to");
    const cc = strings(input.cc, "cc");
    const draft = await mailbox.updateDraft(
      c.req.param("id"),
      {
        ...(typeof input.text === "string" ? { text: input.text } : {}),
        ...(typeof input.subject === "string" ? { subject: input.subject } : {}),
        ...(to ? { to } : {}),
        ...(cc ? { cc } : {}),
        ...(pgp ? { pgp } : {}),
      },
      actorOf(principal),
    );
    return c.json(await mailbox.getDraft(draft.id, { withText: canReadText(principal) }));
  });
  app.post("/v1/drafts/:id/rewrite", need("write"), async (c) => {
    const input = await body<{ instruction: string }>(c);
    if (typeof input.instruction !== "string" || !input.instruction) throw new MailError("instruction is required", "invalid");
    const { draft } = await mailbox.rewrite(c.req.param("id"), input.instruction);
    return c.json(await mailbox.getDraft(draft.id, { withText: canReadText(c.get("principal")) }));
  });
  app.post("/v1/drafts/:id/submit", need("write"), async (c) => {
    const draft = await mailbox.submitForApproval(c.req.param("id"));
    return c.json(await mailbox.getDraft(draft.id));
  });
  app.post("/v1/drafts/:id/discard", need("write"), async (c) => {
    const draft = await mailbox.discardDraft(c.req.param("id"));
    return c.json(await mailbox.getDraft(draft.id));
  });
  /** Bots may attach too (`write`); only Jon's approval, which names every file by hash, can send them. */
  app.post("/v1/drafts/:id/attachments", need("write"), async (c) => {
    const input = await body<{ filename: string; contentType: string; sha256: string; data: string }>(c);
    if (typeof input.filename !== "string" || typeof input.data !== "string" || typeof input.sha256 !== "string" || !SHA256_HEX.test(input.sha256)) {
      throw new MailError("filename, sha256 (hex), and data (base64) are required", "invalid");
    }
    if (input.data.length > MAX_ATTACHMENT_BASE64) throw new MailError("The file is too large for one message", "too_large");
    const data = input.data.replace(/\s+/g, "");
    if (!BASE64.test(data)) throw new MailError("data must be base64", "invalid");
    const principal = c.get("principal");
    const draft = await mailbox.addDraftAttachment(
      c.req.param("id"),
      {
        filename: input.filename,
        contentType: typeof input.contentType === "string" ? input.contentType : "",
        sha256: input.sha256,
        data: new Uint8Array(Buffer.from(data, "base64")),
      },
      actorOf(principal),
    );
    return c.json(await mailbox.getDraft(draft.id, { withText: canReadText(principal) }));
  });
  app.post("/v1/drafts/:id/attachments/:attId/remove", need("write"), async (c) => {
    const principal = c.get("principal");
    const draft = await mailbox.removeDraftAttachment(c.req.param("id"), c.req.param("attId"), actorOf(principal));
    return c.json(await mailbox.getDraft(draft.id, { withText: canReadText(principal) }));
  });
  app.post("/v1/drafts/:id/approval", need("human"), async (c) => {
    const input = await body<ReviewedDraft>(c);
    const to = strings(input.to, "to");
    const cc = strings(input.cc, "cc");
    const pgp = pgpMode(input.pgp);
    const attachments = sha256List(input.attachments);
    if (!to || !cc || !pgp || !attachments || typeof input.subject !== "string" || typeof input.text !== "string") {
      throw new MailError("Send the reviewed to, cc, subject, text, and pgp, and attachments as a list of SHA-256 hashes", "invalid");
    }
    const reviewed: ReviewedDraft = { to, cc, subject: input.subject, text: input.text, pgp, attachments };
    return c.json(await mailbox.mintApproval(c.req.param("id"), actorOf(c.get("principal")), reviewed));
  });
  app.post("/v1/drafts/:id/approve-and-send", need("send"), async (c) => {
    const input = await body<{ approvalToken: string }>(c);
    const token = typeof input.approvalToken === "string" ? input.approvalToken : "";
    return c.json(await mailbox.approveAndSend(c.req.param("id"), token));
  });

  /**
   * Jon pressing Send in Thunderbird: the bridge relays the message as built.
   * Only `client-send` (the bridge token, when Jon enabled it) reaches this.
   */
  app.post("/v1/client/send", need("client-send"), async (c) => {
    const input = await body<{ raw: string; envelopeFrom: string; recipients: string[] }>(c);
    const recipients = strings(input.recipients, "recipients");
    if (typeof input.raw !== "string" || !input.raw || typeof input.envelopeFrom !== "string" || !recipients) {
      throw new MailError("raw (base64), envelopeFrom, and recipients are required", "invalid");
    }
    if (input.raw.length > MAX_CLIENT_SEND_BASE64) throw new MailError("The message is too large", "invalid");
    const raw = Buffer.from(input.raw, "base64");
    return c.json(await mailbox.clientSend({ raw, envelopeFrom: input.envelopeFrom, recipients }));
  });

  app.post("/v1/messages/:id/labels", need("write"), async (c) => {
    const labels = strings((await body<{ labels: string[] }>(c)).labels, "labels");
    if (!labels) throw new MailError("labels is required", "invalid");
    return c.json(await mailbox.setLabels(c.req.param("id"), labels));
  });
  app.post("/v1/messages/:id/flags", need("write"), async (c) => {
    const input = await body<{ unread: boolean }>(c);
    if (typeof input.unread !== "boolean") throw new MailError("unread must be true or false", "invalid");
    return c.json(await mailbox.setUnread(c.req.param("id"), input.unread));
  });
  app.post("/v1/messages/:id/archive", need("write"), async (c) => c.json(await mailbox.archive(c.req.param("id"))));
  app.post("/v1/messages/:id/restore", need("write"), async (c) => c.json(await mailbox.restore(c.req.param("id"))));

  app.get("/v1/rules", need("read"), async (c) => c.json({ rules: await mailbox.getRules(), autoSendEnabled: deps.info.autoSendEnabled ?? false }));
  /** Replaces the whole document. Human sessions only; tokens can only make rules safer (below). */
  app.put("/v1/rules", need("human"), async (c) => c.json({ rules: await mailbox.putRules(await body<unknown>(c), actorOf(c.get("principal"))) }));
  app.post("/v1/rules/switches", need("write"), async (c) => {
    const input = await body<{ paused: boolean; killSwitch: boolean; sendKillSwitch: boolean }>(c);
    const switches: { paused?: boolean; killSwitch?: boolean; sendKillSwitch?: boolean } = {};
    if (typeof input.paused === "boolean") switches.paused = input.paused;
    if (typeof input.killSwitch === "boolean") switches.killSwitch = input.killSwitch;
    if (typeof input.sendKillSwitch === "boolean") switches.sendKillSwitch = input.sendKillSwitch;
    if (Object.keys(switches).length === 0) throw new MailError("Send paused, killSwitch and/or sendKillSwitch as true or false", "invalid");
    return c.json({ rules: await mailbox.setRuleSwitches(switches, actorOf(c.get("principal"))) });
  });
  app.post("/v1/rules/:id/disable", need("write"), async (c) => c.json({ rules: await mailbox.disableRule(c.req.param("id"), actorOf(c.get("principal"))) }));
  app.post("/v1/rules/test", need("read"), async (c) => {
    const input = await body<{ messageId: string }>(c);
    if (typeof input.messageId !== "string" || !input.messageId) throw new MailError("messageId is required", "invalid");
    return c.json(await mailbox.testRules(input.messageId));
  });
  app.post("/v1/messages/:id/move", need("write"), async (c) => {
    const input = await body<{ folder: Folder }>(c);
    const principal = c.get("principal");
    const target = folder(input.folder);
    if (target === "trash") return c.json(await mailbox.trash(c.req.param("id"), trashActorOf(principal)));
    return c.json(await mailbox.move(c.req.param("id"), target, actorOf(principal)));
  });
  app.get("/v1/action-items", need("read"), need("body"), async (c) => c.json({ items: await mailbox.actionItems() }));
  app.get("/v1/export/index", need("read"), async (c) => c.json(await mailbox.exportIndex()));
  app.get("/v1/export", need("human"), async (c) => c.body(await mailbox.exportAll(), 200, { "content-type": "application/json" }));
  app.get("/v1/audit", need("read"), async (c) => c.json({ events: await mailbox.listAudit() }));
  app.get("/v1/labels", need("read"), async (c) => c.json({ labels: await mailbox.labels() }));
  app.get("/v1/settings", need("read"), async (c) => {
    const day = new Date().toISOString().slice(0, 10);
    return c.json({
      mailbox: deps.info.mailbox,
      domain: deps.info.domain,
      llmProvider: deps.info.llmProvider,
      embedProvider: deps.info.embedProvider ?? "none",
      dailyTokenBudget: deps.info.dailyTokenBudget,
      budgetUsed: await mailbox.store.getBudget(day),
      unlocked: mailbox.unlocked,
      envelopeKeyFingerprint: await keyFingerprint(mailbox.publicJwk),
      draftAttachments: mailbox.draftAttachmentLimits,
      dev: deps.dev,
      principal: c.get("principal").kind,
    });
  });
  app.post("/v1/session/unlock", need("human"), async (c) => {
    if (!deps.dev) return c.json({ error: "unlock is only available on the local server" }, 403);
    const input = await body<{ privateJwk: { d?: string; x?: string; y?: string } }>(c);
    const jwk = input.privateJwk;
    if (!jwk?.d || !jwk.x || !jwk.y) throw new MailError("privateJwk is required", "invalid");
    mailbox.unlock({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d });
    return c.json({ unlocked: true });
  });
  app.post("/v1/session/lock", need("human"), (c) => {
    mailbox.lock();
    return c.json({ unlocked: false });
  });

  registerBotRoutes(app, { mailbox, need, body });

  app.onError((error, c) => {
    if (error instanceof MailError) return c.json({ error: error.message, code: error.code }, statusFor(error));
    console.error(error instanceof Error ? error.message : error);
    return c.json({ error: "internal" }, 500);
  });

  return app;
}
