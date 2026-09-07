/**
 * `createGuard` — the policy engine for tool calls that bypass MCP. Same YAML, same caps, same
 * audit log as the proxy; file-backed when given a policy path, in-memory when given an object.
 */
import {
  Guard,
  GuardError,
  buildReport,
  parsePolicy,
  renderReportMarkdown,
  type AgentScope,
  type ApprovalRecord,
  type AuditEntry,
  type GuardErrorBody,
  type GuardEvent,
  type GuardResult,
  type Policy,
  type PolicyInput,
  type Report,
  type ToolAnnotationsLike,
} from "@agentwares/agentguard-core";
import {
  FileApprovalStore,
  FileAuditSink,
  FileKillSwitch,
  FileStateStore,
  loadPolicyFile,
  type LoadedPolicy,
} from "@agentwares/agentguard-core/node";

export interface CreateGuardOptions {
  /** path to `agentguard.yaml` (file-backed state, shared with the CLI) or an inline policy (in-memory) */
  policy: string | PolicyInput | Policy;
  /** run id for calls that do not pass one (default: generated) */
  runId?: string;
  /** agent scope by name (from `agents:` in the policy) */
  agent?: string;
  onEvent?: (event: GuardEvent) => void | Promise<void>;
  /** in-memory even when `policy` is a path */
  memory?: boolean;
  env?: Record<string, string | undefined>;
}

export interface ToolMeta {
  name: string;
  description?: string;
  annotations?: ToolAnnotationsLike;
  /** JSON Schema of the result — used to synthesize dry-run results */
  outputSchema?: Record<string, unknown>;
  /** override the guard's run id for this tool */
  runId?: string;
}

export interface WrapOptions extends ToolMeta {
  /** `throw` (default): blocked calls throw `GuardError`; `return`: they return the error body */
  onBlock?: "throw" | "return";
}

export type AnyFn = (...args: never[]) => unknown;

export function newRunId(now: Date = new Date()): string {
  return `run_${now
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}`;
}

export class AgentGuard {
  readonly guard: Guard;
  readonly policy: Policy;
  readonly loaded?: LoadedPolicy;
  readonly kill?: FileKillSwitch;
  runId: string;
  readonly agent: AgentScope | undefined;

  constructor(
    guard: Guard,
    opts: { runId: string; agent?: AgentScope; loaded?: LoadedPolicy; kill?: FileKillSwitch },
  ) {
    this.guard = guard;
    this.policy = guard.policy;
    this.runId = opts.runId;
    this.agent = opts.agent;
    this.loaded = opts.loaded;
    this.kill = opts.kill;
  }

  /** Start a new run (new per-run caps and loop window). Returns the id. */
  newRun(id: string = newRunId()): string {
    this.runId = id;
    return id;
  }

  /** Run one guarded call. `execute` receives the (unchanged) arguments. */
  run(meta: ToolMeta, args: unknown, execute: (args: unknown) => unknown): Promise<GuardResult> {
    return this.guard.run(
      {
        tool: {
          name: meta.name,
          description: meta.description,
          annotations: meta.annotations,
          outputSchema: meta.outputSchema,
        },
        args,
        runId: meta.runId ?? this.runId,
        agent: this.agent,
      },
      execute,
    );
  }

  /** Wrap a plain function `(args) => result`. Blocked calls throw `GuardError` (or return the body). */
  wrap<A, R>(
    fn: (args: A) => R | Promise<R>,
    opts: WrapOptions,
  ): (args: A) => Promise<R | GuardErrorBody> {
    return async (args: A) => {
      const result = await this.run(opts, args, (a) => fn(a as A));
      if (result.error && !result.ok) {
        if (opts.onBlock === "return") return result.error;
        throw new GuardError({
          code: result.error.code,
          cause: result.error.cause,
          fix: result.error.fix,
          retryable: result.error.retryable,
          details: result.error.details,
        });
      }
      return result.value as R;
    };
  }

