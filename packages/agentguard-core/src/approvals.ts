/**
 * Destructive-action gating. A matching call creates a pending approval bound to
 * (tool, args hash); the agent gets `APPROVAL_REQUIRED` with the id; a human runs
 * `agentguard approve <id>` (or clicks the link in Slack); the agent retries the identical call
 * and it goes through once.
 */

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "consumed";

export interface ApprovalRecord {
  id: string;
  status: ApprovalStatus;
  tool: string;
  upstream?: string;
  args_hash: string;
  /** redacted arguments shown to the approver */
  args: unknown;
  run_id: string;
  agent?: string;
  created_at: string;
  expires_at: string;
  decided_at?: string;
  decided_by?: string;
  note?: string;
}

export interface ApprovalStore {
  create(record: ApprovalRecord): Promise<ApprovalRecord>;
  get(id: string): Promise<ApprovalRecord | undefined>;
  /** the newest decision-bearing record for this call (pending, approved or denied; never consumed/expired) */
  findByCall(tool: string, argsHash: string): Promise<ApprovalRecord | undefined>;
  update(id: string, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | undefined>;
  list(status?: ApprovalStatus): Promise<ApprovalRecord[]>;
}

export class MemoryApprovalStore implements ApprovalStore {
  readonly records = new Map<string, ApprovalRecord>();
  async create(record: ApprovalRecord): Promise<ApprovalRecord> {
    this.records.set(record.id, { ...record });
    return record;
  }
  async get(id: string): Promise<ApprovalRecord | undefined> {
    return this.records.get(id);
  }
  async findByCall(tool: string, argsHash: string): Promise<ApprovalRecord | undefined> {
    const matches = [...this.records.values()]
      .filter(
        (r) =>
          r.tool === tool &&
          r.args_hash === argsHash &&
          r.status !== "consumed" &&
          r.status !== "expired",
      )
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return matches[0];
  }
  async update(id: string, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | undefined> {
    const current = this.records.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.records.set(id, next);
    return next;
  }
  async list(status?: ApprovalStatus): Promise<ApprovalRecord[]> {
    return [...this.records.values()].filter((r) => !status || r.status === status);
  }
}

export function newApprovalId(random: () => string = () => crypto.randomUUID()): string {
  return `apr_${random().replace(/-/g, "").slice(0, 10)}`;
}

export function isExpired(record: ApprovalRecord, now: Date = new Date()): boolean {
  return new Date(record.expires_at).getTime() <= now.getTime();
}
