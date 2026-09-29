import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const DAY = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
/** `From sender ctime-date`, e.g. `From mina@example.com Mon Sep  8 10:00:00 2025`. */
const SEPARATOR = new RegExp(`^From \\S+ +${DAY} +${MONTH} +\\d{1,2} +\\d{1,2}:\\d{2}(?::\\d{2})?(?: +\\S+)? +\\d{4}(?: +\\S+)?\\s*$`);
const ESCAPED_FROM = /^>+From /;

/**
 * Splits mbox line by line. Lines are latin1 strings, which map bytes 1:1, so
 * 8-bit bodies in any charset pass through untouched. A separator must look
 * like a real envelope line and follow a blank line (or start the file), so an
 * unescaped "From " in a body does not split the message. mboxrd `>From `
 * escaping is reversed.
 */
export class MboxSplitter {
  private current: string[] | null = null;
  private previousBlank = true;

  push(line: string): Buffer | null {
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    let done: Buffer | null = null;
    if (this.previousBlank && SEPARATOR.test(bare)) {
      done = this.flush();
      this.current = [];
    } else {
      this.current ??= [];
      this.current.push(ESCAPED_FROM.test(bare) ? bare.slice(1) : bare);
    }
    this.previousBlank = bare.trim() === "";
    return done;
  }

  end(): Buffer | null {
    return this.flush();
  }

  private flush(): Buffer | null {
    const lines = this.current;
    this.current = null;
    if (!lines) return null;
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
    if (lines.length === 0) return null;
    return Buffer.from(`${lines.join("\r\n")}\r\n`, "latin1");
  }
}

export function splitMbox(raw: Buffer | string): Buffer[] {
  const text = typeof raw === "string" ? Buffer.from(raw, "utf8").toString("latin1") : raw.toString("latin1");
  const splitter = new MboxSplitter();
  const out: Buffer[] = [];
  for (const line of text.split("\n")) {
    const done = splitter.push(line);
    if (done) out.push(done);
  }
  const last = splitter.end();
  if (last) out.push(last);
  return out;
}

/** Streams messages out of an mbox file without holding the whole file in memory. */
export async function* readMbox(path: string): AsyncGenerator<Buffer> {
  const lines = createInterface({ input: createReadStream(path, { encoding: "latin1" }), crlfDelay: Infinity });
  const splitter = new MboxSplitter();
  for await (const line of lines) {
    const done = splitter.push(line);
    if (done) yield done;
  }
  const last = splitter.end();
  if (last) yield last;
}
