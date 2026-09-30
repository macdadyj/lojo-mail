import type { MessageView } from "@lojo/core";
import { hasFlag } from "./flags.ts";
import { inRanges, parseSequenceSet, ParseError, requireString, type Token } from "./imap-parse.ts";
import { headerFields, messageDate, type BuiltMessage } from "./mime.ts";

type DateCmp = "before" | "on" | "since";
type TextField = "from" | "to" | "cc" | "bcc" | "subject" | "text" | "body";

export type SearchKey =
  | { op: "all" }
  | { op: "none" }
  | { op: "flag"; flag: string; present: boolean }
  | { op: "seq"; set: string; uid: boolean }
  | { op: "date"; cmp: DateCmp; day: number }
  | { op: "text"; field: TextField; value: string }
  | { op: "header"; name: string; value: string }
  | { op: "size"; larger: boolean; bytes: number }
  | { op: "not"; key: SearchKey }
  | { op: "or"; a: SearchKey; b: SearchKey }
  | { op: "and"; keys: SearchKey[] };

export interface SearchTarget {
  seq: number;
  uid: number;
  maxSeq: number;
  maxUid: number;
  view: MessageView;
  flags: string[];
  message: () => Promise<BuiltMessage>;
  size: () => Promise<number>;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function parseDate(value: string): number {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value);
  const month = match ? MONTHS.indexOf((match[2] ?? "").toLowerCase()) : -1;
  if (!match || month < 0) throw new ParseError("Bad search date");
  return Date.UTC(Number(match[3]), month, Number(match[1]));
}

const FLAG_KEYS: Record<string, [string, boolean]> = {
  ANSWERED: ["\\Answered", true],
  UNANSWERED: ["\\Answered", false],
  DELETED: ["\\Deleted", true],
  UNDELETED: ["\\Deleted", false],
  DRAFT: ["\\Draft", true],
  UNDRAFT: ["\\Draft", false],
  FLAGGED: ["\\Flagged", true],
  UNFLAGGED: ["\\Flagged", false],
  SEEN: ["\\Seen", true],
  UNSEEN: ["\\Seen", false],
};

const TEXT_KEYS: Record<string, TextField> = { FROM: "from", TO: "to", CC: "cc", BCC: "bcc", SUBJECT: "subject", TEXT: "text", BODY: "body" };

function parseKey(tokens: Token[], at: number): [SearchKey, number] {
  const token = tokens[at];
  if (!token) throw new ParseError("Missing search key");
  if (token.kind === "list") return [{ op: "and", keys: parseKeys(token.items) }, at + 1];
  const word = requireString(token, "search key");
  const upper = word.toUpperCase();
  const arg = (offset = 1) => requireString(tokens[at + offset], `argument to ${upper}`);
  const flag = FLAG_KEYS[upper];
  if (flag) return [{ op: "flag", flag: flag[0], present: flag[1] }, at + 1];
  const textField = TEXT_KEYS[upper];
  if (textField) return [{ op: "text", field: textField, value: arg() }, at + 2];
  switch (upper) {
    case "ALL":
    case "OLD":
      return [{ op: "all" }, at + 1];
    case "NEW":
    case "RECENT":
      return [{ op: "none" }, at + 1];
    case "KEYWORD":
      return [{ op: "flag", flag: arg(), present: true }, at + 2];
    case "UNKEYWORD":
      return [{ op: "flag", flag: arg(), present: false }, at + 2];
    case "UID":
      return [{ op: "seq", set: arg(), uid: true }, at + 2];
    case "BEFORE":
    case "SENTBEFORE":
      return [{ op: "date", cmp: "before", day: parseDate(arg()) }, at + 2];
    case "ON":
    case "SENTON":
      return [{ op: "date", cmp: "on", day: parseDate(arg()) }, at + 2];
    case "SINCE":
    case "SENTSINCE":
      return [{ op: "date", cmp: "since", day: parseDate(arg()) }, at + 2];
    case "HEADER":
      return [{ op: "header", name: arg().toLowerCase(), value: arg(2) }, at + 3];
    case "LARGER":
    case "SMALLER": {
      const bytes = Number(arg());
      if (!Number.isInteger(bytes) || bytes < 0) throw new ParseError("Bad size");
      return [{ op: "size", larger: upper === "LARGER", bytes }, at + 2];
    }
    case "NOT": {
      const [key, next] = parseKey(tokens, at + 1);
      return [{ op: "not", key }, next];
    }
    case "OR": {
      const [a, afterA] = parseKey(tokens, at + 1);
      const [b, afterB] = parseKey(tokens, afterA);
      return [{ op: "or", a, b }, afterB];
    }
    default:
      if (token.kind === "atom" && /^[0-9*:,]+$/.test(word)) return [{ op: "seq", set: word, uid: false }, at + 1];
      throw new ParseError(`Unsupported search key ${word.slice(0, 30)}`);
  }
}

