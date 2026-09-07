/**
 * Blast-radius caps: per-run and per-day counters (tool_calls, writes, deletes, emails,
 * spend_usd, custom) checked before a call and charged after it.
 */
import type { Caps } from "./policy.js";
import { dayKey, type StateStore } from "./state.js";

export interface CapCheck {
  ok: boolean;
  /** first cap that would be exceeded */
  exceeded?: {
    scope: "per_run" | "per_day";
    counter: string;
    limit: number;
    used: number;
    attempted: number;
  };
  remaining: Record<string, { per_run?: number; per_day?: number }>;
}

export type CounterDelta = Record<string, number>;

export interface CapsScope {
  per_run: Caps;
  per_day: Caps;
}

export class CapsEngine {
  constructor(
    private readonly store: StateStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private runKey(runId: string): string {
    return `run:${runId}`;
  }
  private dayKeyFor(agent?: string): string {
    return `day:${dayKey(this.now())}${agent ? `:${agent}` : ""}`;
  }

  async usage(
    runId: string,
    agent?: string,
  ): Promise<{ per_run: CounterDelta; per_day: CounterDelta }> {
    const run = ((await this.store.get(this.runKey(runId))) as CounterDelta | undefined) ?? {};
    const day = ((await this.store.get(this.dayKeyFor(agent))) as CounterDelta | undefined) ?? {};
    return { per_run: run, per_day: day };
  }

  /** Would charging `delta` exceed any cap? Does not charge. */
  async check(
    runId: string,
    caps: CapsScope,
    delta: CounterDelta,
    agent?: string,
  ): Promise<CapCheck> {
    const usage = await this.usage(runId, agent);
    const remaining: CapCheck["remaining"] = {};
    let exceeded: CapCheck["exceeded"];
    for (const scope of ["per_run", "per_day"] as const) {
      const limits = caps[scope];
      const used = usage[scope];
      for (const [counter, limit] of Object.entries(limits)) {
        if (typeof limit !== "number") continue;
        const current = used[counter] ?? 0;
        const attempted = current + (delta[counter] ?? 0);
        remaining[counter] = {
          ...remaining[counter],
          [scope]: round(Math.max(0, limit - current)),
        };
        // A counter is checked whenever the call declares it, *including at delta 0*: money can
        // land after the fact (a spend tool that only reports its price in the result, an LLM
        // response priced from its usage block), so a later call with no estimate of its own must
        // still be refused while the counter sits over the limit. Counters the call does not
        // touch are ignored — a read is not blocked because the writes cap is used up.
        if (!exceeded && counter in delta && attempted > limit + 1e-9) {
          exceeded = { scope, counter, limit, used: round(current), attempted: round(attempted) };
        }
      }
    }
    return { ok: !exceeded, exceeded, remaining };
  }

  async charge(runId: string, delta: CounterDelta, agent?: string): Promise<void> {
    const apply = (current: CounterDelta | undefined): CounterDelta => {
      const next = { ...(current ?? {}) };
      for (const [k, v] of Object.entries(delta)) if (v) next[k] = round((next[k] ?? 0) + v);
      return next;
    };
    await this.store.update<CounterDelta>(this.runKey(runId), apply);
    await this.store.update<CounterDelta>(this.dayKeyFor(agent), apply);
    if (agent) await this.store.update<CounterDelta>(this.dayKeyFor(), apply);
  }

  async resetRun(runId: string): Promise<void> {
    await this.store.delete(this.runKey(runId));
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
