import { newId, utcDay } from "../ids.ts";
import { buildRawMessage, cleanHeaderValue } from "../mime/compose.ts";
import type { MailSender, OutboundMessage } from "../send.ts";
import type { MailStore } from "../store/types.ts";
import type { LojoConfig, StoredMessage } from "../types.ts";
import { senderMatches } from "./match.ts";
import type { Rule, RulesDocument, UnsubscribeAction } from "./types.ts";

/**
 * Unsubscribe rules answer List-Unsubscribe (RFC 2369) with a one-click POST
 * (RFC 8058) or a mailto request. Bulk mail is exactly what they act on, so the
 * loop guards that stop auto-replies do not apply; DMARC, phishing, kill
 * switches, Jon's authorship, shadow-first and rate limits all do. The request
 * carries no text from the message beyond the header's own mailto subject and body.
 */
export interface UnsubscribeTarget {
  mailto?: string;
  oneClick?: string;
}

const MAX_URI = 1000;
const ONE_CLICK = /^\s*List-Unsubscribe\s*=\s*One-Click\s*$/i;
const MAILTO_ADDRESS = /^[^\s@<>",;:]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
const PRIVATE_HOST = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|arpa)$/i;

/** Parsed at delivery. A one-click URI counts only with the RFC 8058 List-Unsubscribe-Post header. */
export function parseListUnsubscribe(header: string | undefined, post: string | undefined): UnsubscribeTarget | null {
  if (!header) return null;
  const out: UnsubscribeTarget = {};
  for (const match of header.matchAll(/<([^>]{1,2000})>/g)) {
    const uri = (match[1] ?? "").trim();
    if (uri.length > MAX_URI) continue;
    if (!out.mailto && /^mailto:/i.test(uri) && parseMailto(uri)) out.mailto = uri;
    if (!out.oneClick && post && ONE_CLICK.test(post) && safeOneClickUrl(uri)) out.oneClick = uri;
  }
  return out.mailto || out.oneClick ? out : null;
}

export function parseMailto(uri: string): { to: string; subject: string; body: string } | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "mailto:") return null;
  let to: string;
  try {
    to = decodeURIComponent(url.pathname).trim();
  } catch {
    return null;
  }
  if (!MAILTO_ADDRESS.test(to)) return null;
  const subject = cleanHeaderValue(url.searchParams.get("subject") ?? "unsubscribe").slice(0, 200) || "unsubscribe";
  const body = (url.searchParams.get("body") ?? "unsubscribe").slice(0, 1000) || "unsubscribe";
  return { to: to.toLowerCase(), subject, body };
}

/** https on 443 to a public-looking name only: no IP literals, credentials, or internal names. Redirects are never followed. */
export function safeOneClickUrl(uri: string): URL | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host) || PRIVATE_HOST.test(host)) return null;
  return url;
}

export type OneClickClient = (url: string) => Promise<{ status: number }>;

export function fetchOneClick(fetchImpl: typeof fetch = fetch): OneClickClient {
  return async (url) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "lojo-mail-unsubscribe" },
      body: "List-Unsubscribe=One-Click",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    return { status: response.status };
  };
}

export interface UnsubscribeDeps {
  store: MailStore;
  config: LojoConfig;
  /** Present only when LOJO_AUTO_SEND=on: mailto requests go out through it. */
  autoSender: MailSender | null;
  /** Present only when LOJO_AUTO_SEND=on. */
  oneClick: OneClickClient | null;
  recordSent: (raw: string, deliveryId: string) => Promise<void>;
  now: Date;
}

export type UnsubscribeMethod = "one-click" | "mailto";

export type UnsubscribeResult =
  | { kind: "shadow"; method: UnsubscribeMethod | null; wouldSend: boolean; refusals: string[] }
  | { kind: "refused"; refusals: string[] }
  | { kind: "done"; method: UnsubscribeMethod }
  | { kind: "failed"; method: UnsubscribeMethod; reason: string };

