/**
 * The policy engine. One `Guard` instance serves the MCP proxy and the SDK: `run(call, execute)`
 * applies kill switch → scope → classification → approval → loop breaker → caps → dry-run or
 * execute → spend accounting → audit, and returns a structured result the caller relays.
 */
import {
  classifyTool,
  countsFor,
  effectiveClass,
  type Classification,
  type ToolClass,
  type ToolLike,
} from "./classify.js";
import { CapsEngine, type CapCheck, type CounterDelta } from "./caps.js";
import {
  GENESIS_HASH,
  MemoryAuditSink,
  type AuditEntry,
  type AuditEntryInput,
  type AuditOutcome,
  type AuditSink,
} from "./audit.js";
import {
  isExpired,
  MemoryApprovalStore,
  newApprovalId,
  type ApprovalRecord,
  type ApprovalStore,
} from "./approvals.js";
import { mutationTarget, synthesizeResult, type MutationRecord } from "./dryrun.js";
import { GuardError, toErrorBody, type GuardErrorBody } from "./errors.js";
import { matchesAny } from "./glob.js";
import {
  CompositeKillSwitch,
  EnvKillSwitch,
  MemoryKillSwitch,
  type KillState,
  type KillSwitch,
} from "./kill.js";
import { describePattern, detectLoop, LoopDetector } from "./loop.js";
import { normalizeArgs, redactSecrets, sha256Hex, stableStringify } from "./normalize.js";
import {
  DEFAULT_COUNTERS,
  effectiveCaps,
  type AgentScope,
  type Mode,
  type Policy,
} from "./policy.js";
import { estimateSpendFromArgs, extractSpendFromResult } from "./spend.js";
import { MemoryStateStore, type StateStore } from "./state.js";

export interface GuardEvent {
  type:
    | "KILLED"
    | "APPROVAL_REQUIRED"
    | "LOOP_DETECTED"
    | "CAP_EXCEEDED"
    | "TOOL_DENIED"
    | "APPROVAL_DECIDED";
  runId: string;
  tool: string;
  entry?: AuditEntry;
  error?: GuardErrorBody;
  approval?: ApprovalRecord;
  at: string;
}

export interface GuardOptions {
  policy: Policy;
  state?: StateStore;
  audit?: AuditSink;
  kill?: KillSwitch;
  approvals?: ApprovalStore;
  now?: () => Date;
  /** called for every halt/block/approval — wire alerts here */
  onEvent?: (event: GuardEvent) => void | Promise<void>;
  /** a URL a human can open to approve (HTTP proxy) */
  approvalUrl?: (record: ApprovalRecord) => string | undefined;
  /** how the caller signals "the tool ran but reported failure" (MCP: `isError: true`) */
  resultIsError?: (value: unknown) => boolean;
  /** environment for the env kill switch (default `process.env`) */
  env?: Record<string, string | undefined>;
  sleep?: (ms: number) => Promise<void>;
}

export interface GuardCall {
  tool: ToolLike;
  args: unknown;
  runId: string;
  agent?: AgentScope | null;
  sessionId?: string;
  upstream?: string;
}

export interface Decision {
  action: "allow" | "fake" | "block" | "halt" | "approve";
  class: ToolClass | "block";
  classification: Classification;
  mode: Mode;
  code?: string;
  reason?: string;
  delta: CounterDelta;
  usdEstimate?: number;
}

export interface GuardResult {
  ok: boolean;
  value?: unknown;
  error?: GuardErrorBody;
  outcome: AuditOutcome;
  faked: boolean;
  entry: AuditEntry;
  decision: Decision;
}

export type Execute = (args: unknown) => Promise<unknown> | unknown;

const defaultIsError = (value: unknown): boolean =>
  Boolean(value && typeof value === "object" && (value as { isError?: unknown }).isError === true);

export class Guard {
  readonly policy: Policy;
  readonly state: StateStore;
  readonly audit: AuditSink;
  readonly kill: KillSwitch;
  readonly approvals: ApprovalStore;
  readonly caps: CapsEngine;
  readonly loops: LoopDetector;
  private readonly now: () => Date;
  private readonly onEvent?: GuardOptions["onEvent"];
  private readonly approvalUrl?: GuardOptions["approvalUrl"];
  private readonly resultIsError: (value: unknown) => boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly memoryKill = new MemoryKillSwitch();

