/**
 * Links in a message are not loaded by reading it. Remote images are dropped.
 * A tracking redirect is removed only when the next hop is written inside the
 * URL itself; nothing is fetched to discover it.
 */

export const DEFAULT_TRUSTED_DOMAINS = ["apple.com", "email.apple.com", "testflight.apple.com", "github.com"] as const;

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MAX_HTML_CHARS = 200_000;
const TRACKER_PARAMS = ["url", "q", "u", "link", "destination", "redirect", "dest", "target"];
const SKIP_TAGS = new Set(["script", "style", "noscript", "head", "svg", "iframe", "object", "template", "title"]);
const BLOCK_TAGS = new Set(["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "table", "section", "article"]);

export interface LinkMessage {
  from: { email: string };
  labels?: string[];
  verdicts?: { spam?: string; virus?: string; dmarc?: string };
}

export interface TextPart {
  type: "text";
  text: string;
}

export interface LinkPart {
  type: "link";
  text: string;
  href: string;
  domain: string;
  button: boolean;
}

export type MessagePart = TextPart | LinkPart;

export function normalizeDomain(value: string): string | null {
  const domain = value.trim().toLowerCase().replace(/\.+$/, "");
  if (!DOMAIN.test(domain)) return null;
  return domain;
}

export function parseTrustedDomainList(text: string): { ok: true; domains: string[] } | { ok: false; error: string } {
  const domains: string[] = [];
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const domain = normalizeDomain(trimmed);
    if (!domain) return { ok: false, error: `"${trimmed}" is not a domain name` };
    if (!domains.includes(domain)) domains.push(domain);
  }
  return { ok: true, domains };
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  return normalizeDomain(email.slice(at + 1));
}

/** A listed domain matches itself and its subdomains, and nothing that merely ends with the same letters. */
export function domainTrusted(domain: string, list: readonly string[]): boolean {
  const host = domain.toLowerCase();
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/**
 * The sender check the rest of the mailbox already uses: SES recorded DMARC
 * pass, and the message was not a spam or virus fail. `unverified-self` is the
 * label ingest adds when Jon's own domain fails that check.
 */
export function senderVerified(message: LinkMessage): boolean {
  if (message.verdicts?.dmarc !== "pass") return false;
  if (message.verdicts.spam === "FAIL" || message.verdicts.virus === "FAIL") return false;
  const labels = message.labels ?? [];
  if (labels.includes("quarantined") || labels.includes("unverified-self")) return false;
  return true;
}

export function linksOpenDirectly(message: LinkMessage, trusted: readonly string[]): boolean {
  if (!senderVerified(message)) return false;
  const domain = emailDomain(message.from.email);
  return domain !== null && domainTrusted(domain, trusted);
}

export function prepareLink(raw: string): { href: string; domain: string } | null {
  const url = unwrapTrackingUrl(raw);
  if (!url) return null;
  return { href: url.href, domain: url.hostname };
}

export function unwrapTrackingUrl(raw: string): URL | null {
  let current = publicHttpUrl(raw);
  if (!current) return null;
  for (let hop = 0; hop < 3; hop += 1) {
    if (!trackerHost(current)) return current;
    const nextRaw = nestedDestination(current);
    if (!nextRaw) return current;
    const next = publicHttpUrl(nextRaw);
    if (!next || next.href === current.href) return current;
    current = next;
  }
  return current;
}

export function messageParts(input: { text?: string; html?: string }): MessagePart[] {
  const html = input.html ?? "";
  if (html.trim() && html.length <= MAX_HTML_CHARS) {
    const fromHtml = tidy(htmlParts(html));
    if (fromHtml.length > 0) return fromHtml;
  }
  return tidy(textParts(input.text ?? ""));
}

function publicHttpUrl(raw: string): URL | null {
  const trimmed = stripControls(raw).trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!isPublicHost(url.hostname)) return null;
  return url;
}

function stripControls(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) continue;
    out += char;
  }
  return out;
}

function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host.includes(":") || host.startsWith("[")) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  if (!host.includes(".")) return false;
  return true;
}

function trackerHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if ((host === "google.com" || host === "www.google.com") && url.pathname === "/url") return true;
  if (host === "href.li") return true;
  if (host === "safelinks.protection.outlook.com" || host.endsWith(".safelinks.protection.outlook.com")) return true;
  if (host === "l.facebook.com" || host === "lm.facebook.com" || host === "l.instagram.com") return true;
  if (host === "urldefense.com" || host === "urldefense.proofpoint.com" || host.endsWith(".urldefense.proofpoint.com")) return true;
  if (host.endsWith(".awstrack.me")) return true;
  if (host === "email.apple.com" || host.endsWith(".email.apple.com")) return true;
  if (host === "clicks.apple.com" || host.endsWith(".clicks.apple.com")) return true;
  return false;
}

function nestedDestination(url: URL): string | null {
  const fromPath = awstrackDestination(url);
  if (fromPath) return fromPath;
  if (url.hostname.toLowerCase() === "href.li") {
    const query = url.search.startsWith("?") ? url.search.slice(1) : "";
    const first = query.split("&")[0] ?? "";
    const decoded = decodeUrlValue(first);
    if (decoded) return decoded;
  }
  const named = namedDestination(url);
  if (named) return named;
  if (isProofpoint(url.hostname)) {
    for (const name of TRACKER_PARAMS) {
      const value = url.searchParams.get(name);
      if (!value) continue;
      const decoded = proofpointDecode(value);
      if (decoded && /^https?:\/\//i.test(decoded)) return decoded;
    }
  }
  return null;
}

function namedDestination(url: URL): string | null {
  for (const name of TRACKER_PARAMS) {
    const value = url.searchParams.get(name);
    if (!value) continue;
    const decoded = decodeUrlValue(value);
    if (decoded) return decoded;
  }
  return null;
}

function awstrackDestination(url: URL): string | null {
  if (!url.hostname.toLowerCase().endsWith(".awstrack.me")) return null;
  const parts = url.pathname.split("/");
  const index = parts.indexOf("L0");
  const encoded = index >= 0 ? parts[index + 1] : undefined;
  if (!encoded) return null;
  return decodeUrlValue(encoded);
}

function isProofpoint(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "urldefense.com" || host === "urldefense.proofpoint.com" || host.endsWith(".urldefense.proofpoint.com");
}

function proofpointDecode(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/-/g, "%").replace(/_/g, "/"));
  } catch {
    return null;
  }
}

function decodeUrlValue(value: string): string | null {
  let current = value.trim();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (/^https?:\/\//i.test(current)) return current;
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return /^https?:\/\//i.test(current) ? current : null;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, body: string) => {
    const lower = body.toLowerCase();
    switch (lower) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
      case "#39":
        return "'";
      case "nbsp":
        return " ";
      default:
        return decodeNumericEntity(lower) ?? entity;
    }
  });
}

function decodeNumericEntity(body: string): string | null {
  if (!body.startsWith("#")) return null;
  const hex = body.startsWith("#x");
  const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return null;
  if (code >= 0xd800 && code <= 0xdfff) return null;
  return String.fromCodePoint(code);
}

interface ScannedTag {
  rawEnd: number;
  name: string;
  close: boolean;
  attrs: Map<string, string>;
}

function scanTag(html: string, start: number): ScannedTag | null {
  if (html[start] !== "<") return null;
  let i = start + 1;
  let close = false;
  if (html[i] === "/") {
    close = true;
    i += 1;
  }
  const nameMatch = /^[a-zA-Z][a-zA-Z0-9]*/.exec(html.slice(i));
  if (!nameMatch) return null;
  const name = nameMatch[0].toLowerCase();
  i += name.length;
  const attrs = new Map<string, string>();
  while (i < html.length && (html[i] ?? "") !== ">") {
    let ch = html[i] ?? "";
    while (ch && /\s/.test(ch)) {
      i += 1;
      ch = html[i] ?? "";
    }
    if (!ch || ch === ">" || ch === "/") break;
    const attr = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*/.exec(html.slice(i));
    if (!attr) {
      i += 1;
      continue;
    }
    i += attr[0].length;
    ch = html[i] ?? "";
    while (ch && /\s/.test(ch)) {
      i += 1;
      ch = html[i] ?? "";
    }
    let value = "";
    if (ch === "=") {
      i += 1;
      ch = html[i] ?? "";
      while (ch && /\s/.test(ch)) {
        i += 1;
        ch = html[i] ?? "";
      }
      const quote = ch;
      if (quote === '"' || quote === "'") {
        i += 1;
        const end = html.indexOf(quote, i);
        if (end < 0) return null;
        value = html.slice(i, end);
        i = end + 1;
      } else {
        const bare = /^[^\s>]+/.exec(html.slice(i));
        value = bare?.[0] ?? "";
        i += value.length;
      }
    }
    attrs.set(attr[0].toLowerCase(), decodeEntities(value));
  }
  const end = html.indexOf(">", i);
  if (end < 0) return null;
  return { rawEnd: end + 1, name, close, attrs };
}