interface Plan {
  method: UnsubscribeMethod | null;
  target: string;
  refusals: string[];
}

interface Capabilities {
  config: LojoConfig;
  canPost: boolean;
  canMail: boolean;
}

/** One-click first (RFC 8058 says so, and it sends nothing as Jon), then mailto. */
function plan(deps: Capabilities, doc: RulesDocument, rule: Rule, action: UnsubscribeAction, message: StoredMessage, shadow: boolean): Plan {
  const out: string[] = [];
  const from = message.from.email.toLowerCase();
  const domain = deps.config.domain.toLowerCase();
  const own = (email: string) => email === deps.config.mailbox.toLowerCase() || email.endsWith(`@${domain}`);
  if (doc.paused) out.push("rules are paused");
  if (doc.killSwitch) out.push("kill switch is engaged");
  if (doc.sendKillSwitch) out.push("global send kill switch is engaged");
  if (rule.createdBy !== "human") out.push("rule was not written or enabled by a human session");
  if (message.origin !== "inbound") out.push("not inbound mail");
  if (message.verdicts?.dmarc !== "pass") out.push("sender did not pass DMARC");
  if (message.verdicts?.spam === "FAIL" || message.verdicts?.virus === "FAIL" || message.labels.includes("quarantined")) out.push("quarantined");
  if (message.ai && (message.ai.category === "phishing" || message.ai.phishingScore >= 40)) out.push("possible phishing");
  if (own(from)) out.push("sender is on Jon's own domain");
  if (action.allowSenders.length > 0 && !senderMatches(from, action.allowSenders)) out.push("sender is not on the rule's allowlist");

  const oneClick = message.unsubscribe?.oneClick ? safeOneClickUrl(message.unsubscribe.oneClick) : null;
  const mailto = message.unsubscribe?.mailto ? parseMailto(message.unsubscribe.mailto) : null;
  if (mailto && own(mailto.to)) out.push("unsubscribe address is on Jon's own domain");
  let method: UnsubscribeMethod | null = null;
  let target = "";
  if (oneClick && (shadow || deps.canPost)) {
    method = "one-click";
    target = oneClick.hostname;
  } else if (mailto && (shadow || deps.canMail)) {
    method = "mailto";
    target = mailto.to;
  } else if (oneClick || mailto) {
    out.push("unsubscribe is disabled on this deployment");
  } else {
    out.push("no usable List-Unsubscribe header");
  }
  return { method, target, refusals: out };
}

async function rateLimitRefusals(store: MailStore, rule: Rule, action: UnsubscribeAction, doc: RulesDocument, message: StoredMessage, at: Date, namespace: string): Promise<string[]> {
  const day = utcDay(at);
  const dayEnd = new Date(Date.parse(`${day}T00:00:00Z`) + 2 * 86_400_000);
  const list = (message.listId ?? message.from.email).toLowerCase().slice(0, 200);
  const out: string[] = [];
  if ((await store.bumpCounter(`${namespace}:msg:${message.id}`, new Date(at.getTime() + 30 * 86_400_000))) > 1) out.push("already handled this message");
  if ((await store.bumpCounter(`${namespace}:list:${list}`, new Date(at.getTime() + 30 * 86_400_000))) > 1) out.push("already unsubscribed from this list in the last 30 days");
  if ((await store.bumpCounter(`${namespace}:rule:${rule.id}:${day}`, dayEnd)) > action.perDay) out.push("rule daily limit");
  if ((await store.bumpCounter(`${namespace}:day:${day}`, dayEnd)) > doc.maxAutoSendPerDay) out.push("global daily limit");
  return out;
}

async function audit(deps: Pick<UnsubscribeDeps, "store" | "now">, outcome: string, messageId: string, detail: string): Promise<void> {
  await deps.store.putAudit({ id: newId("aud"), day: utcDay(deps.now), at: deps.now.toISOString(), action: "rule.unsubscribe", outcome, messageId, detail: detail.slice(0, 500) });
}