  constructor(opts: GuardOptions) {
    this.policy = opts.policy;
    this.state = opts.state ?? new MemoryStateStore();
    this.audit = opts.audit ?? new MemoryAuditSink();
    this.approvals = opts.approvals ?? new MemoryApprovalStore();
    this.now = opts.now ?? (() => new Date());
    this.kill = new CompositeKillSwitch([
      this.memoryKill,
      new EnvKillSwitch(opts.policy.kill.env, opts.env ?? process.env),
      ...(opts.kill ? [opts.kill] : []),
    ]);
    this.caps = new CapsEngine(this.state, this.now);
    this.loops = new LoopDetector({
      window: opts.policy.loop.window,
      max_repeats: opts.policy.loop.max_repeats,
      max_cycle_len: opts.policy.loop.max_cycle_len,
      ignore_args: opts.policy.loop.ignore_args,
    });
    this.onEvent = opts.onEvent;
    this.approvalUrl = opts.approvalUrl;
    this.resultIsError = opts.resultIsError ?? defaultIsError;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Halt every run served by this guard (memory source; file/env sources are separate). */
  async halt(reason = "killed via API"): Promise<void> {
    await this.memoryKill.kill(reason);
  }
  async resume(): Promise<void> {
    await this.kill.resume();
  }
  killState(): Promise<KillState> | KillState {
    return this.kill.check();
  }

  /** Counters and remaining budget for a run. */
  async status(
    runId: string,
    agent?: AgentScope | null,
  ): Promise<{
    usage: Awaited<ReturnType<CapsEngine["usage"]>>;
    caps: Policy["caps"];
    remaining: CapCheck["remaining"];
    killed: KillState;
  }> {
    const caps = effectiveCaps(this.policy, agent);
    const usage = await this.caps.usage(runId, agent?.name);
    const check = await this.caps.check(runId, caps, {}, agent?.name);
    return { usage, caps, remaining: check.remaining, killed: await this.kill.check() };
  }

  /** Classify without running — used by `tools/list` to annotate and by `init`. */
  classify(tool: ToolLike): Classification {
    return classifyTool(tool, this.policy);
  }

  /** Approve / deny a pending approval. */
  async decide(
    id: string,
    decision: "approved" | "denied",
    by = "cli",
    note?: string,
  ): Promise<ApprovalRecord | undefined> {
    const record = await this.approvals.get(id);
    if (!record) return undefined;
    if (record.status !== "pending") return record;
    const updated = await this.approvals.update(id, {
      status: decision,
      decided_at: this.now().toISOString(),
      decided_by: by,
      note,
    });
    if (updated)
      await this.emit({
        type: "APPROVAL_DECIDED",
        runId: updated.run_id,
        tool: updated.tool,
        approval: updated,
        at: this.now().toISOString(),
      });
    return updated;
  }

  /**
   * Record dollars spent outside a tool call (LLM tokens via the SDK's guarded fetch). Checks
   * the spend caps first and throws `CAP_EXCEEDED` when the amount does not fit.
   */
  async spend(
    runId: string,
    usd: number,
    meta: {
      label: string;
      agent?: AgentScope | null;
      details?: unknown;
      force?: boolean;
      /** why this amount, when it is worth saying — e.g. "no list price for this model" */
      reason?: string;
    },
  ): Promise<AuditEntry> {
    const caps = effectiveCaps(this.policy, meta.agent);
    const delta: CounterDelta = { spend_usd: usd };
    const check = await this.caps.check(runId, caps, delta, meta.agent?.name);
    const base: AuditEntryInput = {
      ts: this.now().toISOString(),
      run_id: runId,
      agent: meta.agent?.name,
      tool: meta.label,
      class: "spend",
      verb: "spend",
      mode: meta.agent?.mode ?? this.policy.mode,
      outcome: "ok",
      args_hash: await sha256Hex(stableStringify(meta.details ?? {})),
      args: meta.details,
      usd,
      counters: delta,
      reason: meta.reason,
    };
    if (!check.ok && !meta.force) {
      const error = capError(check, runId);
      const entry = await this.audit.append({
        ...base,
        outcome: "blocked",
        error,
        reason: error.cause,
      });
      await this.emit({
        type: "CAP_EXCEEDED",
        runId,
        tool: meta.label,
        entry,
        error,
        at: entry.ts,
      });
      throw new GuardError({
        code: error.code,
        cause: error.cause,
        fix: error.fix,
        retryable: false,
        details: error.details,
      });
    }
    await this.caps.charge(runId, delta, meta.agent?.name);
    if (!check.ok) {
      // Money already left (e.g. a streamed LLM response): record it, alert, block the next call.
      const error = capError(check, runId);
      const entry = await this.audit.append({
        ...base,
        reason: `over cap after the fact: ${error.cause}`,
      });
      await this.emit({
        type: "CAP_EXCEEDED",
        runId,
        tool: meta.label,
        entry,
        error,
        at: entry.ts,
      });
      return entry;
    }
    return this.audit.append(base);
  }

  /** Pre-flight for an amount without charging (the SDK's fetch wrapper estimates before sending). */
  async canSpend(runId: string, usd: number, agent?: AgentScope | null): Promise<CapCheck> {
    return this.caps.check(
      runId,
      effectiveCaps(this.policy, agent),
      { spend_usd: usd },
      agent?.name,
    );
  }

  async run(call: GuardCall, execute: Execute): Promise<GuardResult> {
    const startedAt = this.now();
    const policy = this.policy;
    const agent = call.agent ?? undefined;
    const mode: Mode = agent?.mode ?? policy.mode;
    const name = call.tool.name;
    const classification = classifyTool(call.tool, policy);
    const cls = effectiveClass(classification, policy);
    const redactedArgs = policy.audit.redact ? redactSecrets(call.args) : call.args;
    const argsHash = await sha256Hex(normalizeArgs(call.args, { collapseVolatile: false }));
    const counters = { ...DEFAULT_COUNTERS, ...policy.counters };

    const delta: CounterDelta = { tool_calls: 1 };
    const isMutation = cls === "write" || cls === "spend" || cls === "block";
    if (isMutation) delta.writes = 1;
    if (
      isMutation &&
      (classification.destructive ||
        classification.verb === "delete" ||
        countsFor(name, counters, "deletes"))
    )
      delta.deletes = 1;
    if (isMutation && countsFor(name, counters, "emails")) delta.emails = 1;
    for (const counter of Object.keys(policy.counters)) {
      if (counter === "deletes" || counter === "emails") continue;
      if (countsFor(name, counters, counter)) delta[counter] = 1;
    }
    const spendEstimate = estimateSpendFromArgs(policy, name, call.args);
    let usdEstimate: number | undefined = spendEstimate?.usd;
    if (usdEstimate === undefined && cls === "spend") usdEstimate = policy.spend.default_usd;
    if (usdEstimate !== undefined && usdEstimate > 0) delta.spend_usd = usdEstimate;

    const decision: Decision = {
      action: "allow",
      class: cls,
      classification,
      mode,
      delta,
      usdEstimate,
    };
    const base = (): AuditEntryInput => ({
      ts: startedAt.toISOString(),
      run_id: call.runId,
      agent: agent?.name,
      session_id: call.sessionId,
      upstream: call.upstream,
      tool: name,
      class: classification.class,
      verb: classification.verb,
      mode,
      outcome: "ok",
      args_hash: argsHash,
      args: truncate(redactedArgs, policy.audit.max_chars),
      reason: `${classification.source}: ${classification.reason}`,
      counters: delta,
      usd: usdEstimate,
    });

    const fail = async (
      outcome: AuditOutcome,
      error: GuardErrorBody,
      action: Decision["action"],
      eventType?: GuardEvent["type"],
      approval?: ApprovalRecord,
    ): Promise<GuardResult> => {
      decision.action = action;
      decision.code = error.code;
      decision.reason = error.cause;
      const entry = await this.audit.append({
        ...base(),
        outcome,
        error,
        reason: error.cause,
        latency_ms: this.now().getTime() - startedAt.getTime(),
      });
      if (eventType)
        await this.emit({
          type: eventType,
          runId: call.runId,
          tool: name,
          entry,
          error,
          approval,
          at: entry.ts,
        });
      return { ok: false, error, outcome, faked: false, entry, decision };
    };

    // 1. kill switch
    const killed = await this.kill.check();
    if (killed.killed) {
      return fail(
        "halted",
        {
          code: "KILLED",
          cause: `agentguard kill switch is on (${killed.source ?? "unknown"}: ${killed.reason ?? "no reason given"})`,
          fix: "stop the run; a human must run `agentguard resume` (or clear the KILL file / AGENTGUARD_KILL) before any tool call succeeds",
          retryable: false,
          details: { source: killed.source, reason: killed.reason, at: killed.at },
        },
        "halt",
        "KILLED",
      );
    }

    // 2. scope
    const denied = scopeDenial(policy, agent, name, call.upstream);
    if (denied) return fail("blocked", denied, "block", "TOOL_DENIED");

    // 3. unknown → block
    if (cls === "block" && mode === "enforce") {
      return fail(
        "blocked",
        {
          code: "TOOL_DENIED",
          cause: `"${name}" could not be classified (no annotations, no recognizable verb) and classify.unknown is "block"`,
          fix: `add "${name}" to classify.read or classify.write in agentguard.yaml`,
          retryable: false,
          details: { classification },
        },
        "block",
        "TOOL_DENIED",
      );
    }

    const willFake = (mode === "dry-run" && isMutation) || matchesAny(name, policy.dry_run.tools);

    // 4. approval (only when the call would really execute)
    if (!willFake && matchesAny(name, policy.approval.tools)) {
      const outcome = await this.checkApproval(call, name, argsHash, redactedArgs);
      if (outcome.kind === "denied") return fail("blocked", outcome.error, "block");
      if (outcome.kind === "pending")
        return fail(
          "pending",
          outcome.error,
          "approve",
          outcome.fresh ? "APPROVAL_REQUIRED" : undefined,
          outcome.record,
        );
    }

    // 5. loop breaker
    const verdict = this.loops.observe(call.runId, name, call.args);
    const loopVerdict =
      cls === "read"
        ? detectLoop(this.loops.window(call.runId), {
            ...policy.loop,
            max_repeats: policy.loop.max_read_repeats,
          })
        : verdict;
    if (loopVerdict.looping) {
      const pattern = describePattern(loopVerdict.pattern ?? []);
      return fail(
        "halted",
        {
          code: "LOOP_DETECTED",
          cause:
            loopVerdict.kind === "repeat"
              ? `"${name}" was called ${loopVerdict.repeats} times with the same arguments in the last ${policy.loop.window} calls`
              : `the sequence ${pattern} repeated ${loopVerdict.repeats} times in the last ${policy.loop.window} calls`,
          fix: "you are looping: do not retry this call with the same arguments; change approach, ask the user, or stop",
          retryable: false,
          details: {
            kind: loopVerdict.kind,
            repeats: loopVerdict.repeats,
            cycleLength: loopVerdict.cycleLength,
            pattern: loopVerdict.pattern,
          },
        },
        "halt",
        "LOOP_DETECTED",
      );
    }

    // 6. caps
    const caps = effectiveCaps(policy, agent);
    const check = await this.caps.check(call.runId, caps, delta, agent?.name);
    if (!check.ok) return fail("blocked", capError(check, call.runId), "block", "CAP_EXCEEDED");

    // 7. dry-run
    if (willFake) {
      decision.action = "fake";
      const value = policy.dry_run.synthesize
        ? synthesizeResult({
            tool: name,
            args: call.args,
            outputSchema: call.tool.outputSchema,
            now: this.now,
          })
        : { ok: true, dry_run: true };
      const mutation: MutationRecord = {
        tool: name,
        verb: classification.verb,
        upstream: call.upstream,
        args: truncate(redactedArgs, policy.audit.max_chars),
        target: mutationTarget(call.args),
        usd: usdEstimate,
      };
      await this.caps.charge(call.runId, delta, agent?.name);
      const entry = await this.audit.append({
        ...base(),
        outcome: "faked",
        mutation,
        result: policy.audit.include_results ? truncate(value, policy.audit.max_chars) : undefined,
        result_hash: await sha256Hex(stableStringify(value)),
        latency_ms: this.now().getTime() - startedAt.getTime(),
      });
      return { ok: true, value, outcome: "faked", faked: true, entry, decision };
    }

    // 8. execute
    let value: unknown;
    let error: GuardErrorBody | undefined;
    try {
      value = await execute(call.args);
      if (this.resultIsError(value)) error = toErrorBody(errorFromResult(value));
    } catch (err) {
      error =
        err instanceof GuardError
          ? err.toJSON()
          : { ...toErrorBody(err), code: "UPSTREAM_ERROR", retryable: true };
    }
    const actual = error ? undefined : extractSpendFromResult(policy, value);
    const charged: CounterDelta = { ...delta };
    if (error) delete charged.spend_usd;
    else if (actual !== undefined) charged.spend_usd = actual;
    await this.caps.charge(call.runId, charged, agent?.name);
    const outcome: AuditOutcome = error ? "error" : "ok";
    const entry = await this.audit.append({
      ...base(),
      outcome,
      error,
      counters: charged,
      usd: charged.spend_usd,
      result:
        policy.audit.include_results && !error
          ? truncate(value, policy.audit.max_chars)
          : undefined,
      result_hash: value === undefined ? undefined : await sha256Hex(stableStringify(value)),
      latency_ms: this.now().getTime() - startedAt.getTime(),
    });
    return error && value === undefined
      ? { ok: false, error, outcome, faked: false, entry, decision }
      : { ok: !error, value, error, outcome, faked: false, entry, decision };
  }

  private async checkApproval(
    call: GuardCall,
    name: string,
    argsHash: string,
    redactedArgs: unknown,
  ): Promise<
    | { kind: "granted" }
    | { kind: "denied"; error: GuardErrorBody }
    | { kind: "pending"; error: GuardErrorBody; fresh: boolean; record: ApprovalRecord }
  > {
    const policy = this.policy;
    const now = this.now();
    let record = await this.approvals.findByCall(name, argsHash);
    if (record && isExpired(record, now)) {
      await this.approvals.update(record.id, { status: "expired" });
      record = undefined;
    }
    if (record?.status === "approved") {
      await this.approvals.update(record.id, { status: "consumed" });
      return { kind: "granted" };
    }
    if (record?.status === "denied") {
      return {
        kind: "denied",
        error: {
          code: "APPROVAL_DENIED",
          cause: `a human denied "${name}" with these arguments (approval ${record.id}${record.note ? `: ${record.note}` : ""})`,
          fix: "do not retry this call; explain to the user that it was denied and ask how to proceed",
          retryable: false,
          details: { approvalId: record.id, decidedBy: record.decided_by, note: record.note },
        },
      };
    }
    let fresh = false;
    if (!record) {
      fresh = true;
      record = await this.approvals.create({
        id: newApprovalId(),
        status: "pending",
        tool: name,
        upstream: call.upstream,
        args_hash: argsHash,
        args: truncate(redactedArgs, policy.audit.max_chars),
        run_id: call.runId,
        agent: call.agent?.name,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + policy.approval.ttl_s * 1000).toISOString(),
      });
    }
    if (policy.approval.wait_s > 0) {
      const deadline = now.getTime() + policy.approval.wait_s * 1000;
      while (this.now().getTime() < deadline) {
        await this.sleep(Math.min(500, Math.max(10, deadline - this.now().getTime())));
        const latest = await this.approvals.get(record.id);
        if (!latest || latest.status === "pending") continue;
        if (latest.status === "approved") {
          await this.approvals.update(latest.id, { status: "consumed" });
          return { kind: "granted" };
        }
        if (latest.status === "denied") {
          return {
            kind: "denied",
            error: {
              code: "APPROVAL_DENIED",
              cause: `a human denied "${name}" (approval ${latest.id}${latest.note ? `: ${latest.note}` : ""})`,
              fix: "do not retry this call; explain to the user that it was denied and ask how to proceed",
              retryable: false,
              details: { approvalId: latest.id, decidedBy: latest.decided_by, note: latest.note },
            },
          };
        }
        break;
      }
    }
    const url = this.approvalUrl?.(record);
    return {
      kind: "pending",
      fresh,
      record,
      error: {
        code: "APPROVAL_REQUIRED",
        cause: `"${name}" needs a human's approval before it runs (approval ${record.id})`,
        fix: `tell the user to run \`agentguard approve ${record.id}\`${url ? ` or open ${url}` : ""}, then retry this exact call once; do not change the arguments`,
        retryable: true,
        details: {
          approvalId: record.id,
          expiresAt: record.expires_at,
          command: `agentguard approve ${record.id}`,
          url,
        },
      },
    };
  }

