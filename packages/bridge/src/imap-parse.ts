export const MAX_LINE_BYTES = 64 * 1024;
export const MAX_COMMAND_BYTES = 1024 * 1024;
export const MAX_LITERAL_BYTES = 32 * 1024 * 1024;

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

/** A complete command line. Literals are replaced by `\0<index>\0` in `text` and carried in `literals`. */
export interface RawCommand {
  text: string;
  literals: Buffer[];
}

export interface ReaderEvents {
  command(command: RawCommand): void;
  /** A synchronizing literal is announced; the client waits for `+` before sending it. */
  continuation(): void;
  /** Protocol-level failure. `tag` is set when the rest of the command was dropped and a tagged reply fits. */
  reject(reason: string, tag: string | null, fatal: boolean): void;
}

function tagOf(line: string): string | null {
  const match = /^([^\s(){%*"\\\]]+)\s/.exec(line);
  return match?.[1] ?? null;
}

/** Splits the byte stream into commands, honouring `{n}` and `{n+}` literals and size limits. */
export class CommandReader {
  private buffer: Buffer = Buffer.alloc(0);
  private pieces: string[] = [];
  private literals: Buffer[] = [];
  private literalChunks: Buffer[] = [];
  private literalRemaining = 0;
  private commandBytes = 0;

  constructor(private readonly events: ReaderEvents) {}

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.literalRemaining > 0) {
        if (this.buffer.length === 0) return;
        const take = Math.min(this.literalRemaining, this.buffer.length);
        this.literalChunks.push(this.buffer.subarray(0, take));
        this.buffer = this.buffer.subarray(take);
        this.literalRemaining -= take;
        if (this.literalRemaining > 0) return;
        this.literals.push(Buffer.concat(this.literalChunks));
        this.literalChunks = [];
        continue;
      }
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.length > MAX_LINE_BYTES) {
          this.reset();
          this.buffer = Buffer.alloc(0);
          this.events.reject("Line too long", null, true);
        }
        return;
      }
      const lineBytes = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (lineBytes.length > MAX_LINE_BYTES) {
        this.reset();
        this.events.reject("Line too long", null, false);
        continue;
      }
      this.line(lineBytes.toString("utf8").replace(/\r$/, ""));
    }
  }

  private reset(): void {
    this.pieces = [];
    this.literals = [];
    this.literalChunks = [];
    this.literalRemaining = 0;
    this.commandBytes = 0;
  }

  private line(line: string): void {
    const startLine = this.pieces.length === 0 ? line : (this.pieces[0] ?? "");
    if (line.includes("\0")) {
      this.reset();
      this.events.reject("NUL is not allowed in commands", tagOf(startLine), false);
      return;
    }
    this.commandBytes += line.length;
    const literal = /\{(\d{1,10})(\+?)\}$/.exec(line);
    if (!literal) {
      this.pieces.push(line);
      const command = { text: this.pieces.join(""), literals: this.literals };
      this.reset();
      this.events.command(command);
      return;
    }
    const size = Number(literal[1]);
    const synchronizing = literal[2] !== "+";
    if (size > MAX_LITERAL_BYTES || this.commandBytes + size > MAX_LITERAL_BYTES + MAX_COMMAND_BYTES) {
      const tag = tagOf(startLine);
      this.reset();
      if (synchronizing) {
        this.events.reject("Literal too large", tag, false);
        return;
      }
      this.events.reject("Literal too large", tag, true);
      return;
    }
    this.commandBytes += size;
    this.pieces.push(`${line.slice(0, literal.index)}\0${this.literals.length}\0`);
    this.literalRemaining = size;
    if (size === 0) this.literals.push(Buffer.alloc(0));
    if (synchronizing) this.events.continuation();
  }
}

export type Token = { kind: "atom"; value: string } | { kind: "string"; value: string; bytes: Buffer | null } | { kind: "list"; items: Token[] };

export function tokenize(text: string, literals: Buffer[]): Token[] {
  let pos = 0;
  const stack: Token[][] = [[]];
  const push = (token: Token) => {
    const top = stack[stack.length - 1];
    if (!top) throw new ParseError("Unbalanced parentheses");
    top.push(token);
  };
  while (pos < text.length) {
    const char = text[pos];
    if (char === " ") {
      pos += 1;
      continue;
    }
    if (char === "(") {
      stack.push([]);
      pos += 1;
      continue;
    }
    if (char === ")") {
      const items = stack.pop();
      if (!items || stack.length === 0) throw new ParseError("Unbalanced parentheses");
      push({ kind: "list", items });
      pos += 1;
      continue;
    }
    if (char === '"') {
      let value = "";
      pos += 1;
      for (;;) {
        if (pos >= text.length) throw new ParseError("Unterminated quoted string");
        const c = text[pos];
        if (c === "\\") {
          const next = text[pos + 1];
          if (next !== "\\" && next !== '"') throw new ParseError("Bad escape in quoted string");
          value += next;
          pos += 2;
          continue;
        }
        if (c === '"') {
          pos += 1;
          break;
        }
        value += c;
        pos += 1;
      }
      push({ kind: "string", value, bytes: null });
      continue;
    }
    if (char === "\0") {
      const end = text.indexOf("\0", pos + 1);
      const bytes = literals[Number(text.slice(pos + 1, end))];
      if (end < 0 || !bytes) throw new ParseError("Bad literal");
      push({ kind: "string", value: bytes.toString("utf8"), bytes });
      pos = end + 1;
      continue;
    }
    const start = pos;
    while (pos < text.length) {
      const c = text[pos];
      if (c === "[") {
        const close = text.indexOf("]", pos);
        if (close < 0) throw new ParseError("Unterminated section");
        pos = close + 1;
        continue;
      }
      if (c === " " || c === "(" || c === ")" || c === '"' || c === "\0") break;
      pos += 1;
    }
    if (pos === start) throw new ParseError("Unexpected character");
    push({ kind: "atom", value: text.slice(start, pos) });
  }
  if (stack.length !== 1) throw new ParseError("Unbalanced parentheses");
  return stack[0] ?? [];
}