function htmlParts(html: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let text = "";
  let linkText = "";
  let linkHref: string | null = null;
  const write = (chunk: string) => {
    if (linkHref !== null) linkText += chunk;
    else text += chunk;
  };
  const flushText = () => {
    if (!text) return;
    parts.push({ type: "text", text });
    text = "";
  };
  let i = 0;
  while (i < html.length) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[i] !== "<") {
      const next = html.indexOf("<", i);
      write(decodeEntities(html.slice(i, next < 0 ? html.length : next)));
      i = next < 0 ? html.length : next;
      continue;
    }
    const tag = scanTag(html, i);
    if (!tag) {
      write("<");
      i += 1;
      continue;
    }
    if (!tag.close && SKIP_TAGS.has(tag.name)) {
      const closer = new RegExp(`</${tag.name}\\s*>`, "i").exec(html.slice(tag.rawEnd));
      i = closer ? tag.rawEnd + closer.index + closer[0].length : html.length;
      continue;
    }
    if (tag.name === "br") write("\n");
    else if (tag.name === "img" && linkHref !== null) write(tag.attrs.get("alt") ?? "");
    else if (tag.close && BLOCK_TAGS.has(tag.name) && linkHref === null) {
      if (text && !text.endsWith("\n")) text += "\n";
    } else if (tag.name === "a" && !tag.close) {
      flushText();
      linkHref = tag.attrs.get("href") ?? "";
      linkText = "";
    } else if (tag.name === "a" && tag.close && linkHref !== null) {
      pushLink(parts, linkHref, linkText);
      linkHref = null;
      linkText = "";
    }
    i = tag.rawEnd;
  }
  flushText();
  return parts;
}

function pushLink(parts: MessagePart[], href: string, labelSource: string): void {
  const label = labelSource.replace(/\s+/g, " ").trim();
  const prepared = prepareLink(href);
  if (!prepared) {
    if (label) parts.push({ type: "text", text: label });
    return;
  }
  const text = label || prepared.domain;
  parts.push({
    type: "link",
    text,
    href: prepared.href,
    domain: prepared.domain,
    button: text.length <= 40 && !/https?:\/\//i.test(text),
  });
}

function textParts(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const pattern = /https?:\/\/[^\s<>"']+/gi;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ type: "text", text: text.slice(last, start) });
    let raw = match[0];
    let trail = "";
    while (raw.length > 0 && /[),.;:!?\]}]/.test(raw.at(-1) ?? "")) {
      trail = `${raw.at(-1) ?? ""}${trail}`;
      raw = raw.slice(0, -1);
    }
    const prepared = prepareLink(raw);
    if (prepared) parts.push({ type: "link", text: raw, href: prepared.href, domain: prepared.domain, button: false });
    else parts.push({ type: "text", text: raw });
    if (trail) parts.push({ type: "text", text: trail });
    last = start + match[0].length;
  }
  if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
  return parts;
}

function tidy(parts: MessagePart[]): MessagePart[] {
  const merged: MessagePart[] = [];
  for (const part of parts) {
    if (part.type === "link") {
      if (part.text) merged.push(part);
      continue;
    }
    const text = part.text.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n");
    if (!text) continue;
    const prev = merged[merged.length - 1];
    if (prev?.type === "text") prev.text += text;
    else merged.push({ type: "text", text });
  }
  const first = merged[0];
  if (first?.type === "text") first.text = first.text.replace(/^\n+/, "");
  const last = merged[merged.length - 1];
  if (last?.type === "text") last.text = last.text.replace(/\n+$/, "");
  return merged.filter((part) => part.type === "link" || part.text.length > 0);
}
