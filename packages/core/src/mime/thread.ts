import { sha256 } from "../ids.ts";

export interface Threadable {
  rfcMessageId: string;
  inReplyTo?: string;
  references: string[];
}

class UnionFind {
  private parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    this.add(id);
    let current = id;
    while (this.parent.get(current) !== current) {
      const next = this.parent.get(current);
      if (!next) break;
      current = next;
    }
    let cursor = id;
    while (this.parent.get(cursor) !== current) {
      const next = this.parent.get(cursor);
      this.parent.set(cursor, current);
      if (!next) break;
      cursor = next;
    }
    return current;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

/** References plus this message's id. The id is last, and it is listed once. */
export function appendMessageId(references: string[], rfcMessageId: string): string[] {
  const out: string[] = [];
  for (const item of [...references, rfcMessageId]) {
    const value = item.trim();
    if (!value || value.length > 250 || out.includes(value)) continue;
    out.push(value);
    if (out.length >= 50) break;
  }
  return out;
}

export function threadIdForRoot(rootRfcId: string): string {
  return `thr_${sha256(rootRfcId).slice(0, 24)}`;
}

/** Group messages that share References or In-Reply-To. */
export function assignThreadIds(messages: Threadable[]): Map<string, string> {
  const uf = new UnionFind();
  for (const message of messages) {
    uf.add(message.rfcMessageId);
    if (message.inReplyTo) uf.union(message.rfcMessageId, message.inReplyTo);
    for (const ref of message.references) uf.union(message.rfcMessageId, ref);
  }
  const groups = new Map<string, string[]>();
  for (const message of messages) {
    const root = uf.find(message.rfcMessageId);
    const list = groups.get(root) ?? [];
    list.push(message.rfcMessageId);
    groups.set(root, list);
  }
  const out = new Map<string, string>();
  for (const message of messages) {
    const root = uf.find(message.rfcMessageId);
    const members = groups.get(root) ?? [message.rfcMessageId];
    const canonical = [...members].sort()[0] ?? message.rfcMessageId;
    out.set(message.rfcMessageId, threadIdForRoot(canonical));
  }
  return out;
}
