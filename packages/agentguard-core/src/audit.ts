/**
 * Hash-chained JSONL audit log. Every entry carries `prev_hash` and `hash = sha256(prev_hash +
 * canonical(entry without hash))`; `verifyChain` recomputes the chain and reports the first break.
 */
import { sha256Hex, stableStringify } from "./normalize.js";
import type { ToolClass, MutationVerb } from "./classify.js";
import type { GuardErrorBody } from "./errors.js";
import type { MutationRecord } from "./dryrun.js";

export type AuditOutcome = "ok" | "error" | "blocked" | "faked" | "halted" | "pending";

export interface AuditEntry {
  /** monotonically increasing per log file */
  seq: number;
  ts: string;
  run_id: string;
  agent?: string;
  session_id?: string;
  upstream?: string;
  tool: string;
  class: ToolClass;
  verb: MutationVerb;
  mode: "dry-run" | "enforce";
  outcome: AuditOutcome;
  /** the structured error returned to the agent, when any */
  error?: GuardErrorBody;
  args_hash: string;
  args?: unknown;
  result?: unknown;
  result_hash?: string;
  /** dry-run material */
  mutation?: MutationRecord;
  /** dollars charged (estimate before, actual after when the result reported it) */
  usd?: number;
  counters?: Record<string, number>;
  latency_ms?: number;
  /** why it was classified that way / why it was blocked */
  reason?: string;
  prev_hash: string;
  hash: string;
}

export type AuditEntryInput = Omit<AuditEntry, "seq" | "prev_hash" | "hash">;

export const GENESIS_HASH = "0".repeat(64);

export async function hashEntry(
  prevHash: string,
  entry: Omit<AuditEntry, "hash">,
): Promise<string> {
  const { prev_hash: _p, ...rest } = entry;
  return sha256Hex(prevHash + stableStringify(rest));
}

export interface AuditSink {
  append(entry: AuditEntryInput): Promise<AuditEntry>;
  /** every entry, oldest first (in-memory sinks) — file sinks stream instead */
  read(): Promise<AuditEntry[]>;
}

/** Serialize appends so the chain stays linear even under concurrent tool calls. */
export class ChainWriter {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private seq: number,
    private lastHash: string,
    private readonly write: (line: string, entry: AuditEntry) => Promise<void>,
  ) {}

  get head(): { seq: number; hash: string } {
    return { seq: this.seq, hash: this.lastHash };
  }

  /** Re-sync with another writer that appended to the same file. */
  resync(seq: number, hash: string): void {
    this.seq = seq;
    this.lastHash = hash;
  }

  append(input: AuditEntryInput): Promise<AuditEntry> {
    const next = this.queue.then(async () => {
      const seq = this.seq + 1;
      const partial: Omit<AuditEntry, "hash"> = { ...input, seq, prev_hash: this.lastHash };
      const hash = await hashEntry(this.lastHash, partial);
      const entry: AuditEntry = { ...partial, hash };
      await this.write(JSON.stringify(entry), entry);
      this.seq = seq;
      this.lastHash = hash;
      return entry;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export class MemoryAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];
  private readonly writer = new ChainWriter(0, GENESIS_HASH, async (_line, entry) => {
    this.entries.push(entry);
  });
  append(entry: AuditEntryInput): Promise<AuditEntry> {
    return this.writer.append(entry);
  }
  async read(): Promise<AuditEntry[]> {
    return [...this.entries];
  }
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  /** seq of the first entry whose hash or prev_hash does not match */
  brokenAt?: number;
  reason?: string;
  head?: string;
}

/** Recompute every hash. `entries` must be in file order. */
export async function verifyChain(entries: readonly AuditEntry[]): Promise<VerifyResult> {
  let prev = GENESIS_HASH;
  let expectedSeq = 1;
  for (const entry of entries) {
    if (entry.seq !== expectedSeq) {
      return {
        ok: false,
        entries: entries.length,
        brokenAt: entry.seq,
        reason: `expected seq ${expectedSeq}, found ${entry.seq} (entry removed or reordered)`,
      };
    }
    if (entry.prev_hash !== prev) {
      return {
        ok: false,
        entries: entries.length,
        brokenAt: entry.seq,
        reason: `prev_hash does not match the previous entry's hash (entry inserted, removed or reordered)`,
      };
    }
    const { hash, ...rest } = entry;
    const recomputed = await hashEntry(prev, rest);
    if (recomputed !== hash) {
      return {
        ok: false,
        entries: entries.length,
        brokenAt: entry.seq,
        reason: "hash does not match the entry's content (entry edited)",
      };
    }
    prev = hash;
    expectedSeq += 1;
  }
  return { ok: true, entries: entries.length, head: prev };
}

/** Parse JSONL text into entries; blank lines are skipped, a malformed line throws with its number. */
export function parseAuditJsonl(text: string): AuditEntry[] {
  const out: AuditEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as AuditEntry);
    } catch {
      throw new Error(`audit log line ${i + 1} is not valid JSON`);
    }
  }
  return out;
}
