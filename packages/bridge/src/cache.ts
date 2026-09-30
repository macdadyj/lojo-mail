/** Byte-bounded LRU. Holds decrypted messages in memory only; nothing here is ever written to disk. */
export class ByteLru<V> {
  private readonly entries = new Map<string, { value: V; bytes: number }>();
  private total = 0;

  constructor(private readonly maxBytes: number) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, bytes: number): void {
    this.delete(key);
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes });
    this.total += bytes;
    for (const [oldest, entry] of this.entries) {
      if (this.total <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.total -= entry.bytes;
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.total -= entry.bytes;
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }
}
