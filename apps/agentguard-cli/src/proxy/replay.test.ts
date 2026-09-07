/**
 * Recorded-fixture replay: the fake CRM's responses were captured once into
 * fixtures/recorded/crm-session.json; the proxy runs the demo scenario over that frozen upstream
 * and every decision it makes must match `expected`. Re-record with RECORD_FIXTURES=1.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Guard, parsePolicy, type PolicyInput } from "@agentwares/agentguard-core";
import type { LoadedPolicy } from "@agentwares/agentguard-core/node";
import { createCrmMcpServer, seedState } from "../fixtures/crm-server.js";
import { runDemoAgent, type DemoStep } from "../fixtures/demo-agent.js";
import {
  callKey,
  createReplayServer,
  type RecordedCall,
  type Recording,
} from "../fixtures/replay.js";
import { ProxyRuntime } from "./runtime.js";
import { createDownstreamServer } from "./server.js";

const fixturePath = fileURLToPath(
  new URL("../../fixtures/recorded/crm-session.json", import.meta.url),
);
const RECORD = process.env.RECORD_FIXTURES === "1";

const SCENARIOS: Record<string, PolicyInput> = {
  "enforce-caps-loop": {
    mode: "enforce",
    caps: { per_run: { writes: 50 } },
    loop: { max_repeats: 3 },
  },
  "dry-run": { mode: "dry-run", caps: { per_run: { writes: 50 } }, loop: { max_repeats: 3 } },
  "enforce-approval-deletes": {
    mode: "enforce",
    approval: { tools: ["crm_delete_*"] },
    caps: { per_run: { writes: 50 } },
    loop: { max_repeats: 3 },
  },
};

async function record(): Promise<Recording> {
  const state = seedState();
  const crm = createCrmMcpServer(state);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await crm.connect(st);
  const client = new Client({ name: "recorder", version: "0" });
  await client.connect(ct);
  const { tools } = await client.listTools();
  const calls: RecordedCall[] = [];
  const seen = new Set<string>();
  const recorder = new Client({ name: "recorder-agent", version: "0" });
  // Capture every distinct (tool, args) the demo agent produces, answered by the real fake CRM.
  const capture = {
    callTool: async (params: {
      name: string;
      arguments?: Record<string, unknown>;
      _meta?: unknown;
    }) => {
      const key = callKey(params.name, params.arguments ?? {});
      const result = (await client.callTool({
        name: params.name,
        arguments: params.arguments,
      })) as CallToolResult;
      if (!seen.has(key)) {
        seen.add(key);
        calls.push({ tool: params.name, args: params.arguments ?? {}, result });
      }
      return result;
    },
  } as unknown as Client;
  await runDemoAgent(capture, { loop: 5, burst: 60 });
  await recorder.close().catch(() => undefined);
  await client.close();
  await crm.close();
  return { recordedAt: new Date().toISOString(), upstream: "crm", tools, calls, expected: {} };
}

async function runScenario(
  recording: Recording,
  policyInput: PolicyInput,
): Promise<{ steps: DemoStep[]; outcomes: string[]; mutations: string[] }> {
  const policy = parsePolicy(policyInput);
  const loaded: LoadedPolicy = {
    policy,
    path: "",
    baseDir: "",
    stateDir: "",
    auditPath: "",
    killPath: "",
  };
  const guard = new Guard({ policy, env: {} });
  const replay = createReplayServer(recording);
  const [uc, us] = InMemoryTransport.createLinkedPair();
  await replay.connect(us);
  const upstream = new Client(
    { name: "agentguard", version: "0" },
    { capabilities: { sampling: {}, elicitation: {} } },
  );
  await upstream.connect(uc);
  const runtime = new ProxyRuntime({
    loaded,
    guard,
    defaultRunId: "replay",
    log: () => undefined,
    clients: { crm: upstream },
  });
  await runtime.start();
  const server = createDownstreamServer(runtime);
  const [dc, ds] = InMemoryTransport.createLinkedPair();
  await server.connect(ds);
  const client = new Client({ name: "agent", version: "0" });
  await client.connect(dc);
  const steps = await runDemoAgent(client, { loop: 5, burst: 60 });
  const entries = await guard.audit.read();
  await client.close();
  await server.close();
  await runtime.close();
  await replay.close();
  return {
    steps,
    outcomes: entries.map((e) => `${e.tool}:${e.outcome}${e.error ? `:${e.error.code}` : ""}`),
    mutations: entries
      .filter((e) => e.outcome === "faked")
      .map((e) => `${e.mutation?.verb} ${e.mutation?.target ?? ""}`.trim()),
  };
}

describe("recorded-fixture replay", () => {
  it("agentguard's decisions over the frozen CRM recording match the fixture", async () => {
    let recording: Recording;
    if (RECORD || !existsSync(fixturePath)) {
      recording = await record();
      for (const [name, policy] of Object.entries(SCENARIOS)) {
        const { outcomes, mutations, steps } = await runScenario(recording, policy);
        recording.expected[name] = {
          outcomes,
          mutations,
          halts: steps.filter((s) => !s.ok).map((s) => s.code),
        };
      }
      writeFileSync(fixturePath, JSON.stringify(recording, null, 2) + "\n");
    }
    recording = JSON.parse(readFileSync(fixturePath, "utf8")) as Recording;
    expect(recording.tools.length).toBeGreaterThan(5);
    expect(recording.calls.length).toBeGreaterThan(10);
    for (const [name, policy] of Object.entries(SCENARIOS)) {
      const { outcomes, mutations, steps } = await runScenario(recording, policy);
      const expected = recording.expected[name] as {
        outcomes: string[];
        mutations: string[];
        halts: string[];
      };
      expect(outcomes, name).toEqual(expected.outcomes);
      expect(mutations, name).toEqual(expected.mutations);
      expect(
        steps.filter((s) => !s.ok).map((s) => s.code),
        name,
      ).toEqual(expected.halts);
    }
    const enforce = recording.expected["enforce-caps-loop"] as { outcomes: string[] };
    expect(enforce.outcomes.filter((o) => o.endsWith("LOOP_DETECTED")).length).toBeGreaterThan(0);
    expect(enforce.outcomes[enforce.outcomes.length - 1]).toMatch(/CAP_EXCEEDED$/);
    // `caps.per_run.writes: 50` lets exactly 50 write-class calls through; the 51st is blocked.
    const writeOks = enforce.outcomes.filter(
      (o) => o.endsWith(":ok") && !/^crm_(list|get)_/.test(o),
    );
    expect(writeOks).toHaveLength(50);
    expect(enforce.outcomes.filter((o) => o.endsWith(":blocked:CAP_EXCEEDED"))).toEqual([
      "crm_create_contact:blocked:CAP_EXCEEDED",
    ]);
  });
});