/** Never throws a refusal: delivery must not depend on a rule. Audits every outcome as `rule.unsubscribe`. */
export async function runUnsubscribe(deps: UnsubscribeDeps, doc: RulesDocument, rule: Rule, action: UnsubscribeAction, message: StoredMessage): Promise<UnsubscribeResult> {
  const shadow = action.mode === "shadow";
  const planned = plan({ config: deps.config, canPost: Boolean(deps.oneClick), canMail: Boolean(deps.autoSender) }, doc, rule, action, message, shadow);
  const refusals = [...planned.refusals];
  if (refusals.length === 0) refusals.push(...(await rateLimitRefusals(deps.store, rule, action, doc, message, deps.now, shadow ? "shadow-unsub" : "unsub")));
  const where = planned.method ? `method:${planned.method} target:${planned.target}` : "method:none";

  if (shadow) {
    const wouldSend = refusals.length === 0;
    const deployment = deps.oneClick || deps.autoSender ? "on" : "off";
    await audit(deps, wouldSend ? "shadow_would_send" : "shadow_refused", message.id, `rule:${rule.id} ${where} deployment:${deployment}${wouldSend ? "" : ` refused:${refusals.join("; ")}`}`);
    return { kind: "shadow", method: planned.method, wouldSend, refusals };
  }
  if (refusals.length > 0 || !planned.method) {
    await audit(deps, "refused", message.id, `rule:${rule.id} ${where} refused:${refusals.join("; ")}`);
    return { kind: "refused", refusals };
  }

  const method = planned.method;
  try {
    if (method === "one-click") {
      const { status } = await (deps.oneClick as OneClickClient)(message.unsubscribe?.oneClick ?? "");
      if (status < 200 || status >= 300) {
        await audit(deps, "failed", message.id, `rule:${rule.id} ${where} status:${status}`);
        return { kind: "failed", method, reason: `HTTP ${status}` };
      }
    } else {
      const mailto = parseMailto(message.unsubscribe?.mailto ?? "");
      if (!mailto || !deps.autoSender) throw new Error("mailto unavailable");
      const outbound: OutboundMessage = {
        from: { email: deps.config.mailbox, name: "Jon Hebert" },
        to: [{ email: mailto.to }],
        cc: [],
        subject: mailto.subject,
        text: mailto.body,
        autoReplied: true,
      };
      const sent = await deps.autoSender.send(outbound);
      const rfcId = sent.messageId.includes("@") ? sent.messageId : `${sent.messageId}@${deps.config.region === "us-east-1" ? "email" : deps.config.region}.amazonses.com`;
      await deps.recordSent(buildRawMessage(outbound, { messageId: rfcId, date: deps.now }), `sent:${sent.messageId}`);
    }
  } catch (error) {
    const reason = (error instanceof Error ? error.message : "failed").slice(0, 200);
    await audit(deps, "failed", message.id, `rule:${rule.id} ${where} ${reason}`);
    return { kind: "failed", method, reason };
  }
  await deps.store.updateMessage(message.id, { labels: [...new Set([...message.labels, "unsubscribed"])] });
  await audit(deps, "done", message.id, `rule:${rule.id} ${where}`);
  return { kind: "done", method };
}

/** For the dry run: which method a message would use and what would stop it, without counting limits. */
export function unsubscribeDryRun(deps: { config: LojoConfig; enabled: boolean }, doc: RulesDocument, rule: Rule, action: UnsubscribeAction, message: StoredMessage) {
  const planned = plan({ config: deps.config, canPost: deps.enabled, canMail: deps.enabled }, doc, rule, action, message, action.mode === "shadow");
  return { ruleId: rule.id, mode: action.mode, method: planned.method, refusals: planned.refusals };
}
