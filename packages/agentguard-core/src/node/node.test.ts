import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Guard } from "../guard.js";
import {
  FileApprovalStore,
  FileAuditSink,
  FileKillSwitch,
  FileStateStore,
  loadPolicyFile,
  readAuditFile,
  verifyAuditFile,
} from "./index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentguard-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("node stores", () => {
  it("state store persists and updates under a lock", async () => {
    const store = new FileStateStore(dir);
    await store.update<number>("n", (c) => (c ?? 0) + 1);
    await Promise.all([
      store.update<number>("n", (c) => (c ?? 0) + 1),
      store.update<number>("n", (c) => (c ?? 0) + 1),
    ]);
    expect(await store.get("n")).toBe(3);
    expect(await new FileStateStore(dir).get("n")).toBe(3);
    expect(await store.keys("n")).toEqual(["n"]);
    await store.delete("n");
    expect(await store.get("n")).toBeUndefined();
  });

  it("audit sink continues the chain across processes and verifies from disk", async () => {
    const path = join(dir, "audit.jsonl");
    const a = new FileAuditSink(path);
    const base = {
      ts: "t",
      run_id: "r",
      tool: "x",
      class: "read" as const,
      verb: "read" as const,
      mode: "enforce" as const,
      outcome: "ok" as const,
      args_hash: "h",
    };
    await a.append(base);
    const b = new FileAuditSink(path);
    await b.append(base);
    await a.append(base); // a must notice b's write and resync
    const entries = readAuditFile(path);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(await verifyAuditFile(path)).toMatchObject({ ok: true, entries: 3 });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    lines[1] = lines[1]!.replace('"tool":"x"', '"tool":"y"');
    writeFileSync(path, lines.join("\n") + "\n");
    expect(await verifyAuditFile(path)).toMatchObject({ ok: false, brokenAt: 2 });
    expect(await verifyAuditFile(join(dir, "missing.jsonl"))).toMatchObject({
      ok: true,
      entries: 0,
    });
  });

  it("kill file halts a guard and `resume` clears it", async () => {
    const kill = new FileKillSwitch(join(dir, "KILL"));
    const guard = new Guard({
      policy: loadPolicyFile(writePolicy("mode: enforce\n")).policy,
      kill,
      env: {},
    });
    expect(
      (await guard.run({ tool: { name: "get_x" }, args: {}, runId: "r" }, async () => 1)).ok,
    ).toBe(true);
    kill.kill("stop everything");
    const r = await guard.run({ tool: { name: "get_x" }, args: {}, runId: "r" }, async () => 1);
    expect(r.error?.code).toBe("KILLED");
    expect(r.error?.cause).toContain("stop everything");
    // the reason stays one line — the file's second line is the timestamp, not part of it
    expect(kill.check().reason).toBe("stop everything");
    kill.resume();
    expect(
      (await guard.run({ tool: { name: "get_x" }, args: {}, runId: "r" }, async () => 1)).ok,
    ).toBe(true);
  });

  it("approvals persist to disk", async () => {
    const store = new FileApprovalStore(dir);
    const rec = {
      id: "apr_1",
      status: "pending" as const,
      tool: "t",
      args_hash: "h",
      args: {},
      run_id: "r",
      created_at: "2026-01-01T00:00:00Z",
      expires_at: "2999-01-01T00:00:00Z",
    };
    await store.create(rec);
    expect((await new FileApprovalStore(dir).findByCall("t", "h"))?.id).toBe("apr_1");
    await store.update("apr_1", { status: "approved" });
    expect((await store.list("approved")).length).toBe(1);
    await expect(store.get("../etc")).rejects.toThrow();
  });

  it("loadPolicyFile resolves paths relative to the file", () => {
    const loaded = loadPolicyFile(
      writePolicy("state:\n  dir: .ag\naudit:\n  path: logs/a.jsonl\n"),
    );
    expect(loaded.stateDir).toBe(join(dir, ".ag"));
    expect(loaded.auditPath).toBe(join(dir, "logs/a.jsonl"));
    expect(loaded.killPath).toBe(join(dir, ".agentguard/KILL"));
    expect(() => loadPolicyFile(join(dir, "nope.yaml"))).toThrowError(/agentguard init/);
  });
});

function writePolicy(text: string): string {
  const p = join(dir, "agentguard.yaml");
  writeFileSync(p, text);
  return p;
}