  private async emit(event: GuardEvent): Promise<void> {
    if (!this.onEvent) return;
    try {
      await this.onEvent(event);
    } catch {
      // alerts never break the call path
    }
  }
}

function scopeDenial(
  policy: Policy,
  agent: AgentScope | undefined,
  name: string,
  upstream: string | undefined,
): GuardErrorBody | undefined {
  const deny = (cause: string, fix: string): GuardErrorBody => ({
    code: "TOOL_DENIED",
    cause,
    fix,
    retryable: false,
  });
  if (agent?.upstreams && upstream && !agent.upstreams.includes(upstream)) {
    return deny(
      `agent "${agent.name}" may not use upstream "${upstream}"`,
      `use one of: ${agent.upstreams.join(", ")}; or ask the operator to widen the agent's scope`,
    );
  }
  if (agent && matchesAny(name, agent.deny))
    return deny(
      `"${name}" is denied for agent "${agent.name}"`,
      "use a different tool or ask the operator to allow it",
    );
  if (agent && agent.allow.length > 0 && !matchesAny(name, agent.allow)) {
    return deny(
      `"${name}" is outside agent "${agent.name}"'s allowlist`,
      `allowed patterns: ${agent.allow.join(", ")}`,
    );
  }
  if (matchesAny(name, policy.deny))
    return deny(
      `"${name}" is denied by agentguard.yaml`,
      "use a different tool; the operator can remove it from `deny`",
    );
  if (policy.allow && policy.allow.length > 0 && !matchesAny(name, policy.allow)) {
    return deny(
      `"${name}" is not in the agentguard.yaml allowlist`,
      `allowed patterns: ${policy.allow.join(", ")}`,
    );
  }
  return undefined;
}

