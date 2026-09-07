/**
 * End-to-end through the real MCP SDK: an SDK client ↔ the proxy's downstream server ↔ the
 * proxy's upstream client ↔ the fake CRM server, all in-process over InMemoryTransport.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  Guard,
  parsePolicy,
  verifyChain,
  type GuardEvent,
  type PolicyInput,
} from "@agentwares/agentguard-core";
import type { LoadedPolicy } from "@agentwares/agentguard-core/node";
import { afterEach, describe, expect, it } from "vitest";
import { createCrmMcpServer, seedState, type CrmState } from "../fixtures/crm-server.js";
import { runDemoAgent } from "../fixtures/demo-agent.js";
import { ProxyRuntime } from "./runtime.js";
import { createDownstreamServer } from "./server.js";

interface Harness {
  client: Client;
  runtime: ProxyRuntime;
  guard: Guard;
  crm: CrmState;
  events: GuardEvent[];
  close(): Promise<void>;
}

const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function harness(
  policyInput: PolicyInput,
  opts: { agentName?: string } = {},
): Promise<Harness> {
  const policy = parsePolicy(policyInput);
  const loaded: LoadedPolicy = {
    policy,
    path: "/tmp/agentguard.yaml",
    baseDir: "/tmp",
    stateDir: "/tmp/.agentguard",
    auditPath: "/tmp/audit.jsonl",
    killPath: "/tmp/KILL",
  };
  const events: GuardEvent[] = [];
  const guard = new Guard({ policy, env: {}, onEvent: (e) => void events.push(e) });
  const crm = seedState();
  const crmServer = createCrmMcpServer(crm);
  const [upClientT, upServerT] = InMemoryTransport.createLinkedPair();
  await crmServer.connect(upServerT);
  const upstreamClient = new Client(
    { name: "agentguard", version: "test" },
    { capabilities: { sampling: {}, elicitation: {} } },
  );
  await upstreamClient.connect(upClientT);
  const agent = opts.agentName ? policy.agents.find((a) => a.name === opts.agentName) : undefined;
  const runtime = new ProxyRuntime({
    loaded,
    guard,
    agent,
    defaultRunId: "run_test",
    log: () => undefined,
    clients: { crm: upstreamClient },
  });
  await runtime.start();
  const server = createDownstreamServer(runtime);
  const [downClientT, downServerT] = InMemoryTransport.createLinkedPair();
  await server.connect(downServerT);
  const client = new Client({ name: "agent", version: "test" });
  await client.connect(downClientT);
  const h: Harness = {
    client,
    runtime,
    guard,
    crm,
    events,
    close: async () => {
      await client.close();
      await server.close();
      await runtime.close();
      await crmServer.close();
    },
  };
  open.push(h);
  return h;
}

const text = (r: CallToolResult): string => r.content.find((c) => c.type === "text")?.text ?? "";
const code = (r: CallToolResult): string | undefined => {
  try {
    return (JSON.parse(text(r)) as { code?: string }).code;
  } catch {
    return undefined;
  }
};

describe("proxy (in-memory)", () => {
  it("lists upstream tools with agentguard metadata", async () => {
    const h = await harness({ mode: "dry-run" });
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("crm_delete_contact");
    expect(names).toContain("crm_list_contacts");
    const del = tools.find((t) => t.name === "crm_delete_contact")!;
    expect(del._meta?.agentguard).toMatchObject({
      upstream: "crm",
      class: "write",
      verb: "delete",
      mode: "dry-run",
    });
    expect(del.annotations?.destructiveHint).toBe(true);
    expect(del.outputSchema).toBeDefined();
  });

  it("dry-run: reads pass through, writes are faked with a schema-shaped result, nothing executes", async () => {
    const h = await harness({ mode: "dry-run" });
    const list = (await h.client.callTool({
      name: "crm_list_contacts",
      arguments: {},
    })) as CallToolResult;
    expect(list.isError).toBeFalsy();
    expect((list.structuredContent as { total: number }).total).toBe(3);
    const del = (await h.client.callTool({
      name: "crm_delete_contact",
      arguments: { id: "c_1" },
    })) as CallToolResult;
    expect(del.isError).toBeFalsy();
    expect(del.structuredContent).toMatchObject({ deleted: true, id: "c_1" });
    expect((del._meta as { agentguard: { dryRun: boolean } }).agentguard.dryRun).toBe(true);
    expect(h.crm.contacts.has("c_1")).toBe(true);
    expect(h.crm.mutations).toHaveLength(0);
    const entries = await h.guard.audit.read();
    expect(entries.map((e) => e.outcome)).toEqual(["ok", "faked"]);
    expect(entries[1]?.mutation).toMatchObject({
      tool: "crm_delete_contact",
      verb: "delete",
      target: "id=c_1",
      upstream: "crm",
    });
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it("enforce: writes execute, upstream errors pass through as structured errors", async () => {
    const h = await harness({ mode: "enforce" });
    const del = (await h.client.callTool({
      name: "crm_delete_contact",
      arguments: { id: "c_1" },
    })) as CallToolResult;
    expect(del.isError).toBeFalsy();
    expect(h.crm.contacts.has("c_1")).toBe(false);
    const missing = (await h.client.callTool({
      name: "crm_get_contact",
      arguments: { id: "nope" },
    })) as CallToolResult;
    expect(missing.isError).toBe(true);
    expect(code(missing)).toBe("NOT_FOUND");
    const fail = (await h.client.callTool({ name: "crm_fail", arguments: {} })) as CallToolResult;
    expect(code(fail)).toBe("UPSTREAM_ERROR");
    const unknown = (await h.client.callTool({
      name: "nope_tool",
      arguments: {},
    })) as CallToolResult;
    expect(unknown.isError).toBe(true);
    expect(code(unknown)).toBe("UNKNOWN_TOOL");
    expect(text(unknown)).toContain("nope_tool");
  });

  it("caps block the 51st write with a structured error and remaining budget", async () => {
    const h = await harness({ mode: "enforce", caps: { per_run: { writes: 50 } } });
    for (let i = 0; i < 50; i += 1) {
      const r = (await h.client.callTool({
        name: "crm_create_contact",
        arguments: { name: `n${i}`, email: `e${i}@x.io` },
      })) as CallToolResult;
      expect(r.isError).toBeFalsy();
    }
    const r = (await h.client.callTool({
      name: "crm_create_contact",
      arguments: { name: "51", email: "51@x.io" },
    })) as CallToolResult;
    expect(r.isError).toBe(true);
    const body = JSON.parse(text(r)) as {
      code: string;
      details: { limit: number; used: number; remaining: Record<string, unknown> };
    };
    expect(body.code).toBe("CAP_EXCEEDED");
    expect(body.details).toMatchObject({ limit: 50, used: 50 });
    expect(h.crm.mutations).toHaveLength(50);
    expect(h.events.map((e) => e.type)).toEqual(["CAP_EXCEEDED"]);
  });

  it("halts a deliberate loop within max_repeats", async () => {
    const h = await harness({ mode: "enforce", loop: { max_repeats: 3 } });
    const codes: (string | undefined)[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = (await h.client.callTool({
        name: "crm_update_contact",
        arguments: { id: "c_1", fields: { name: "Same" } },
      })) as CallToolResult;
      codes.push(r.isError ? code(r) : "ok");
    }
    expect(codes).toEqual(["ok", "ok", "LOOP_DETECTED", "LOOP_DETECTED", "LOOP_DETECTED"]);
    expect(h.crm.mutations.filter((m) => m.tool === "crm_update_contact")).toHaveLength(2);
  });

  it("kill switch halts everything, including resource reads, until resumed", async () => {
    const h = await harness({ mode: "enforce" });
    await h.guard.halt("incident");
    const r = (await h.client.callTool({
      name: "crm_list_contacts",
      arguments: {},
    })) as CallToolResult;
    expect(code(r)).toBe("KILLED");
    await expect(h.client.readResource({ uri: "x://y" })).rejects.toThrow(/kill switch/);
    await h.guard.resume();
    expect(
      ((await h.client.callTool({ name: "crm_list_contacts", arguments: {} })) as CallToolResult)
        .isError,
    ).toBeFalsy();
  });

  it("approval flow through MCP: APPROVAL_REQUIRED, approve, retry executes once", async () => {
    const h = await harness({ mode: "enforce", approval: { tools: ["crm_delete_*"] } });
    const first = (await h.client.callTool({
      name: "crm_delete_contact",
      arguments: { id: "c_2" },
    })) as CallToolResult;
    const body = JSON.parse(text(first)) as {
      code: string;
      retryable: boolean;
      details: { approvalId: string; command: string };
    };
    expect(body.code).toBe("APPROVAL_REQUIRED");
    expect(body.retryable).toBe(true);
    expect(body.details.command).toBe(`agentguard approve ${body.details.approvalId}`);
    expect(h.crm.contacts.has("c_2")).toBe(true);
    await h.guard.decide(body.details.approvalId, "approved", "test");
    const second = (await h.client.callTool({
      name: "crm_delete_contact",
      arguments: { id: "c_2" },
    })) as CallToolResult;
    expect(second.isError).toBeFalsy();
    expect(h.crm.contacts.has("c_2")).toBe(false);
  });

  it("run identity comes from _meta.runId and scopes caps per run", async () => {
    const h = await harness({ mode: "enforce", caps: { per_run: { writes: 1 } } });
    const a1 = (await h.client.callTool({
      name: "crm_create_contact",
      arguments: { name: "a", email: "a@x" },
      _meta: { runId: "A" },
    })) as CallToolResult;
    const a2 = (await h.client.callTool({
      name: "crm_create_contact",
      arguments: { name: "b", email: "b@x" },
      _meta: { runId: "A" },
    })) as CallToolResult;
    const b1 = (await h.client.callTool({
      name: "crm_create_contact",
      arguments: { name: "c", email: "c@x" },
      _meta: { runId: "B" },
    })) as CallToolResult;
    expect([a1.isError, code(a2), b1.isError]).toEqual([undefined, "CAP_EXCEEDED", undefined]);
    const entries = await h.guard.audit.read();
    expect(entries.map((e) => e.run_id)).toEqual(["A", "A", "B"]);
  });

  it("agent scope (stdio --agent) restricts tools and tool listing", async () => {
    const h = await harness(
      { mode: "enforce", agents: [{ name: "reader", allow: ["crm_get_*", "crm_list_*"] }] },
      { agentName: "reader" },
    );
    const r = (await h.client.callTool({
      name: "crm_delete_contact",
      arguments: { id: "c_1" },
    })) as CallToolResult;
    expect(code(r)).toBe("TOOL_DENIED");
    expect(
      (
        (await h.client.callTool({
          name: "crm_get_contact",
          arguments: { id: "c_1" },
        })) as CallToolResult
      ).isError,
    ).toBeFalsy();
  });

  it("the demo agent scenario yields faked writes, a halted loop and a blocked burst", async () => {
    const h = await harness({
      mode: "dry-run",
      caps: { per_run: { writes: 50 } },
      loop: { max_repeats: 3 },
    });
    const steps = await runDemoAgent(h.client, { runId: "demo" });
    const halts = steps.filter((s) => !s.ok).map((s) => s.code);
    expect(halts).toContain("LOOP_DETECTED");
    expect(halts[halts.length - 1]).toBe("CAP_EXCEEDED");
    expect(steps.filter((s) => s.dryRun).length).toBeGreaterThan(5);
    expect(h.crm.mutations).toHaveLength(0);
  });
});
