import { describe, expect, it } from "vitest";
import { CapsEngine } from "./caps.js";
import { MemoryStateStore } from "./state.js";

describe("CapsEngine", () => {
  const caps = { per_run: { writes: 50, spend_usd: 25 }, per_day: { spend_usd: 200 } };
  it("blocks the 51st write", async () => {
    const engine = new CapsEngine(new MemoryStateStore());
    for (let i = 0; i < 50; i += 1) {
      const check = await engine.check("run", caps, { writes: 1 });
      expect(check.ok).toBe(true);
      await engine.charge("run", { writes: 1, tool_calls: 1 });
    }
    const check = await engine.check("run", caps, { writes: 1 });
    expect(check.ok).toBe(false);
    expect(check.exceeded).toEqual({
      scope: "per_run",
      counter: "writes",
      limit: 50,
      used: 50,
      attempted: 51,
    });
    expect(check.remaining.writes?.per_run).toBe(0);
    expect((await engine.check("run", caps, { tool_calls: 1 })).ok).toBe(true);
  });
  it("tracks dollars per run and per day across runs", async () => {
    const engine = new CapsEngine(new MemoryStateStore());
    await engine.charge("r1", { spend_usd: 20 });
    expect((await engine.check("r1", caps, { spend_usd: 6 })).exceeded?.counter).toBe("spend_usd");
    expect((await engine.check("r2", caps, { spend_usd: 24 })).ok).toBe(true);
    for (let i = 0; i < 8; i += 1) await engine.charge(`r${i + 2}`, { spend_usd: 22 });
    const day = await engine.check("r99", caps, { spend_usd: 10 });
    expect(day.ok).toBe(false);
    expect(day.exceeded?.scope).toBe("per_day");
  });
  it("keeps per-agent day counters separate and rolls the day", async () => {
    let now = new Date("2026-09-02T10:00:00Z");
    const engine = new CapsEngine(new MemoryStateStore(), () => now);
    await engine.charge("r", { writes: 3 }, "alice");
    expect((await engine.usage("r", "alice")).per_day.writes).toBe(3);
    expect((await engine.usage("r", "bob")).per_day.writes).toBeUndefined();
    expect((await engine.usage("r")).per_day.writes).toBe(3);
    now = new Date("2026-09-03T00:00:01Z");
    expect((await engine.usage("r", "alice")).per_day.writes).toBeUndefined();
  });
  it("refuses a call whose counter is already over the limit, even with no estimate of its own", async () => {
    // Result-priced spend lands after the call, so the next call has nothing to estimate. It must
    // still be refused; before this, a $0 estimate skipped the check and the cap never fired.
    const engine = new CapsEngine(new MemoryStateStore());
    await engine.charge("r", { spend_usd: 60 });
    const blown = await engine.check("r", caps, { spend_usd: 0 });
    expect(blown.ok).toBe(false);
    expect(blown.exceeded).toMatchObject({
      counter: "spend_usd",
      limit: 25,
      used: 60,
      attempted: 60,
    });
    // a counter the call does not touch is still ignored: a read is not blocked by a spent budget
    expect((await engine.check("r", caps, { tool_calls: 1 })).ok).toBe(true);
  });
});
