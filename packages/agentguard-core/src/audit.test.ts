import { describe, expect, it } from "vitest";
import {
  GENESIS_HASH,
  MemoryAuditSink,
  parseAuditJsonl,
  verifyChain,
  type AuditEntryInput,
} from "./audit.js";

const input = (tool: string): AuditEntryInput => ({
  ts: "2026-09-02T00:00:00Z",
  run_id: "r",
  tool,
  class: "write",
  verb: "update",
  mode: "enforce",
  outcome: "ok",
  args_hash: "abc",
});

describe("audit chain", () => {
  it("links entries and verifies", async () => {
    const sink = new MemoryAuditSink();
    const a = await sink.append(input("a"));
    const b = await sink.append(input("b"));
    expect(a.seq).toBe(1);
    expect(a.prev_hash).toBe(GENESIS_HASH);
    expect(b.prev_hash).toBe(a.hash);
    expect(await verifyChain(sink.entries)).toMatchObject({ ok: true, entries: 2, head: b.hash });
  });
  it("detects edits, removals and reordering", async () => {
    const sink = new MemoryAuditSink();
    await Promise.all([sink.append(input("a")), sink.append(input("b")), sink.append(input("c"))]);
    const edited = sink.entries.map((e) => ({ ...e }));
    edited[1]!.tool = "evil";
    expect(await verifyChain(edited)).toMatchObject({ ok: false, brokenAt: 2 });
    const removed = [sink.entries[0]!, sink.entries[2]!];
    expect(await verifyChain(removed)).toMatchObject({ ok: false, brokenAt: 3 });
    const swapped = [sink.entries[1]!, sink.entries[0]!, sink.entries[2]!];
    expect((await verifyChain(swapped)).ok).toBe(false);
    const roundTrip = parseAuditJsonl(
      sink.entries.map((e) => JSON.stringify(e)).join("\n") + "\n\n",
    );
    expect((await verifyChain(roundTrip)).ok).toBe(true);
    expect(() => parseAuditJsonl("{bad")).toThrowError(/line 1/);
  });
});
