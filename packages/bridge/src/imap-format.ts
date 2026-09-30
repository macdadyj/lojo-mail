import { encodeHeaderText, type Address, type MessageView } from "@lojo/core";
import { headerFields, messageDate, rfc5322Date, type BuiltMessage, type MimeNode, type Params } from "./mime.ts";

/** Response pieces. Buffers are sent verbatim (literal payloads); strings as UTF-8. */
export type Out = Array<string | Buffer>;

export function literal(bytes: Buffer): Out {
  return [`{${bytes.length}}\r\n`, bytes];
}

/** Quoted when that is safe 7-bit; otherwise a literal. */
export function istring(value: string): Out {
  if (value.length < 1000 && /^[\x20-\x7e]*$/.test(value)) return [`"${value.replace(/["\\]/g, "\\$&")}"`];
  return literal(Buffer.from(value, "utf8"));
}

export function nstring(value: string | null | undefined): Out {
  return value === null || value === undefined ? ["NIL"] : istring(value);
}

export function astring(value: string): Out {
  if (/^[A-Za-z0-9_.\-/$&+]+$/.test(value) && value.toUpperCase() !== "NIL") return [value];
  return istring(value);
}

function join(parts: Out[], separator = " "): Out {
  const out: Out = [];
  parts.forEach((part, index) => {
    if (index > 0) out.push(separator);
    out.push(...part);
  });
  return out;
}

function list(parts: Out[]): Out {
  return ["(", ...join(parts), ")"];
}

function headerText(value: string): string {
  return encodeHeaderText(value).replace(/\r\n /g, " ");
}

function address(item: Address): Out {
  const at = item.email.lastIndexOf("@");
  const mailbox = at > 0 ? item.email.slice(0, at) : item.email;
  const host = at > 0 ? item.email.slice(at + 1) : "";
  return list([nstring(item.name ? headerText(item.name) : null), ["NIL"], nstring(mailbox), nstring(host || null)]);
}

function addresses(items: Address[]): Out {
  return items.length === 0 ? ["NIL"] : ["(", ...items.flatMap(address), ")"];
}

function bracketed(value: string | undefined): string | null {
  return value ? `<${value.replace(/[<>\s]/g, "")}>` : null;
}

export function envelope(view: MessageView): Out {
  const from = [view.from];
  return list([
    nstring(rfc5322Date(messageDate(view))),
    nstring(headerText(view.subject)),
    addresses(from),
    addresses(from),
    addresses(view.replyTo ? [view.replyTo] : from),
    addresses(view.to),
    addresses(view.cc),
    ["NIL"],
    nstring(bracketed(view.inReplyTo)),
    nstring(bracketed(view.rfcMessageId)),
  ]);
}

function params(values: Params): Out {
  if (values.length === 0) return ["NIL"];
  return list(values.flatMap(([key, value]) => [istring(key.toUpperCase()), istring(value)]));
}

function disposition(node: MimeNode): Out {
  if (!node.disposition) return ["NIL"];
  return list([istring(node.disposition.type.toUpperCase()), params(node.disposition.params)]);
}

export function bodyStructure(node: MimeNode, extensible: boolean): Out {
  if (node.children.length > 0) {
    const out: Out = ["("];
    for (const child of node.children) out.push(...bodyStructure(child, extensible));
    out.push(" ", ...istring(node.subtype.toUpperCase()));
    if (extensible) out.push(" ", ...params(node.params), " NIL NIL NIL");
    out.push(")");
    return out;
  }
  const fields: Out[] = [
    istring(node.type.toUpperCase()),
    istring(node.subtype.toUpperCase()),
    params(node.params),
    ["NIL"],
    ["NIL"],
    istring((node.encoding ?? "7bit").toUpperCase()),
    [String(node.body.length)],
  ];
  if (node.type === "text") fields.push([String(node.lines)]);
  if (extensible) fields.push(["NIL"], disposition(node), ["NIL"], ["NIL"]);
  return list(fields);
}

function partAt(root: MimeNode, path: number[]): MimeNode | null {
  let node = root;
  for (const index of path) {
    if (node.children.length === 0) {
      if (index === 1 && node === root) continue;
      return null;
    }
    const child = node.children[index - 1];
    if (!child) return null;
    node = child;
  }
  return node;
}

function fieldNames(spec: string): Set<string> {
  const inner = /\(([^)]*)\)/.exec(spec)?.[1] ?? "";
  return new Set(
    inner
      .split(/\s+/)
      .map((name) => name.replace(/^"|"$/g, "").toLowerCase())
      .filter(Boolean),
  );
}

function filterHeader(header: Buffer, spec: string): Buffer {
  const names = fieldNames(spec);
  const not = /^HEADER\.FIELDS\.NOT/i.test(spec);
  const kept = headerFields(header).filter((field) => names.has(field.name) !== not);
  return Buffer.from(`${kept.map((field) => `${field.raw}\r\n`).join("")}\r\n`, "latin1");
}

/** The bytes for a BODY[section]. Unknown parts are empty rather than an error, as most servers do. */
export function sectionBytes(message: BuiltMessage, section: string): Buffer {
  if (section === "") return message.raw;
  const match = /^((?:\d+\.)*\d+)?\.?(.*)$/.exec(section);
  const path = match?.[1] ? match[1].split(".").map(Number) : [];
  const rest = (match?.[2] ?? "").toUpperCase();
  const node = partAt(message.root, path);
  if (!node) return Buffer.alloc(0);
  if (path.length > 0 && rest === "") return node === message.root ? message.root.body : node.body;
  if (path.length > 0 && rest === "MIME") return node.header;
  if (path.length > 0) return Buffer.alloc(0);
  if (rest === "HEADER") return message.root.header;
  if (rest === "TEXT") return message.root.body;
  if (rest.startsWith("HEADER.FIELDS")) return filterHeader(message.root.header, section);
  return Buffer.alloc(0);
}
