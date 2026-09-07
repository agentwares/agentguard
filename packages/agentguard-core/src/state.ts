/**
 * Counter storage. The core only needs get/set/update on JSON values; the CLI supplies a
 * file-backed store (`./node`), the hosted tier a KV-backed one.
 */

export interface StateStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  /** read-modify-write; implementations serialize concurrent updates to the same key */
  update<T>(key: string, fn: (current: T | undefined) => T): Promise<T>;
  keys(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export class MemoryStateStore implements StateStore {
  private readonly map = new Map<string, unknown>();
  private chain: Promise<unknown> = Promise.resolve();

  async get(key: string): Promise<unknown> {
    return structuredClone(this.map.get(key));
  }
  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, structuredClone(value));
  }
  update<T>(key: string, fn: (current: T | undefined) => T): Promise<T> {
    const next = this.chain.then(() => {
      const value = fn(this.map.get(key) as T | undefined);
      this.map.set(key, structuredClone(value));
      return value;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
  async keys(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

/** `YYYY-MM-DD` in UTC — the per-day cap window. */
export function dayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
