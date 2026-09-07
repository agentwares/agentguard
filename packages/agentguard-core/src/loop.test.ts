import { describe, expect, it } from "vitest";
import { LoopDetector, detectLoop } from "./loop.js";
import { normalizeArgs } from "./normalize.js";

describe("normalizeArgs", () => {
  it("is stable across key order, whitespace, case and volatile fields", () => {
    const a = normalizeArgs({
      b: 1,
      a: " Hello   World ",
      ts: "2026-09-02T10:00:00Z",
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    const b = normalizeArgs({
      a: "hello world",
      b: 1,
      ts: "2026-09-02T11:30:00Z",
      id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    });
    expect(a).toBe(b);
    expect(normalizeArgs({ x: 1 })).not.toBe(normalizeArgs({ x: 2 }));
    expect(normalizeArgs({ x: 1, nonce: 5 }, { ignore: ["nonce"] })).toBe(
      normalizeArgs({ x: 1, nonce: 9 }, { ignore: ["nonce"] }),
    );
  });
});

describe("LoopDetector", () => {
  const cfg = { window: 30, max_repeats: 3, max_cycle_len: 4 };
  it("halts on the Nth identical call", () => {
    const d = new LoopDetector(cfg);
    expect(d.observe("r", "crm_update_contact", { id: 1 }).looping).toBe(false);
    expect(d.observe("r", "crm_update_contact", { id: 1 }).looping).toBe(false);
    const v = d.observe("r", "crm_update_contact", { id: 1 });
    expect(v).toMatchObject({ looping: true, kind: "repeat", repeats: 3 });
  });
  it("does not halt on different arguments", () => {
    const d = new LoopDetector(cfg);
    for (let i = 0; i < 20; i += 1)
      expect(d.observe("r", "crm_update_contact", { id: i }).looping).toBe(false);
  });
  it("plain repeats win over cycles when both apply", () => {
    const d = new LoopDetector(cfg);
    for (const t of ["a", "b", "a", "b"]) expect(d.observe("r", t, {}).looping).toBe(false);
    expect(d.observe("r", "a", {})).toMatchObject({ looping: true, kind: "repeat", repeats: 3 });
  });
  it("detects A→B→A→B cycles under a looser repeat limit (reads)", () => {
    const d = new LoopDetector({ ...cfg, max_repeats: 10, cycle_repeats: 3 });
    for (const t of ["a", "b", "a", "b", "a"]) expect(d.observe("r", t, {}).looping).toBe(false);
    expect(d.observe("r", "b", {})).toMatchObject({
      looping: true,
      kind: "cycle",
      cycleLength: 2,
      repeats: 3,
    });
  });
  it("detects 3-cycles and respects max_cycle_len", () => {
    const loose = { ...cfg, max_repeats: 10, cycle_repeats: 3 };
    const window = ["a", "b", "c", "a", "b", "c", "a", "b", "c"];
    expect(detectLoop(window, loose)).toMatchObject({
      looping: true,
      kind: "cycle",
      cycleLength: 3,
    });
    expect(detectLoop(window, { ...loose, max_cycle_len: 2 }).looping).toBe(false);
    expect(detectLoop(["a", "b", "c", "a", "b", "c", "a", "b", "d"], loose).looping).toBe(false);
  });
  it("keeps windows per run and forgets old calls", () => {
    const d = new LoopDetector({ window: 4, max_repeats: 3, max_cycle_len: 2 });
    d.observe("r1", "x", {});
    d.observe("r1", "x", {});
    expect(d.observe("r2", "x", {}).looping).toBe(false);
    d.observe("r1", "y", {});
    d.observe("r1", "y", {});
    d.observe("r1", "y", {});
    expect(d.window("r1")).toHaveLength(4);
    expect(d.observe("r1", "x", {}).looping).toBe(false);
  });
});