export function stringOf(token: Token | undefined): string | null {
  if (!token) return null;
  switch (token.kind) {
    case "atom":
    case "string":
      return token.value;
    case "list":
      return null;
    default: {
      const unexpected: never = token;
      throw new ParseError(`Unexpected token ${JSON.stringify(unexpected)}`);
    }
  }
}

export function requireString(token: Token | undefined, what: string): string {
  const value = stringOf(token);
  if (value === null) throw new ParseError(`Expected ${what}`);
  return value;
}

export type SeqRange = [number, number];

/** `*` is `max`. Ranges are normalised low to high. */
export function parseSequenceSet(value: string, max: number): SeqRange[] {
  if (!/^[0-9*:,]+$/.test(value)) throw new ParseError("Bad sequence set");
  const ranges: SeqRange[] = [];
  for (const part of value.split(",")) {
    const bounds = part.split(":");
    if (bounds.length > 2 || bounds.some((bound) => bound === "")) throw new ParseError("Bad sequence set");
    const numbers = bounds.map((bound) => {
      if (bound === "*") return max;
      const n = Number(bound);
      if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) throw new ParseError("Bad sequence number");
      return n;
    });
    const a = numbers[0] ?? 0;
    const b = numbers[1] ?? a;
    ranges.push([Math.min(a, b), Math.max(a, b)]);
  }
  return ranges;
}

export function inRanges(ranges: SeqRange[], n: number): boolean {
  return ranges.some(([low, high]) => n >= low && n <= high);
}

export type FetchItem =
  | { kind: "flags" }
  | { kind: "uid" }
  | { kind: "internaldate" }
  | { kind: "size" }
  | { kind: "envelope" }
  | { kind: "bodystructure"; extensible: boolean }
  | { kind: "section"; label: "BODY" | "RFC822" | "RFC822.HEADER" | "RFC822.TEXT"; section: string; peek: boolean; partial: [number, number] | null };

const MACROS: Record<string, string[]> = {
  ALL: ["FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE"],
  FAST: ["FLAGS", "INTERNALDATE", "RFC822.SIZE"],
  FULL: ["FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE", "BODY"],
};

function fetchItem(atom: string): FetchItem {
  const upper = atom.toUpperCase();
  switch (upper) {
    case "FLAGS":
      return { kind: "flags" };
    case "UID":
      return { kind: "uid" };
    case "INTERNALDATE":
      return { kind: "internaldate" };
    case "RFC822.SIZE":
      return { kind: "size" };
    case "ENVELOPE":
      return { kind: "envelope" };
    case "BODYSTRUCTURE":
      return { kind: "bodystructure", extensible: true };
    case "BODY":
      return { kind: "bodystructure", extensible: false };
    case "RFC822":
      return { kind: "section", label: "RFC822", section: "", peek: false, partial: null };
    case "RFC822.HEADER":
      return { kind: "section", label: "RFC822.HEADER", section: "HEADER", peek: true, partial: null };
    case "RFC822.TEXT":
      return { kind: "section", label: "RFC822.TEXT", section: "TEXT", peek: false, partial: null };
    default:
      break;
  }
  const match = /^(BODY|BODY\.PEEK|BINARY|BINARY\.PEEK)\[([^\]]*)\](?:<(\d+)\.(\d+)>)?$/i.exec(atom);
  if (!match) throw new ParseError(`Unknown fetch item ${atom.slice(0, 40)}`);
  const name = (match[1] ?? "").toUpperCase();
  if (name.startsWith("BINARY")) throw new ParseError("BINARY is not supported");
  const section = (match[2] ?? "").trim();
  if (!/^(?:\d+(?:\.\d+)*(?:\.(?:MIME|HEADER|TEXT|HEADER\.FIELDS(?:\.NOT)? \([^)]*\)))?|HEADER|TEXT|HEADER\.FIELDS(?:\.NOT)? \([^)]*\))?$/i.test(section)) {
    throw new ParseError("Bad section");
  }
  const partial: [number, number] | null = match[3] !== undefined ? [Number(match[3]), Number(match[4])] : null;
  return { kind: "section", label: "BODY", section, peek: name === "BODY.PEEK", partial };
}

export function parseFetchItems(token: Token | undefined): FetchItem[] {
  if (!token) throw new ParseError("Missing fetch items");
  if (token.kind === "list") {
    return token.items.map((item) => {
      if (item.kind !== "atom") throw new ParseError("Bad fetch item");
      return fetchItem(item.value);
    });
  }
  if (token.kind !== "atom") throw new ParseError("Bad fetch item");
  const macro = MACROS[token.value.toUpperCase()];
  if (macro) return macro.map(fetchItem);
  return [fetchItem(token.value)];
}
