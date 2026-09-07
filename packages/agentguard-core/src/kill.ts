/**
 * Kill switch: any source says "halt" → every call returns `KILLED` until it is cleared.
 * Sources are composed: an in-memory flag (HTTP `/kill`, SDK `guard.kill()`), an environment
 * variable, and a file (`.agentguard/KILL`, written by `agentguard kill`).
 */

export interface KillState {
  killed: boolean;
  /** who/what pulled it, for the error message and the audit log */
  reason?: string;
  source?: string;
  at?: string;
}

export interface KillSwitch {
  check(): Promise<KillState> | KillState;
  kill(reason?: string): Promise<void> | void;
  resume(): Promise<void> | void;
}

export class MemoryKillSwitch implements KillSwitch {
  private state: KillState = { killed: false };
  check(): KillState {
    return this.state;
  }
  kill(reason = "killed via API"): void {
    this.state = { killed: true, reason, source: "memory", at: new Date().toISOString() };
  }
  resume(): void {
    this.state = { killed: false };
  }
}

export class EnvKillSwitch implements KillSwitch {
  constructor(
    private readonly name: string,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}
  check(): KillState {
    const v = this.env[this.name];
    if (v && v !== "0" && v.toLowerCase() !== "false") {
      return { killed: true, reason: `${this.name}=${v}`, source: "env" };
    }
    return { killed: false };
  }
  kill(): void {
    this.env[this.name] = "1";
  }
  resume(): void {
    delete this.env[this.name];
  }
}

/** First source that says killed wins; `kill()`/`resume()` fan out to every source. */
export class CompositeKillSwitch implements KillSwitch {
  constructor(private readonly sources: KillSwitch[]) {}
  async check(): Promise<KillState> {
    for (const s of this.sources) {
      const state = await s.check();
      if (state.killed) return state;
    }
    return { killed: false };
  }
  async kill(reason?: string): Promise<void> {
    for (const s of this.sources) await s.kill(reason);
  }
  async resume(): Promise<void> {
    for (const s of this.sources) await s.resume();
  }
}
