import type { Socket } from "node:net";
import { assertNever } from "@lojo/core";
import { ApiError } from "./api.ts";
import type { LoginGuard } from "./auth.ts";
import { DEFINED_FLAGS, hasFlag, sameSet } from "./flags.ts";
import { astring, bodyStructure, envelope, istring, literal, sectionBytes, type Out } from "./imap-format.ts";
import {
  CommandReader,
  inRanges,
  parseFetchItems,
  parseSequenceSet,
  ParseError,
  requireString,
  stringOf,
  tokenize,
  type FetchItem,
  type RawCommand,
  type Token,
} from "./imap-parse.ts";
import { matches, parseKeys, type SearchTarget } from "./imap-search.ts";
import { errorMessage, type Logger } from "./log.ts";
import { CannotError, findMailbox, MAILBOXES, type MailboxDef, type MailStore } from "./mailstore.ts";
import { internalDate, messageDate, type BuiltMessage } from "./mime.ts";

export const CAPABILITIES = "IMAP4rev1 LITERAL+ SASL-IR AUTH=PLAIN IDLE MOVE SPECIAL-USE NAMESPACE ID UNSELECT";

const AUTOLOGOUT_MS = 31 * 60_000;

export interface SessionContext {
  store: MailStore;
  guard: LoginGuard;
  logger: Logger;
  pollSeconds: number;
  newMailSeconds: number;
  version: string;
}

interface Slot {
  uid: number;
  id: string;
  flags: string[];
}

type SessionState = "notauth" | "auth" | "selected" | "logout";

/** A tagged NO with an optional response code. */
class No extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "No";
  }
}

function flagList(flags: readonly string[]): string {
  return `(${flags.join(" ")})`;
}

function patternRegex(pattern: string): RegExp {
  const body = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/%/g, "[^/]*");
  return new RegExp(`^${body}$`, "i");
}

export class ImapSession {
  private state: SessionState = "notauth";
  private box: MailboxDef | null = null;
  private readOnly = false;
  private slots: Slot[] = [];
  private readonly queue: RawCommand[] = [];
  private busy = false;
  private lineHandler: ((command: RawCommand) => void) | null = null;
  private syncing: Promise<void> = Promise.resolve();
  private readonly reader: CommandReader;
  private closed = false;

  constructor(
    private readonly socket: Socket,
    private readonly ctx: SessionContext,
    private readonly id: number,
  ) {
    this.reader = new CommandReader({
      command: (command) => this.onCommand(command),
      continuation: () => this.writeNow(["+ Ready for literal data\r\n"]),
      reject: (reason, tag, fatal) => this.onReject(reason, tag, fatal),
    });
    socket.setNoDelay(true);
    socket.setTimeout(AUTOLOGOUT_MS);
    socket.on("data", (chunk: Buffer) => {
      try {
        this.reader.push(chunk);
      } catch (error) {
        this.ctx.logger.error("imap.reader_failed", { session: this.id, reason: errorMessage(error) });
        this.shutdown("Internal error");
      }
    });
    socket.on("timeout", () => this.shutdown("Autologout; idle for too long"));
    socket.on("error", (error) => {
      this.ctx.logger.warn("imap.socket_error", { session: this.id, reason: errorMessage(error) });
      this.closed = true;
      socket.destroy();
    });
    socket.on("close", () => {
      this.closed = true;
      this.lineHandler?.({ text: "\0closed", literals: [] });
    });
    this.writeNow([`* OK [CAPABILITY ${CAPABILITIES}] lojo-mail bridge ready\r\n`]);
  }

  shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.end(`* BYE ${reason}\r\n`);
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

  private writeNow(out: Out): void {
    if (this.closed) return;
    this.socket.write(Buffer.concat(out.map((part) => (typeof part === "string" ? Buffer.from(part, "utf8") : part))));
  }