export function parseKeys(tokens: Token[]): SearchKey[] {
  const keys: SearchKey[] = [];
  let at = 0;
  while (at < tokens.length) {
    const [key, next] = parseKey(tokens, at);
    keys.push(key);
    at = next;
  }
  if (keys.length === 0) throw new ParseError("Missing search key");
  return keys;
}

function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function addressText(items: Array<{ name?: string; email: string }>): string {
  return items.map((item) => `${item.name ?? ""} <${item.email}>`).join(", ");
}

async function headerMatches(target: SearchTarget, name: string, value: string): Promise<boolean> {
  if (name === "message-id") return contains(`<${target.view.rfcMessageId}>`, value);
  const fields = headerFields((await target.message()).root.header).filter((field) => field.name === name);
  if (value === "") return fields.length > 0;
  return fields.some((field) => contains(field.raw.slice(field.raw.indexOf(":") + 1), value));
}

async function textMatches(target: SearchTarget, field: TextField, value: string): Promise<boolean> {
  const { view } = target;
  switch (field) {
    case "from":
      return contains(addressText([view.from]), value);
    case "to":
      return contains(addressText(view.to), value);
    case "cc":
      return contains(addressText(view.cc), value);
    case "bcc":
      return contains(addressText(view.bcc ?? []), value);
    case "subject":
      return contains(view.subject, value);
    case "body":
      return contains((await target.message()).searchText, value);
    case "text": {
      const headers = [view.subject, addressText([view.from]), addressText(view.to), addressText(view.cc)].join("\n");
      return contains(headers, value) || contains((await target.message()).searchText, value);
    }
    default: {
      const unexpected: never = field;
      throw new ParseError(`Unexpected search field ${String(unexpected)}`);
    }
  }
}

export async function matches(key: SearchKey, target: SearchTarget): Promise<boolean> {
  switch (key.op) {
    case "all":
      return true;
    case "none":
      return false;
    case "flag":
      return hasFlag(target.flags, key.flag) === key.present;
    case "seq":
      return key.uid
        ? inRanges(parseSequenceSet(key.set, target.maxUid), target.uid)
        : inRanges(parseSequenceSet(key.set, target.maxSeq), target.seq);
    case "date": {
      const date = messageDate(target.view);
      const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
      if (key.cmp === "before") return day < key.day;
      if (key.cmp === "on") return day === key.day;
      return day >= key.day;
    }
    case "text":
      return textMatches(target, key.field, key.value);
    case "header":
      return headerMatches(target, key.name, key.value);
    case "size": {
      const size = await target.size();
      return key.larger ? size > key.bytes : size < key.bytes;
    }
    case "not":
      return !(await matches(key.key, target));
    case "or":
      return (await matches(key.a, target)) || (await matches(key.b, target));
    case "and":
      for (const inner of key.keys) if (!(await matches(inner, target))) return false;
      return true;
    default: {
      const unexpected: never = key;
      throw new ParseError(`Unexpected search key ${JSON.stringify(unexpected)}`);
    }
  }
}
