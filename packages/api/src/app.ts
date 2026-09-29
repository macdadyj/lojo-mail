import { MailError, type Folder, type Mailbox } from "@lojo/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { hasScope, type Principal, type Scope, type TokenBook } from "./auth.ts";

interface AppDeps {
  mailbox: Mailbox;
  tokens: TokenBook;
  dev: boolean;
  corsOrigin?: string[];
  info: { mailbox: string; domain: string; llmProvider: string; dailyTokenBudget: number };
}

type Vars = { principal: Principal };

function statusFor(error: MailError): 400 | 403 | 404 | 423 {
  switch (error.code) {
    case "not_found":
      return 404;
    case "locked":
      return 423;
    case "forbidden":
      return 403;
    case "invalid":
    case "budget":
      return 400;
    default: {
      const unexpected: never = error.code;
      throw new Error(`Unhandled mail error ${String(unexpected)}`);
    }
  }
}

export function createApp(deps: AppDeps): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>();
  if (deps.corsOrigin && deps.corsOrigin.length > 0) {
    app.use("*", cors({ origin: deps.corsOrigin, allowHeaders: ["authorization", "content-type"] }));
  }

  app.get("/v1/health", (c) => c.json({ ok: true, unlocked: deps.mailbox.unlocked }));

  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/health") return next();
    const principal = deps.tokens.principal(c.req.header("authorization"));
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    c.set("principal", principal);
    await next();
  });

  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/health") return next();
    const routeScope = scopeFor(c.req.method, c.req.path);
    if (routeScope && !hasScope(c.get("principal").scopes, routeScope)) {
      return c.json({ error: "forbidden", scope: routeScope }, 403);
    }
    await next();
  });

  app.get("/v1/inbox", async (c) => c.json({ messages: await deps.mailbox.listInbox() }));
  app.get("/v1/triage", async (c) => c.json({ messages: await deps.mailbox.triage() }));
  app.get("/v1/threads/:id", async (c) => c.json(await deps.mailbox.readThread(c.req.param("id"))));
  app.post("/v1/threads/:id/summarize", async (c) => c.json({ summary: await deps.mailbox.summarizeThread(c.req.param("id")) }));
  app.get("/v1/messages/:id", async (c) => {
    const message = await deps.mailbox.store.getMessage(c.req.param("id"));
    if (!message) throw new MailError("No message", "not_found");
    return c.json(await deps.mailbox.present(message));
  });
  app.post("/v1/search", async (c) => {
    const body = await c.req.json<{ query?: string; mode?: "keyword" | "semantic" }>();
    if (!body.query) throw new MailError("query is required", "invalid");
    return c.json({ messages: await deps.mailbox.search(body.query, body.mode ?? "keyword") });
  });
  app.get("/v1/drafts", async (c) => c.json({ drafts: await deps.mailbox.listDrafts() }));
  app.post("/v1/drafts", async (c) => {
    const body = await c.req.json<{ to?: string[]; cc?: string[]; subject?: string; text?: string; threadId?: string }>();
    if (!body.to?.length || !body.subject || body.text === undefined) {
      throw new MailError("to, subject, and text are required", "invalid");
    }
    const draft = await deps.mailbox.createDraft({
      to: body.to,
      cc: body.cc,
      subject: body.subject,
      text: body.text,
      threadId: body.threadId,
    });
    return c.json(draft, 201);
  });
  app.post("/v1/messages/:id/draft-reply", async (c) => c.json(await deps.mailbox.draftReply(c.req.param("id")), 201));
  app.post("/v1/drafts/:id/rewrite", async (c) => {
    const body = await c.req.json<{ instruction?: string }>();
    if (!body.instruction) throw new MailError("instruction is required", "invalid");
    return c.json(await deps.mailbox.rewrite(c.req.param("id"), body.instruction));
  });
  app.post("/v1/drafts/:id/approve-and-send", async (c) => c.json(await deps.mailbox.approveAndSend(c.req.param("id"))));
  app.post("/v1/messages/:id/labels", async (c) => {
    const body = await c.req.json<{ labels?: string[] }>();
    if (!body.labels) throw new MailError("labels is required", "invalid");
    return c.json(await deps.mailbox.setLabels(c.req.param("id"), body.labels));
  });
  app.post("/v1/messages/:id/archive", async (c) => c.json(await deps.mailbox.archive(c.req.param("id"))));
  app.post("/v1/messages/:id/move", async (c) => {
    const body = await c.req.json<{ folder?: Folder }>();
    if (!body.folder) throw new MailError("folder is required", "invalid");
    return c.json(await deps.mailbox.move(c.req.param("id"), body.folder));
  });
  app.get("/v1/action-items", async (c) => c.json({ items: await deps.mailbox.actionItems() }));
  app.get("/v1/export", async (c) => c.body(await deps.mailbox.exportAll(), 200, { "content-type": "application/json" }));
  app.get("/v1/audit", async (c) => c.json({ events: await deps.mailbox.listAudit() }));
  app.get("/v1/labels", async (c) => c.json({ labels: await deps.mailbox.labels() }));
  app.get("/v1/settings", async (c) => {
    const day = new Date().toISOString().slice(0, 10);
    return c.json({
      mailbox: deps.info.mailbox,
      domain: deps.info.domain,
      llmProvider: deps.info.llmProvider,
      dailyTokenBudget: deps.info.dailyTokenBudget,
      budgetUsed: await deps.mailbox.store.getBudget(day),
      unlocked: deps.mailbox.unlocked,
      dev: deps.dev,
    });
  });
  app.post("/v1/session/unlock", async (c) => {
    if (!deps.dev) return c.json({ error: "unlock is only available on the local server" }, 403);
    const body = await c.req.json<{ privateJwk?: { d?: string; x?: string; y?: string; kty?: string; crv?: string } }>();
    if (!body.privateJwk?.d || !body.privateJwk.x || !body.privateJwk.y) {
      throw new MailError("privateJwk is required", "invalid");
    }
    deps.mailbox.unlock({
      kty: "EC",
      crv: "P-256",
      x: body.privateJwk.x,
      y: body.privateJwk.y,
      d: body.privateJwk.d,
    });
    return c.json({ unlocked: true });
  });

  app.onError((error, c) => {
    if (error instanceof MailError) return c.json({ error: error.message, code: error.code }, statusFor(error));
    console.error(error instanceof Error ? error.message : error);
    return c.json({ error: "internal" }, 500);
  });

  return app;
}

function scopeFor(method: string, path: string): Scope | null {
  if (path === "/v1/health") return null;
  if (path.endsWith("/approve-and-send")) return "send";
  if (path.endsWith("/summarize")) return "read";
  if (path === "/v1/session/unlock") return "admin";
  if (method === "GET") return "read";
  if (method === "POST" || method === "PATCH" || method === "DELETE") return "write";
  return "admin";
}