  private async write(out: Out): Promise<void> {
    if (this.closed) return;
    const flushed = this.socket.write(Buffer.concat(out.map((part) => (typeof part === "string" ? Buffer.from(part, "utf8") : part))));
    if (!flushed && !this.closed) {
      await new Promise<void>((resolve) => {
        const done = () => {
          this.socket.off("drain", done);
          this.socket.off("close", done);
          resolve();
        };
        this.socket.on("drain", done);
        this.socket.on("close", done);
      });
    }
  }

  private onReject(reason: string, tag: string | null, fatal: boolean): void {
    if (fatal) {
      this.shutdown(reason);
      return;
    }
    this.writeNow([`${tag ?? "*"} BAD ${reason}\r\n`]);
  }

  private onCommand(command: RawCommand): void {
    if (this.lineHandler) {
      this.lineHandler(command);
      return;
    }
    this.queue.push(command);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let command = this.queue.shift(); command && !this.closed; command = this.queue.shift()) {
        await this.run(command);
      }
    } finally {
      this.busy = false;
    }
  }

  private async run(command: RawCommand): Promise<void> {
    let tag = /^([^\s(){%*"\\\]\0+]+) /.exec(command.text)?.[1] ?? "*";
    try {
      const tokens = tokenize(command.text, command.literals);
      const tagToken = tokens[0];
      const nameToken = tokens[1];
      if (tagToken?.kind !== "atom" || tagToken.value === "*" || tagToken.value.includes("+")) throw new ParseError("Missing tag");
      tag = tagToken.value;
      if (nameToken?.kind !== "atom") throw new ParseError("Missing command");
      await this.dispatch(tag, nameToken.value.toUpperCase(), tokens.slice(2));
    } catch (error) {
      await this.write([this.failure(tag, error)]);
    }
  }

  private failure(tag: string, error: unknown): string {
    if (error instanceof ParseError) return `${tag} BAD ${error.message}\r\n`;
    if (error instanceof No) return `${tag} NO ${error.code ? `[${error.code}] ` : ""}${error.message}\r\n`;
    if (error instanceof CannotError) return `${tag} NO [CANNOT] ${error.message}\r\n`;
    if (error instanceof ApiError) {
      const code = error.status === 0 || error.status >= 500 ? "UNAVAILABLE" : "CANNOT";
      this.ctx.logger.warn("imap.api_error", { session: this.id, status: error.status });
      return `${tag} NO [${code}] lojo-mail API: ${error.message.replace(/[\r\n]/g, " ")}\r\n`;
    }
    this.ctx.logger.error("imap.command_failed", { session: this.id, reason: errorMessage(error) });
    return `${tag} NO [SERVERBUG] Internal bridge error\r\n`;
  }

  private requireAuth(): void {
    if (this.state === "notauth") throw new No("Log in first");
  }

  private requireSelected(): MailboxDef {
    if (this.state !== "selected" || !this.box) throw new No("Select a mailbox first");
    return this.box;
  }

  private requireWritable(): MailboxDef {
    const box = this.requireSelected();
    if (this.readOnly) throw new No("Mailbox is read-only (EXAMINE)", "READ-ONLY");
    return box;
  }

  private async dispatch(tag: string, name: string, args: Token[]): Promise<void> {
    switch (name) {
      case "CAPABILITY":
        await this.write([`* CAPABILITY ${CAPABILITIES}\r\n${tag} OK CAPABILITY completed\r\n`]);
        return;
      case "NOOP":
      case "CHECK":
        if (this.state === "selected") await this.sync();
        await this.write([`${tag} OK ${name} completed\r\n`]);
        return;
      case "LOGOUT":
        await this.write([`* BYE lojo-mail bridge signing off\r\n${tag} OK LOGOUT completed\r\n`]);
        this.state = "logout";
        this.closed = true;
        this.socket.end();
        return;
      case "ID":
        await this.write(["* ID (", ...istring("name"), " ", ...istring("lojo-mail-bridge"), " ", ...istring("version"), " ", ...istring(this.ctx.version), `)\r\n${tag} OK ID completed\r\n`]);
        return;
      case "STARTTLS":
        throw new No("TLS is not offered: the bridge only listens on 127.0.0.1");
      case "LOGIN":
        return this.login(tag, requireString(args[0], "user name"), requireString(args[1], "password"));
      case "AUTHENTICATE":
        return this.authenticate(tag, args);
      case "ENABLE":
        this.requireAuth();
        await this.write([`* ENABLED\r\n${tag} OK ENABLE completed\r\n`]);
        return;
      default:
        break;
    }
    this.requireAuth();
    switch (name) {
      case "NAMESPACE":
        await this.write([`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK NAMESPACE completed\r\n`]);
        return;
      case "LIST":
        return this.list(tag, args, false);
      case "LSUB":
        return this.list(tag, args, true);
      case "SUBSCRIBE":
      case "UNSUBSCRIBE":
        await this.write([`${tag} OK ${name} completed\r\n`]);
        return;
      case "CREATE":
      case "DELETE":
      case "RENAME":
        throw new No("lojo-mail has a fixed set of folders", "CANNOT");
      case "STATUS":
        return this.status(tag, args);
      case "SELECT":
      case "EXAMINE":
        return this.select(tag, requireString(args[0], "mailbox"), name === "EXAMINE");
      case "APPEND":
        return this.append(tag, args);
      case "IDLE":
        return this.idle(tag);
      default:
        break;
    }
    switch (name) {
      case "CLOSE":
        return this.close(tag, true);
      case "UNSELECT":
        return this.close(tag, false);
      case "EXPUNGE":
        return this.expunge(tag);
      case "SEARCH":
        return this.search(tag, args, false);
      case "FETCH":
        return this.fetch(tag, args, false);
      case "STORE":
        return this.store(tag, args, false);
      case "COPY":
        return this.move(tag, args, false, "COPY");
      case "MOVE":
        return this.move(tag, args, false, "MOVE");
      case "UID":
        return this.uid(tag, args);
      default:
        throw new ParseError(`Unknown command ${name.slice(0, 30)}`);
    }
  }

  private async uid(tag: string, args: Token[]): Promise<void> {
    const sub = requireString(args[0], "UID command").toUpperCase();
    const rest = args.slice(1);
    switch (sub) {
      case "FETCH":
        return this.fetch(tag, rest, true);
      case "SEARCH":
        return this.search(tag, rest, true);
      case "STORE":
        return this.store(tag, rest, true);
      case "COPY":
        return this.move(tag, rest, true, "COPY");
      case "MOVE":
        return this.move(tag, rest, true, "MOVE");
      default:
        throw new ParseError(`Unknown UID command ${sub.slice(0, 30)}`);
    }
  }

  private async login(tag: string, username: string, password: string): Promise<void> {
    if (this.state !== "notauth") throw new ParseError("Already logged in");
    const outcome = await this.ctx.guard.attempt(username, password);
    switch (outcome) {
      case "ok":
        this.state = "auth";
        this.ctx.logger.info("imap.login", { session: this.id });
        await this.write([`${tag} OK [CAPABILITY ${CAPABILITIES}] Logged in\r\n`]);
        return;
      case "bad":
        this.ctx.logger.warn("imap.login_failed", { session: this.id });
        throw new No("Invalid credentials", "AUTHENTICATIONFAILED");
      case "locked":
        this.ctx.logger.warn("imap.login_locked", { session: this.id });
        throw new No("Too many failed logins; try again later", "UNAVAILABLE");
      default:
        assertNever(outcome, "login outcome");
    }
  }

  private nextLine(): Promise<RawCommand> {
    return new Promise((resolve) => {
      this.lineHandler = (command) => {
        this.lineHandler = null;
        resolve(command);
      };
    });
  }

  private async authenticate(tag: string, args: Token[]): Promise<void> {
    if (this.state !== "notauth") throw new ParseError("Already logged in");
    const mechanism = requireString(args[0], "mechanism").toUpperCase();
    if (mechanism !== "PLAIN") throw new No("Only AUTH=PLAIN is supported", "CANNOT");
    let response = stringOf(args[1]);
    if (response === null) {
      const line = this.nextLine();
      await this.write(["+ \r\n"]);
      response = (await line).text.trim();
    }
    if (response === "*") throw new ParseError("AUTHENTICATE cancelled");
    if (response === "\0closed") return;
    const decoded = response === "=" ? "" : Buffer.from(response, "base64").toString("utf8");
    const [authzid, authcid, password] = decoded.split("\0");
    if (authcid === undefined || password === undefined || (authzid && authzid !== authcid)) {
      throw new No("Invalid credentials", "AUTHENTICATIONFAILED");
    }
    return this.login(tag, authcid, password);
  }

  private async list(tag: string, args: Token[], lsub: boolean): Promise<void> {
    let rest = args;
    let specialOnly = false;
    if (!lsub && rest[0]?.kind === "list") {
      specialOnly = rest[0].items.some((item) => stringOf(item)?.toUpperCase() === "SPECIAL-USE");
      rest = rest.slice(1);
    }
    const reference = requireString(rest[0], "reference");
    const patternToken = rest[1];
    const patterns = patternToken?.kind === "list" ? patternToken.items.map((item) => requireString(item, "pattern")) : [requireString(patternToken, "pattern")];
    const verb = lsub ? "LSUB" : "LIST";
    const out: Out = [];
    if (patterns.length === 1 && patterns[0] === "") {
      out.push(`* ${verb} (\\Noselect) "/" ""\r\n`);
    } else {
      const regexes = patterns.map((pattern) => patternRegex(`${reference}${pattern}`));
      for (const box of MAILBOXES) {
        if (specialOnly && !box.specialUse) continue;
        if (!regexes.some((regex) => regex.test(box.name))) continue;
        const attributes = ["\\HasNoChildren", ...(box.specialUse ? [box.specialUse] : [])];
        out.push(`* ${verb} (${attributes.join(" ")}) "/" `, ...astring(box.name), "\r\n");
      }
    }
    out.push(`${tag} OK ${verb} completed\r\n`);
    await this.write(out);
  }

  private mailbox(name: string): MailboxDef {
    const box = findMailbox(name);
    if (!box) throw new No(`No mailbox ${name.slice(0, 60)}`, "NONEXISTENT");
    return box;
  }

  private async status(tag: string, args: Token[]): Promise<void> {
    const name = requireString(args[0], "mailbox");
    const box = this.mailbox(name);
    const items = args[1];
    if (items?.kind !== "list") throw new ParseError("STATUS needs a list of items");
    const entries = await this.ctx.store.list(box);
    const parts: string[] = [];
    for (const item of items.items) {
      const key = requireString(item, "status item").toUpperCase();
      switch (key) {
        case "MESSAGES":
          parts.push(`MESSAGES ${entries.length}`);
          break;
        case "RECENT":
          parts.push("RECENT 0");
          break;
        case "UIDNEXT":
          parts.push(`UIDNEXT ${this.ctx.store.uidNext(box)}`);
          break;
        case "UIDVALIDITY":
          parts.push(`UIDVALIDITY ${this.ctx.store.uidValidity(box)}`);
          break;
        case "UNSEEN":
          parts.push(`UNSEEN ${entries.filter((entry) => !hasFlag(this.ctx.store.flags(entry.id), "\\Seen")).length}`);
          break;
        default:
          throw new ParseError(`Unknown status item ${key.slice(0, 30)}`);
      }
    }
    await this.write(["* STATUS ", ...astring(box.name), ` (${parts.join(" ")})\r\n${tag} OK STATUS completed\r\n`]);
  }

  private async select(tag: string, name: string, readOnly: boolean): Promise<void> {
    this.state = "auth";
    this.box = null;
    this.slots = [];
    const box = this.mailbox(name);
    const entries = await this.ctx.store.list(box);
    this.slots = entries.map((entry) => ({ uid: entry.uid, id: entry.id, flags: this.ctx.store.flags(entry.id) }));
    this.box = box;
    this.readOnly = readOnly;
    this.state = "selected";
    const firstUnseen = this.slots.findIndex((slot) => !hasFlag(slot.flags, "\\Seen"));
    const out = [
      `* FLAGS ${flagList(DEFINED_FLAGS)}\r\n`,
      `* OK [PERMANENTFLAGS ${readOnly ? "()" : flagList([...DEFINED_FLAGS, "\\*"])}] Flags sync to lojo-mail labels\r\n`,
      `* ${this.slots.length} EXISTS\r\n`,
      "* 0 RECENT\r\n",
      ...(firstUnseen >= 0 ? [`* OK [UNSEEN ${firstUnseen + 1}] First unseen\r\n`] : []),
      `* OK [UIDVALIDITY ${this.ctx.store.uidValidity(box)}] UIDs valid\r\n`,
      `* OK [UIDNEXT ${this.ctx.store.uidNext(box)}] Predicted next UID\r\n`,
      `${tag} OK [${readOnly ? "READ-ONLY" : "READ-WRITE"}] ${readOnly ? "EXAMINE" : "SELECT"} completed\r\n`,
    ];
    await this.write(out);
  }

  /** Brings the selected mailbox up to date with the service. Only called where untagged EXPUNGE is allowed. */
  private sync(): Promise<void> {
    const run = this.syncing.then(() => this.syncNow());
    this.syncing = run.catch(() => undefined);
    return run;
  }

  private async syncNow(): Promise<void> {
    const box = this.box;
    if (this.state !== "selected" || !box) return;
    const entries = await this.ctx.store.list(box);
    if (this.box !== box) return;
    const current = new Set(entries.map((entry) => entry.uid));
    const out: Out = [];
    for (let index = this.slots.length - 1; index >= 0; index -= 1) {
      const slot = this.slots[index];
      if (!slot || current.has(slot.uid)) continue;
      out.push(`* ${index + 1} EXPUNGE\r\n`);
      this.slots.splice(index, 1);
    }
    this.slots.forEach((slot, index) => {
      const flags = this.ctx.store.flags(slot.id);
      if (sameSet(flags, slot.flags)) return;
      slot.flags = flags;
      out.push(`* ${index + 1} FETCH (UID ${slot.uid} FLAGS ${flagList(flags)})\r\n`);
    });
    const maxUid = this.slots[this.slots.length - 1]?.uid ?? 0;
    const added = entries.filter((entry) => entry.uid > maxUid);
    if (added.length > 0) {
      for (const entry of added) this.slots.push({ uid: entry.uid, id: entry.id, flags: this.ctx.store.flags(entry.id) });
      out.push(`* ${this.slots.length} EXISTS\r\n`, "* 0 RECENT\r\n");
    }
    if (out.length > 0) await this.write(out);
  }

  private resolve(setText: string, uidMode: boolean): Array<{ slot: Slot; seq: number }> {
    if (uidMode) {
      const ranges = parseSequenceSet(setText, this.slots[this.slots.length - 1]?.uid ?? 0);
      return this.slots.map((slot, index) => ({ slot, seq: index + 1 })).filter(({ slot }) => inRanges(ranges, slot.uid));
    }
    const ranges = parseSequenceSet(setText, this.slots.length);
    return this.slots.map((slot, index) => ({ slot, seq: index + 1 })).filter(({ seq }) => inRanges(ranges, seq));
  }

  private async close(tag: string, expunge: boolean): Promise<void> {
    const box = this.requireSelected();
    if (expunge && !this.readOnly) {
      for (const slot of this.slots) if (this.ctx.store.isDeleted(slot.id)) await this.ctx.store.remove(slot.id, box);
    }
    this.state = "auth";
    this.box = null;
    this.slots = [];
    await this.write([`${tag} OK ${expunge ? "CLOSE" : "UNSELECT"} completed\r\n`]);
  }

  private async expunge(tag: string): Promise<void> {
    const box = this.requireWritable();
    const out: Out = [];
    let failure: unknown = null;
    for (let index = this.slots.length - 1; index >= 0; index -= 1) {
      const slot = this.slots[index];
      if (!slot || !this.ctx.store.isDeleted(slot.id)) continue;
      try {
        await this.ctx.store.remove(slot.id, box);
      } catch (error) {
        failure = error;
        break;
      }
      this.slots.splice(index, 1);
      out.push(`* ${index + 1} EXPUNGE\r\n`);
    }
    out.push(failure ? this.failure(tag, failure) : `${tag} OK EXPUNGE completed; nothing is hard deleted, deleted mail is recoverable in the web app\r\n`);
    await this.write(out);
  }

  private async search(tag: string, args: Token[], uidMode: boolean): Promise<void> {
    this.requireSelected();
    let rest = args;
    if (stringOf(rest[0])?.toUpperCase() === "CHARSET") {
      const charset = requireString(rest[1], "charset").toUpperCase();
      if (charset !== "UTF-8" && charset !== "US-ASCII") throw new No("Only UTF-8 and US-ASCII are supported", "BADCHARSET (UTF-8 US-ASCII)");
      rest = rest.slice(2);
    }
    const keys = parseKeys(rest);
    const maxSeq = this.slots.length;
    const maxUid = this.slots[this.slots.length - 1]?.uid ?? 0;
    const hits: number[] = [];
    for (const [index, slot] of this.slots.entries()) {
      const view = this.ctx.store.view(slot.id);
      if (!view) continue;
      const target: SearchTarget = {
        seq: index + 1,
        uid: slot.uid,
        maxSeq,
        maxUid,
        view,
        flags: this.ctx.store.flags(slot.id),
        message: () => this.ctx.store.message(slot.id),
        size: () => this.ctx.store.size(slot.id),
      };
      let ok = true;
      for (const key of keys) {
        if (!(await matches(key, target))) {
          ok = false;
          break;
        }
      }
      if (ok) hits.push(uidMode ? slot.uid : index + 1);
    }
    await this.write([`* SEARCH${hits.map((hit) => ` ${hit}`).join("")}\r\n${tag} OK SEARCH completed\r\n`]);
  }

  private async fetch(tag: string, args: Token[], uidMode: boolean): Promise<void> {
    this.requireSelected();
    const setText = requireString(args[0], "sequence set");
    const items = parseFetchItems(args[1]);
    if (uidMode && !items.some((item) => item.kind === "uid")) items.unshift({ kind: "uid" });
    const targets = this.resolve(setText, uidMode);
    for (const { slot, seq } of targets) {
      await this.write([`* ${seq} FETCH (`, ...(await this.fetchOne(slot, items)), ")\r\n"]);
    }
    await this.write([`${tag} OK ${uidMode ? "UID " : ""}FETCH completed\r\n`]);
  }

  private async fetchOne(slot: Slot, items: FetchItem[]): Promise<Out> {
    const view = this.ctx.store.view(slot.id);
    if (!view) throw new No("Message is gone; run NOOP", "EXPUNGEISSUED");
    const needsMessage = items.some((item) => item.kind === "section" || item.kind === "bodystructure");
    const message: BuiltMessage | null = needsMessage ? await this.ctx.store.message(slot.id) : null;
    const setsSeen = items.some((item) => item.kind === "section" && !item.peek);
    let flagsChanged = false;
    if (setsSeen && !this.readOnly && !hasFlag(slot.flags, "\\Seen")) {
      await this.ctx.store.markSeen(slot.id);
      slot.flags = this.ctx.store.flags(slot.id);
      flagsChanged = true;
    }
    const parts: Out[] = [];
    for (const item of items) {
      switch (item.kind) {
        case "uid":
          parts.push([`UID ${slot.uid}`]);
          break;
        case "flags":
          parts.push([`FLAGS ${flagList(slot.flags)}`]);
          break;
        case "internaldate":
          parts.push([`INTERNALDATE "${internalDate(messageDate(view))}"`]);
          break;
        case "size":
          parts.push([`RFC822.SIZE ${message ? message.raw.length : await this.ctx.store.size(slot.id)}`]);
          break;
        case "envelope":
          parts.push(["ENVELOPE ", ...envelope(view)]);
          break;
        case "bodystructure":
          if (message) parts.push([item.extensible ? "BODYSTRUCTURE " : "BODY ", ...bodyStructure(message.root, item.extensible)]);
          break;
        case "section": {
          if (!message) break;
          let bytes = sectionBytes(message, item.section);
          let label = item.label === "BODY" ? `BODY[${item.section}]` : item.label;
          if (item.partial) {
            const [start, length] = item.partial;
            bytes = bytes.subarray(Math.min(start, bytes.length), Math.min(start + length, bytes.length));
            label += `<${start}>`;
          }
          parts.push([`${label} `, ...literal(bytes)]);
          break;
        }
        default:
          assertNever(item, "fetch item");
      }
    }
    if (flagsChanged && !items.some((item) => item.kind === "flags")) parts.push([`FLAGS ${flagList(slot.flags)}`]);
    const out: Out = [];
    parts.forEach((part, index) => {
      if (index > 0) out.push(" ");
      out.push(...part);
    });
    return out;
  }

  private async store(tag: string, args: Token[], uidMode: boolean): Promise<void> {
    this.requireWritable();
    const setText = requireString(args[0], "sequence set");
    const action = requireString(args[1], "store action").toUpperCase();
    const match = /^([+-]?)FLAGS(\.SILENT)?$/.exec(action);
    if (!match) throw new ParseError("STORE supports FLAGS, +FLAGS, and -FLAGS");
    const flagTokens = args[2]?.kind === "list" ? args[2].items : args.slice(2);
    const flags = flagTokens.map((token) => requireString(token, "flag")).filter((flag) => flag.toLowerCase() !== "\\recent");
    const silent = Boolean(match[2]);
    const out: Out = [];
    for (const { slot, seq } of this.resolve(setText, uidMode)) {
      const current = this.ctx.store.flags(slot.id);
      let next: string[];
      if (match[1] === "+") next = [...current, ...flags.filter((flag) => !hasFlag(current, flag))];
      else if (match[1] === "-") next = current.filter((flag) => !hasFlag(flags, flag));
      else next = flags;
      await this.ctx.store.setFlags(slot.id, next);
      slot.flags = this.ctx.store.flags(slot.id);
      if (!silent) out.push(`* ${seq} FETCH (${uidMode ? `UID ${slot.uid} ` : ""}FLAGS ${flagList(slot.flags)})\r\n`);
    }
    out.push(`${tag} OK STORE completed\r\n`);
    await this.write(out);
  }

  /**
   * lojo-mail keeps exactly one copy of each message, so COPY files the message
   * in the target folder like MOVE does and reports the source copy expunged
   * (untagged EXPUNGE is allowed during COPY). COPY within one folder is a no-op.
   */
  private async move(tag: string, args: Token[], uidMode: boolean, verb: "COPY" | "MOVE"): Promise<void> {
    const from = this.requireWritable();
    const setText = requireString(args[0], "sequence set");
    const name = requireString(args[1], "mailbox");
    const to = findMailbox(name);
    if (!to) throw new No(`No mailbox ${name.slice(0, 60)}`, "TRYCREATE");
    const targets = this.resolve(setText, uidMode);
    if (to.name === from.name) {
      await this.write([`${tag} OK ${verb} completed (same mailbox)\r\n`]);
      return;
    }
    if (to.folder === "sent" || to.folder === "drafts") throw new CannotError(`Messages cannot be moved into ${to.name}`);
    const moved: Slot[] = [];
    let failure: unknown = null;
    for (const { slot } of targets) {
      try {
        await this.ctx.store.moveTo(slot.id, from, to);
        moved.push(slot);
      } catch (error) {
        failure = error;
        break;
      }
    }
    const out: Out = [];
    for (let index = this.slots.length - 1; index >= 0; index -= 1) {
      const slot = this.slots[index];
      if (!slot || !moved.includes(slot)) continue;
      this.slots.splice(index, 1);
      out.push(`* ${index + 1} EXPUNGE\r\n`);
    }
    const done = verb === "COPY" ? `${tag} OK COPY completed; lojo-mail keeps one copy, so the message moved\r\n` : `${tag} OK MOVE completed\r\n`;
    out.push(failure ? this.failure(tag, failure) : done);
    await this.write(out);
  }

  /**
   * Thunderbird APPENDs a copy of each sent message to Sent: the service writes
   * its own Sent copy (with the Message-ID SES gave it), so this one is dropped.
   * Drafts saved with APPEND become drafts on the service.
   */
  private async append(tag: string, args: Token[]): Promise<void> {
    const name = requireString(args[0], "mailbox");
    const last = args[args.length - 1];
    if (args.length < 2 || last?.kind !== "string") throw new ParseError("APPEND needs a message literal");
    const box = findMailbox(name);
    if (!box) throw new No(`No mailbox ${name.slice(0, 60)}`, "TRYCREATE");
    switch (box.folder) {
      case "sent":
        this.ctx.logger.info("imap.append_dropped", { session: this.id, mailbox: box.name, bytes: last.bytes?.length ?? last.value.length });
        await this.write([`${tag} OK APPEND completed (not stored: lojo-mail keeps its own Sent copy)\r\n`]);
        return;
      case "drafts":
        await this.ctx.store.appendDraft(last.bytes ?? Buffer.from(last.value, "latin1"));
        this.ctx.logger.info("imap.draft_saved", { session: this.id });
        await this.write([`${tag} OK APPEND completed\r\n`]);
        return;
      case "inbox":
      case "archive":
      case "spam":
      case "trash":
        throw new No("Messages can only arrive in lojo-mail by email", "CANNOT");
      default:
        assertNever(box.folder, "folder");
    }
  }

  private async idle(tag: string): Promise<void> {
    const done = this.nextLine();
    let timer: NodeJS.Timeout | null = null;
    let pending: NodeJS.Timeout | null = null;
    const poke = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        this.sync().catch((error: unknown) => this.ctx.logger.warn("imap.idle_sync_failed", { session: this.id, reason: errorMessage(error) }));
      }, 100);
    };
    const box = this.box;
    let checking = false;
    const checkNew = () => {
      if (checking || !box) return;
      checking = true;
      this.ctx.store
        .hasNewMail(box)
        .then((fresh) => {
          if (fresh) poke();
        })
        .catch((error: unknown) => this.ctx.logger.warn("imap.new_mail_check_failed", { session: this.id, reason: errorMessage(error) }))
        .finally(() => {
          checking = false;
        });
    };
    this.ctx.store.on("changed", poke);
    timer = setInterval(poke, this.ctx.pollSeconds * 1000);
    const fast = setInterval(checkNew, this.ctx.newMailSeconds * 1000);
    await this.write(["+ idling\r\n"]);
    try {
      const line = await done;
      if (line.text === "\0closed") return;
      await this.syncing;
      if (line.text.trim().toUpperCase() !== "DONE") throw new ParseError("Expected DONE");
      await this.write([`${tag} OK IDLE terminated\r\n`]);
    } finally {
      this.ctx.store.off("changed", poke);
      if (timer) clearInterval(timer);
      clearInterval(fast);
      if (pending) clearTimeout(pending);
    }
  }
}
