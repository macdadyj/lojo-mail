/** Caches a successful load for `ttlMs`. A rejected load is never cached, so the next call retries. */
export function ttlCache<T>(ttlMs: number, load: () => Promise<T>, now: () => number = Date.now) {
  let entry: { value: Promise<T>; at: number } | null = null;
  return {
    get(): Promise<T> {
      if (entry && now() - entry.at < ttlMs) return entry.value;
      const value = load();
      const current = { value, at: now() };
      entry = current;
      value.catch(() => {
        if (entry === current) entry = null;
      });
      return value;
    },
    clear(): void {
      entry = null;
    },
  };
}
