/**
 * Semantic loop breaker. Per run, keep the last `window` calls as `(tool, normalizedArgs)`
 * keys and halt when the same key repeats `max_repeats` times, or a short cycle
 * (A→B→A→B…, up to `max_cycle_len`) repeats `max_repeats` times at the tail of the window.
 */
import { normalizeArgs } from "./normalize.js";

export interface LoopConfig {
  window: number;
  /** identical (tool, args) calls in the window that count as a loop */
  max_repeats: number;
  max_cycle_len: number;
  /** repetitions of a cycle (A→B→A→B…) that count as a loop; defaults to `max_repeats` */
  cycle_repeats?: number;
  ignore_args?: readonly string[];
}

export interface LoopVerdict {
  looping: boolean;
  /** `repeat` (same call N times) or `cycle` (pattern of length L repeated N times) */
  kind?: "repeat" | "cycle";
  repeats?: number;
  cycleLength?: number;
  /** the calls that form the loop, oldest first */
  pattern?: string[];
}

export function loopKey(tool: string, args: unknown, ignore?: readonly string[]): string {
  return `${tool}:${normalizeArgs(args, { ignore })}`;
}

export class LoopDetector {
  private readonly windows = new Map<string, string[]>();

  constructor(private readonly config: LoopConfig) {}

  /** Record a call and return whether it completes a loop. */
  observe(runId: string, tool: string, args: unknown): LoopVerdict {
    const key = loopKey(tool, args, this.config.ignore_args);
    const window = this.windows.get(runId) ?? [];
    window.push(key);
    while (window.length > this.config.window) window.shift();
    this.windows.set(runId, window);
    return detectLoop(window, this.config);
  }

  /** Peek without recording (used after a halt so the halted call is not re-counted). */
  wouldLoop(runId: string, tool: string, args: unknown): LoopVerdict {
    const key = loopKey(tool, args, this.config.ignore_args);
    const window = [...(this.windows.get(runId) ?? []), key].slice(-this.config.window);
    return detectLoop(window, this.config);
  }

  reset(runId: string): void {
    this.windows.delete(runId);
  }

  /** The current window for a run, oldest first. */
  window(runId: string): readonly string[] {
    return this.windows.get(runId) ?? [];
  }

  size(runId: string): number {
    return this.windows.get(runId)?.length ?? 0;
  }
}

export function detectLoop(window: readonly string[], config: LoopConfig): LoopVerdict {
  const last = window[window.length - 1];
  if (last === undefined) return { looping: false };
  let repeats = 0;
  for (const key of window) if (key === last) repeats += 1;
  if (repeats >= config.max_repeats) {
    return { looping: true, kind: "repeat", repeats, cycleLength: 1, pattern: [last] };
  }
  const cycleRepeats = config.cycle_repeats ?? config.max_repeats;
  for (let len = 2; len <= config.max_cycle_len; len += 1) {
    const needed = len * cycleRepeats;
    if (window.length < needed) break;
    const tail = window.slice(-needed);
    const pattern = tail.slice(0, len);
    let ok = true;
    for (let i = len; i < tail.length && ok; i += 1) {
      if (tail[i] !== pattern[i % len]) ok = false;
    }
    if (ok && new Set(pattern).size > 1) {
      return {
        looping: true,
        kind: "cycle",
        repeats: cycleRepeats,
        cycleLength: len,
        pattern,
      };
    }
  }
  return { looping: false };
}

/** Human-readable tool names out of loop keys, for error messages. */
export function describePattern(pattern: readonly string[]): string {
  return pattern.map((k) => k.slice(0, k.indexOf(":"))).join(" → ");
}