function capError(check: CapCheck, runId: string): GuardErrorBody {
  const x = check.exceeded!;
  const scope = x.scope === "per_run" ? "this run" : "today";
  const unit = x.counter === "spend_usd" ? "$" : "";
  return {
    code: "CAP_EXCEEDED",
    cause: `${x.counter} cap for ${scope} is ${unit}${x.limit}; used ${unit}${x.used}, this call would make it ${unit}${x.attempted}`,
    fix:
      x.scope === "per_run"
        ? "stop and report to the user what is done and what remains; a human can raise caps.per_run in agentguard.yaml or start a new run"
        : "stop for today and report to the user; a human can raise caps.per_day in agentguard.yaml",
    retryable: false,
    details: {
      scope: x.scope,
      counter: x.counter,
      limit: x.limit,
      used: x.used,
      attempted: x.attempted,
      remaining: check.remaining,
      runId,
    },
  };
}

function errorFromResult(value: unknown): unknown {
  const v = value as { content?: { type?: string; text?: string }[]; structuredContent?: unknown };
  if (v.structuredContent && typeof (v.structuredContent as { code?: unknown }).code === "string")
    return v.structuredContent;
  const text = v.content?.find((b) => b.type === "text")?.text;
  if (text) {
    try {
      const parsed = JSON.parse(text) as { code?: unknown };
      if (parsed && typeof parsed.code === "string") return parsed;
    } catch {
      // plain text error
    }
    return {
      code: "UPSTREAM_ERROR",
      cause: text.slice(0, 500),
      fix: "read the error and adjust the call",
      retryable: false,
    };
  }
  return {
    code: "UPSTREAM_ERROR",
    cause: "tool reported an error",
    fix: "read the error and adjust the call",
    retryable: false,
  };
}

function truncate(value: unknown, maxChars: number): unknown {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= maxChars) return value;
  return { _truncated: true, preview: text.slice(0, maxChars) };
}

export { GENESIS_HASH };
