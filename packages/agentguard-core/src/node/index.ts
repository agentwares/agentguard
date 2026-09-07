/**
 * Node-only stores for the CLI: file-backed counters, the hash-chained JSONL audit file, the
 * KILL file, approvals on disk, and `loadPolicyFile`. Everything in `../index.js` stays
 * Web-standard; import this subpath only where `node:fs` is available.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  ChainWriter,
  GENESIS_HASH,
  parseAuditJsonl,
  verifyChain,
  type AuditEntry,
  type AuditEntryInput,
  type AuditSink,
  type VerifyResult,
} from "../audit.js";
import type { ApprovalRecord, ApprovalStatus, ApprovalStore } from "../approvals.js";
import type { KillState, KillSwitch } from "../kill.js";
import { guardError } from "../errors.js";
import { loadPolicyFromYaml, type LoadPolicyOptions, type Policy } from "../policy.js";
import type { StateStore } from "../state.js";

const LOCK_STALE_MS = 10_000;

/** Cheap cross-process mutex: `mkdir` is atomic on every platform. */
export function withFileLock<T>(lockPath: string, fn: () => T): T {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS)
          rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // raced with the owner
      }
      if (Date.now() > deadline)
        throw new Error(`could not acquire lock ${lockPath} within 5s`, { cause: err });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeAtomic(path: string, text: string): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Resolve a policy-relative path against the policy file's directory (or cwd). */
export function resolvePath(path: string, baseDir: string = process.cwd()): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

