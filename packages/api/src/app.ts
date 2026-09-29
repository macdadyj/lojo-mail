import { FOLDERS, MailError, type Actor, type Folder, type Mailbox, type PgpMode, type ReviewedDraft, type ViewOptions } from "@lojo/core";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { hasScope, type Principal, type Scope, type TokenBook } from "./auth.ts";
import { LoginRateLimited, type Sessions } from "./session.ts";

interface AppDeps {
  mailbox: Mailbox;
  tokens: TokenBook;
  /** Human sign-in. Without it no route that needs a human can be reached. */
  sessions?: Sessions | null;
  dev: boolean;
  corsOrigin?: string[];
  info: { mailbox: string; domain: string; llmProvider: string; dailyTokenBudget: number };
}

type Vars = { principal: Principal };
type Env = { Variables: Vars };
type Requirement = Scope | "human";

const PUBLIC_PATHS = new Set(["/v1/health", "/v1/session/login"]);

function statusFor(error: MailError): 400 | 403 | 404 | 409 | 423 | 502 {
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

function safeFilename(name: string): string {
  return name.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "attachment";
}

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();
  const { mailbox } = deps;
  if (deps.corsOrigin && deps.corsOrigin.length > 0) {
    app.use("*", cors({ origin: deps.corsOrigin, allowHeaders: ["authorization", "content-type"] }));
  }

  app.get("/v1/health", (c) => c.json({ ok: true, unlocked: mailbox.unlocked }));

  app.post("/v1/session/login", async (c) => {
    if (!deps.sessions) return c.json({ error: "Human sign-in is not configured" }, 503);
    const input = await body<{ passphrase: string }>(c);
    try {
      return c.json(deps.sessions.login(typeof input.passphrase === "string" ? input.passphrase : ""));
    } catch (error) {
      if (error instanceof LoginRateLimited) {
        return c.json({ error: error.message }, 429, { "retry-after": String(error.retryAfterSeconds) });
      }
      return c.json({ error: "Wrong passphrase" }, 401);
    }
  });

  app.use("/v1/*", async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();
    const principal = deps.tokens.principal(c.req.header("authorization"), deps.sessions);
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    c.set("principal", principal);
    await next();
  });

  app.get("/v1/session", (c) => {
    const { kind, label, scopes } = c.get("principal");
    return c.json({ kind, label, scopes });
  });

  app.get("/v1/inbox", need("read"), async (c) => c.json({ messages: await mailbox.listInbox(50, views(c)) }));
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
    return c.json({ messages: await mailbox.search(input.query, mode, views(c, input.context === true)) });
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
    const input = await body<{ to: string[]; cc: string[]; subject: string; text: string; threadId: string; inReplyTo: string; pgp: PgpMode }>(c);
    const to = strings(input.to, "to");
    if (!to?.length || typeof input.subject !== "string" || typeof input.text !== "string") {
      throw new MailError("to, subject, and text are required", "invalid");
    }
    const principal = c.get("principal");
    const pgp = pgpMode(input.pgp);
    const draft = await mailbox.createDraft({
      to,
      cc: strings(input.cc, "cc"),
      subject: input.subject,
      text: input.text,
      ...(typeof input.threadId === "string" ? { threadId: input.threadId } : {}),
      ...(typeof input.inReplyTo === "string" ? { inReplyTo: input.inReplyTo } : {}),
      ...(pgp ? { pgp } : {}),
      origin: principal.kind === "human" ? "human" : "agent",
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
  app.post("/v1/drafts/:id/approval", need("human"), async (c) => {
    const input = await body<ReviewedDraft>(c);
    const to = strings(input.to, "to");
    const cc = strings(input.cc, "cc");
    const pgp = pgpMode(input.pgp);
    if (!to || !cc || !pgp || typeof input.subject !== "string" || typeof input.text !== "string") {
      throw new MailError("Send the reviewed to, cc, subject, text, and pgp", "invalid");
    }
    const reviewed: ReviewedDraft = { to, cc, subject: input.subject, text: input.text, pgp };
    return c.json(await mailbox.mintApproval(c.req.param("id"), actorOf(c.get("principal")), reviewed));
  });
  app.post("/v1/drafts/:id/approve-and-send", need("send"), async (c) => {
    const input = await body<{ approvalToken: string }>(c);
    const token = typeof input.approvalToken === "string" ? input.approvalToken : "";
    return c.json(await mailbox.approveAndSend(c.req.param("id"), token));
  });

  app.post("/v1/messages/:id/labels", need("write"), async (c) => {
    const labels = strings((await body<{ labels: string[] }>(c)).labels, "labels");
    if (!labels) throw new MailError("labels is required", "invalid");
    return c.json(await mailbox.setLabels(c.req.param("id"), labels));
  });
  app.post("/v1/messages/:id/archive", need("write"), async (c) => c.json(await mailbox.archive(c.req.param("id"))));
  app.post("/v1/messages/:id/move", need("write"), async (c) => {
    const input = await body<{ folder: Folder }>(c);
    return c.json(await mailbox.move(c.req.param("id"), folder(input.folder), actorOf(c.get("principal"))));
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
      dailyTokenBudget: deps.info.dailyTokenBudget,
      budgetUsed: await mailbox.store.getBudget(day),
      unlocked: mailbox.unlocked,
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

  app.onError((error, c) => {
    if (error instanceof MailError) return c.json({ error: error.message, code: error.code }, statusFor(error));
    console.error(error instanceof Error ? error.message : error);
    return c.json({ error: "internal" }, 500);
  });

  return app;
}