  /** Wrap a map of named functions at once (`{ crm_get_contact: fn, ... }`). */
  wrapAll<T extends Record<string, AnyFn>>(
    fns: T,
    opts: { annotations?: Record<string, ToolAnnotationsLike>; onBlock?: "throw" | "return" } = {},
  ): {
    [K in keyof T]: (
      args: Parameters<T[K]>[0],
    ) => Promise<Awaited<ReturnType<T[K]>> | GuardErrorBody>;
  } {
    const out: Record<string, unknown> = {};
    for (const [name, fn] of Object.entries(fns)) {
      out[name] = this.wrap(fn as (args: unknown) => unknown, {
        name,
        annotations: opts.annotations?.[name],
        onBlock: opts.onBlock,
      });
    }
    return out as {
      [K in keyof T]: (
        args: Parameters<T[K]>[0],
      ) => Promise<Awaited<ReturnType<T[K]>> | GuardErrorBody>;
    };
  }

  /** Dollars spent outside a tool call (an LLM response, a paid API). Throws `CAP_EXCEEDED` when it does not fit. */
  spend(
    usd: number,
    label: string,
    opts: { details?: unknown; force?: boolean; runId?: string; reason?: string } = {},
  ): Promise<AuditEntry> {
    return this.guard.spend(opts.runId ?? this.runId, usd, {
      label,
      agent: this.agent,
      details: opts.details,
      force: opts.force,
      reason: opts.reason,
    });
  }

  async halt(reason = "killed via SDK"): Promise<void> {
    await this.guard.halt(reason);
    this.kill?.kill(reason);
  }
  async resume(): Promise<void> {
    await this.guard.resume();
    this.kill?.resume();
  }
  approve(id: string, by = "sdk", note?: string): Promise<ApprovalRecord | undefined> {
    return this.guard.decide(id, "approved", by, note);
  }
  deny(id: string, by = "sdk", note?: string): Promise<ApprovalRecord | undefined> {
    return this.guard.decide(id, "denied", by, note);
  }
  pendingApprovals(): Promise<ApprovalRecord[]> {
    return this.guard.approvals.list("pending");
  }
  status(runId: string = this.runId) {
    return this.guard.status(runId, this.agent);
  }
  audit(): Promise<AuditEntry[]> {
    return this.guard.audit.read();
  }
  async report(runId: string | null = this.runId): Promise<Report> {
    return buildReport(await this.audit(), { runId: runId ?? undefined });
  }
  async reportMarkdown(runId: string | null = this.runId): Promise<string> {
    return renderReportMarkdown(await this.report(runId));
  }
}

export async function createGuard(opts: CreateGuardOptions): Promise<AgentGuard> {
  const env = opts.env ?? process.env;
  let policy: Policy;
  let loaded: LoadedPolicy | undefined;
  if (typeof opts.policy === "string") {
    loaded = loadPolicyFile(opts.policy, { env });
    policy = loaded.policy;
  } else {
    policy =
      "version" in opts.policy &&
      typeof (opts.policy as Policy).kill === "object" &&
      (opts.policy as Policy).audit
        ? (opts.policy as Policy)
        : parsePolicy(opts.policy, { env });
  }
  const agent = opts.agent ? policy.agents.find((a) => a.name === opts.agent) : undefined;
  if (opts.agent && !agent)
    throw new GuardError({
      code: "INVALID_POLICY",
      cause: `no agent "${opts.agent}" in the policy`,
      fix: `add it under agents: or use one of ${policy.agents.map((a) => a.name).join(", ") || "(none)"}`,
    });
  const useFiles = loaded !== undefined && !opts.memory;
  const kill = useFiles ? new FileKillSwitch(loaded!.killPath) : undefined;
  const guard = new Guard({
    policy,
    env,
    onEvent: opts.onEvent,
    ...(useFiles
      ? {
          state: new FileStateStore(loaded!.stateDir),
          audit: new FileAuditSink(loaded!.auditPath),
          approvals: new FileApprovalStore(loaded!.stateDir),
          kill,
        }
      : {}),
  });
  return new AgentGuard(guard, { runId: opts.runId ?? newRunId(), agent, loaded, kill });
}