/** One JSON file for every counter, updated under a lock — safe across proxy processes. */
export class FileStateStore implements StateStore {
  private readonly file: string;
  private readonly lock: string;
  constructor(dir: string) {
    ensureDir(dir);
    this.file = join(dir, "state.json");
    this.lock = join(dir, "state.lock");
  }
  private readAll(): Record<string, unknown> {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  async get(key: string): Promise<unknown> {
    return this.readAll()[key];
  }
  async set(key: string, value: unknown): Promise<void> {
    withFileLock(this.lock, () => {
      const all = this.readAll();
      all[key] = value;
      writeAtomic(this.file, JSON.stringify(all));
    });
  }
  async update<T>(key: string, fn: (current: T | undefined) => T): Promise<T> {
    return withFileLock(this.lock, () => {
      const all = this.readAll();
      const next = fn(all[key] as T | undefined);
      all[key] = next;
      writeAtomic(this.file, JSON.stringify(all));
      return next;
    });
  }
  async keys(prefix: string): Promise<string[]> {
    return Object.keys(this.readAll()).filter((k) => k.startsWith(prefix));
  }
  async delete(key: string): Promise<void> {
    withFileLock(this.lock, () => {
      const all = this.readAll();
      delete all[key];
      writeAtomic(this.file, JSON.stringify(all));
    });
  }
}

function readTail(path: string): { seq: number; hash: string; size: number } {
  if (!existsSync(path)) return { seq: 0, hash: GENESIS_HASH, size: 0 };
  const size = statSync(path).size;
  if (size === 0) return { seq: 0, hash: GENESIS_HASH, size };
  const fd = openSync(path, "r");
  try {
    const chunk = Math.min(size, 65_536);
    const buf = Buffer.alloc(chunk);
    readSync(fd, buf, 0, buf.length, size - chunk);
    const text = buf.toString("utf8");
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    const last = lines[lines.length - 1];
    if (!last) return { seq: 0, hash: GENESIS_HASH, size };
    const entry = JSON.parse(last) as AuditEntry;
    return { seq: entry.seq, hash: entry.hash, size };
  } finally {
    closeSync(fd);
  }
}

/** Append-only JSONL with the hash chain continued from whatever is already in the file. */
export class FileAuditSink implements AuditSink {
  private writer: ChainWriter;
  private knownSize: number;
  private readonly lock: string;
  constructor(readonly path: string) {
    ensureDir(dirname(path));
    const tail = readTail(path);
    this.knownSize = tail.size;
    this.lock = `${path}.lock`;
    this.writer = new ChainWriter(tail.seq, tail.hash, async (line) => {
      withFileLock(this.lock, () => {
        appendFileSync(this.path, line + "\n");
        this.knownSize = statSync(this.path).size;
      });
    });
  }
  append(entry: AuditEntryInput): Promise<AuditEntry> {
    // Another process may have appended since our last write: continue from its head.
    const size = existsSync(this.path) ? statSync(this.path).size : 0;
    if (size !== this.knownSize) {
      const tail = readTail(this.path);
      this.writer.resync(tail.seq, tail.hash);
      this.knownSize = tail.size;
    }
    return this.writer.append(entry);
  }
  async read(): Promise<AuditEntry[]> {
    return readAuditFile(this.path);
  }
}

export function readAuditFile(path: string): AuditEntry[] {
  if (!existsSync(path)) return [];
  return parseAuditJsonl(readFileSync(path, "utf8"));
}

export async function verifyAuditFile(path: string): Promise<VerifyResult> {
  return verifyChain(readAuditFile(path));
}

/** `.agentguard/KILL` — presence means halt. The file body is the reason. */
export class FileKillSwitch implements KillSwitch {
  constructor(readonly path: string) {}
  check(): KillState {
    if (!existsSync(this.path)) return { killed: false };
    let reason = "KILL file present";
    let at: string | undefined;
    try {
      // The file is `<reason>\n<written at>\n`; the reason is the first line only, so it stays
      // one line inside the KILLED error the agent reads.
      const body = readFileSync(this.path, "utf8").split("\n")[0]?.trim();
      if (body) reason = body.slice(0, 200);
      at = statSync(this.path).mtime.toISOString();
    } catch {
      // unreadable is still killed
    }
    return { killed: true, reason, source: `file ${this.path}`, at };
  }
  kill(reason = "agentguard kill"): void {
    ensureDir(dirname(this.path));
    writeFileSync(this.path, `${reason}\n${new Date().toISOString()}\n`);
  }
  resume(): void {
    if (existsSync(this.path)) unlinkSync(this.path);
  }
}

/** One JSON file per approval in `<dir>/approvals/`. */
export class FileApprovalStore implements ApprovalStore {
  private readonly dir: string;
  constructor(stateDir: string) {
    this.dir = join(stateDir, "approvals");
    ensureDir(this.dir);
  }
  private file(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`invalid approval id ${id}`);
    return join(this.dir, `${id}.json`);
  }
  async create(record: ApprovalRecord): Promise<ApprovalRecord> {
    writeAtomic(this.file(record.id), JSON.stringify(record, null, 2));
    return record;
  }
  async get(id: string): Promise<ApprovalRecord | undefined> {
    const f = this.file(id);
    if (!existsSync(f)) return undefined;
    try {
      return JSON.parse(readFileSync(f, "utf8")) as ApprovalRecord;
    } catch {
      return undefined;
    }
  }
  async findByCall(tool: string, argsHash: string): Promise<ApprovalRecord | undefined> {
    const all = await this.list();
    return all
      .filter(
        (r) =>
          r.tool === tool &&
          r.args_hash === argsHash &&
          r.status !== "consumed" &&
          r.status !== "expired",
      )
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  }
  async update(id: string, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | undefined> {
    const current = await this.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    writeAtomic(this.file(id), JSON.stringify(next, null, 2));
    return next;
  }
  async list(status?: ApprovalStatus): Promise<ApprovalRecord[]> {
    const out: ApprovalRecord[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const r = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as ApprovalRecord;
        if (!status || r.status === status) out.push(r);
      } catch {
        // skip corrupt
      }
    }
    return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }
}

export interface LoadedPolicy {
  policy: Policy;
  path: string;
  /** directory policy-relative paths resolve against */
  baseDir: string;
  stateDir: string;
  auditPath: string;
  killPath: string;
}

/** Read and parse `agentguard.yaml`; resolves state/audit/kill paths relative to the file. */
export function loadPolicyFile(path: string, opts: LoadPolicyOptions = {}): LoadedPolicy {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw guardError({
      code: "INVALID_POLICY",
      cause: `no policy file at ${abs} — run \`agentguard init\` to generate one, or pass --config <path>`,
      fix: "run `agentguard init` in the directory with your agent's MCP config",
    });
  }
  const policy = loadPolicyFromYaml(readFileSync(abs, "utf8"), { env: process.env, ...opts });
  const baseDir = dirname(abs);
  const stateDir = resolvePath(policy.state.dir, baseDir);
  return {
    policy,
    path: abs,
    baseDir,
    stateDir,
    auditPath: resolvePath(policy.audit.path, baseDir),
    killPath: resolvePath(policy.kill.file, baseDir),
  };
}
