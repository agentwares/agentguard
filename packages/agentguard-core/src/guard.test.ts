import { describe, expect, it } from "vitest";
import { verifyChain } from "./audit.js";
import { Guard, type GuardEvent } from "./guard.js";
import { parsePolicy } from "./policy.js";
import { hashAgentKey, generateAgentKey, resolveAgent, keyFromHeaders } from "./scope.js";

const crmDelete = {
  name: "crm_delete_contact",
  outputSchema: {
    type: "object",
    properties: { deleted: { type: "boolean" }, id: { type: "string" } },
    required: ["deleted", "id"],
  },
};
const crmGet = { name: "crm_get_contact", annotations: { readOnlyHint: true } };
const crmUpdate = { name: "crm_update_contact" };

function makeGuard(
  policy: Parameters<typeof parsePolicy>[0],
  extra: Partial<ConstructorParameters<typeof Guard>[0]> = {},
) {
  const events: GuardEvent[] = [];
  const guard = new Guard({
    policy: parsePolicy(policy),
    env: {},
    onEvent: (e) => void events.push(e),
    sleep: async () => undefined,
    ...extra,
  });
  return { guard, events };
}

describe("Guard", () => {
  it("dry-run fakes writes, forwards reads, records the mutation", async () => {
    const { guard } = makeGuard({ mode: "dry-run" });
    let executed = 0;
    const read = await guard.run({ tool: crmGet, args: { id: "c_1" }, runId: "r1" }, async () => {
      executed += 1;
      return { content: [{ type: "text", text: "{}" }] };
    });
    expect(read.ok).toBe(true);
    expect(read.faked).toBe(false);
    const del = await guard.run(
      { tool: crmDelete, args: { id: "c_1" }, runId: "r1", upstream: "crm" },
      async () => {
        executed += 1;
        return {};
      },
    );
    expect(executed).toBe(1);
    expect(del.faked).toBe(true);
    expect(del.outcome).toBe("faked");
    expect(del.value).toMatchObject({ deleted: true });
    expect(del.entry.mutation).toMatchObject({
      tool: "crm_delete_contact",
      verb: "delete",
      target: "id=c_1",
      upstream: "crm",
    });
    const entries = await guard.audit.read();
    expect(entries).toHaveLength(2);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it("enforce executes writes and charges counters", async () => {
    const { guard } = makeGuard({ mode: "enforce", caps: { per_run: { writes: 2 } } });
    const ok = await guard.run({ tool: crmUpdate, args: { id: 1 }, runId: "r" }, async () => ({
      updated: true,
    }));
    expect(ok).toMatchObject({ ok: true, outcome: "ok", faked: false, value: { updated: true } });
    await guard.run({ tool: crmUpdate, args: { id: 2 }, runId: "r" }, async () => ({}));
    const blocked = await guard.run(
      { tool: crmUpdate, args: { id: 3 }, runId: "r" },
      async () => ({}),
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatchObject({ code: "CAP_EXCEEDED", retryable: false });
    expect(blocked.error?.details).toMatchObject({
      counter: "writes",
      limit: 2,
      used: 2,
      attempted: 3,
    });
    const status = await guard.status("r");
    expect(status.usage.per_run).toMatchObject({ writes: 2, tool_calls: 2 });
  });

  it("caps block the 51st write with remaining budget", async () => {
    const { guard, events } = makeGuard({ mode: "enforce", caps: { per_run: { writes: 50 } } });
    for (let i = 0; i < 50; i += 1) {
      const r = await guard.run({ tool: crmUpdate, args: { id: i }, runId: "r" }, async () => ({}));
      expect(r.ok).toBe(true);
    }
    const r = await guard.run({ tool: crmUpdate, args: { id: 51 }, runId: "r" }, async () => ({}));
    expect(r.error?.code).toBe("CAP_EXCEEDED");
    expect(events.map((e) => e.type)).toEqual(["CAP_EXCEEDED"]);
  });

  it("halts a loop within max_repeats and does not execute the looping call", async () => {
    const { guard, events } = makeGuard({ mode: "enforce", loop: { max_repeats: 3 } });
    let executed = 0;
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(
        await guard.run(
          {
            tool: crmUpdate,
            args: { id: "same", when: new Date(i * 1000).toISOString() },
            runId: "r",
          },
          async () => {
            executed += 1;
            return {};
          },
        ),
      );
    }
    expect(results.slice(0, 2).every((r) => r.ok)).toBe(true);
    expect(results[2]?.error?.code).toBe("LOOP_DETECTED");
    expect(results[2]?.error?.details).toMatchObject({ kind: "repeat", repeats: 3 });
    expect(executed).toBe(2);
    expect(events.filter((e) => e.type === "LOOP_DETECTED").length).toBeGreaterThan(0);
  });

  it("reads use the looser read limit", async () => {
    const { guard } = makeGuard({ mode: "enforce", loop: { max_repeats: 3, max_read_repeats: 5 } });
    for (let i = 0; i < 4; i += 1) {
      expect(
        (await guard.run({ tool: crmGet, args: { id: 1 }, runId: "r" }, async () => ({}))).ok,
      ).toBe(true);
    }
    expect(
      (await guard.run({ tool: crmGet, args: { id: 1 }, runId: "r" }, async () => ({}))).error
        ?.code,
    ).toBe("LOOP_DETECTED");
  });

  it("kill switch halts every call until resumed", async () => {
    const env: Record<string, string | undefined> = {};
    const { guard, events } = makeGuard({ mode: "enforce" }, { env });
    await guard.halt("incident #12");
    const r = await guard.run({ tool: crmGet, args: {}, runId: "r" }, async () => ({}));
    expect(r.error).toMatchObject({ code: "KILLED", retryable: false });
    expect(r.error?.cause).toContain("incident #12");
    expect(events[0]?.type).toBe("KILLED");
    await guard.resume();
    expect((await guard.run({ tool: crmGet, args: {}, runId: "r" }, async () => ({}))).ok).toBe(
      true,
    );
    env.AGENTGUARD_KILL = "1";
    expect(
      (await guard.run({ tool: crmGet, args: {}, runId: "r" }, async () => ({}))).error?.code,
    ).toBe("KILLED");
  });

  it("approval flow: APPROVAL_REQUIRED → approve → identical retry passes once", async () => {
    const { guard, events } = makeGuard({ mode: "enforce", approval: { tools: ["crm_delete_*"] } });
    let executed = 0;
    const exec = async () => {
      executed += 1;
      return { deleted: true };
    };
    const first = await guard.run({ tool: crmDelete, args: { id: "c_9" }, runId: "r" }, exec);
    expect(first.error).toMatchObject({ code: "APPROVAL_REQUIRED", retryable: true });
    const id = (first.error?.details as { approvalId: string }).approvalId;
    expect(first.error?.fix).toContain(`agentguard approve ${id}`);
    expect(executed).toBe(0);
    expect(events.filter((e) => e.type === "APPROVAL_REQUIRED")).toHaveLength(1);
    expect(events[0]?.approval?.id).toBe(id);
    const again = await guard.run({ tool: crmDelete, args: { id: "c_9" }, runId: "r" }, exec);
    expect((again.error?.details as { approvalId: string }).approvalId).toBe(id);
    expect(events.filter((e) => e.type === "APPROVAL_REQUIRED")).toHaveLength(1);
    const different = await guard.run({ tool: crmDelete, args: { id: "c_10" }, runId: "r" }, exec);
    expect((different.error?.details as { approvalId: string }).approvalId).not.toBe(id);
    await guard.decide(id, "approved", "umer");
    const ok = await guard.run({ tool: crmDelete, args: { id: "c_9" }, runId: "r" }, exec);
    expect(ok.ok).toBe(true);
    expect(executed).toBe(1);
    const consumed = await guard.run({ tool: crmDelete, args: { id: "c_9" }, runId: "r" }, exec);
    expect(consumed.error?.code).toBe("APPROVAL_REQUIRED");
    const denyId = (consumed.error?.details as { approvalId: string }).approvalId;
    await guard.decide(denyId, "denied", "umer", "not today");
    const denied = await guard.run({ tool: crmDelete, args: { id: "c_9" }, runId: "r" }, exec);
    expect(denied.error).toMatchObject({ code: "APPROVAL_DENIED", retryable: false });
    expect(executed).toBe(1);
  });

  it("approval wait_s holds the call open until a decision", async () => {
    const { guard } = makeGuard({
      mode: "enforce",
      approval: { tools: ["crm_delete_*"], wait_s: 5 },
    });
    let ticks = 0;
    const g = new Guard({
      policy: guard.policy,
      env: {},
      approvals: guard.approvals,
      sleep: async () => {
        ticks += 1;
        if (ticks === 2) {
          const pending = await guard.approvals.list("pending");
          await g.decide(pending[0]!.id, "approved", "test");
        }
      },
    });
    const r = await g.run({ tool: crmDelete, args: { id: "x" }, runId: "r" }, async () => ({
      deleted: true,
    }));
    expect(r.ok).toBe(true);
    expect(ticks).toBe(2);
  });

  it("scopes: allow/deny and agent allowlists", async () => {
    const { guard } = makeGuard({
      mode: "enforce",
      deny: ["*_drop_*"],
      agents: [{ name: "reader", allow: ["crm_get_*"], upstreams: ["crm"] }],
    });
    const agent = guard.policy.agents[0]!;
    expect(
      (await guard.run({ tool: { name: "db_drop_table" }, args: {}, runId: "r" }, async () => ({})))
        .error?.code,
    ).toBe("TOOL_DENIED");
    expect(
      (
        await guard.run(
          { tool: crmGet, args: {}, runId: "r", agent, upstream: "crm" },
          async () => ({}),
        )
      ).ok,
    ).toBe(true);
    const denied = await guard.run(
      { tool: crmUpdate, args: {}, runId: "r", agent, upstream: "crm" },
      async () => ({}),
    );
    expect(denied.error?.code).toBe("TOOL_DENIED");
    expect(denied.error?.cause).toContain("allowlist");
    expect(
      (
        await guard.run(
          { tool: crmGet, args: {}, runId: "r", agent, upstream: "other" },
          async () => ({}),
        )
      ).error?.cause,
    ).toContain("upstream");
  });

  it("unknown tools are writes in enforce (faked in dry-run) and blockable", async () => {
    const dry = makeGuard({ mode: "dry-run" }).guard;
    expect(
      (await dry.run({ tool: { name: "frobnicate" }, args: {}, runId: "r" }, async () => ({})))
        .faked,
    ).toBe(true);
    const block = makeGuard({ mode: "enforce", classify: { unknown: "block" } }).guard;
    expect(
      (await block.run({ tool: { name: "frobnicate" }, args: {}, runId: "r" }, async () => ({})))
        .error?.code,
    ).toBe("TOOL_DENIED");
  });

  it("spend: estimates from args, charges actuals, blocks over budget", async () => {
    const { guard } = makeGuard({
      mode: "enforce",
      caps: { per_run: { spend_usd: 25 } },
      spend: { tools: { stripe_create_charge: { amount_arg: "amount", divisor: 100 } } },
    });
    const a = await guard.run(
      { tool: { name: "stripe_create_charge" }, args: { amount: 1000 }, runId: "r" },
      async () => ({ structuredContent: { amount_usd: 12 } }),
    );
    expect(a.ok).toBe(true);
    expect(a.entry.usd).toBe(12);
    const b = await guard.run(
      { tool: { name: "stripe_create_charge" }, args: { amount: 1400 }, runId: "r" },
      async () => ({}),
    );
    expect(b.error?.code).toBe("CAP_EXCEEDED");
    expect(b.error?.cause).toContain("$25");
    await expect(guard.spend("r", 20, { label: "llm:gpt-4o" })).rejects.toMatchObject({
      code: "CAP_EXCEEDED",
    });
    await guard.spend("r", 5, { label: "llm:gpt-4o" });
    expect((await guard.status("r")).usage.per_run.spend_usd).toBe(17);
  });

  it("upstream failures become UPSTREAM_ERROR results and error results are recorded", async () => {
    const { guard } = makeGuard({ mode: "enforce" });
    const thrown = await guard.run({ tool: crmGet, args: {}, runId: "r" }, async () => {
      throw new Error("boom");
    });
    expect(thrown.error).toMatchObject({ code: "UPSTREAM_ERROR", cause: "boom", retryable: true });
    const isError = await guard.run({ tool: crmGet, args: {}, runId: "r" }, async () => ({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ code: "NOT_FOUND", cause: "no", fix: "x", retryable: false }),
        },
      ],
    }));
    expect(isError.ok).toBe(false);
    expect(isError.value).toBeDefined();
    expect(isError.entry.outcome).toBe("error");
    expect(isError.error?.code).toBe("NOT_FOUND");
  });

  it("redacts secrets in the audit log", async () => {
    const { guard } = makeGuard({ mode: "enforce" });
    const r = await guard.run(
      { tool: crmGet, args: { api_key: "sk_live_abcdefghijkl", note: "hi" }, runId: "r" },
      async () => ({}),
    );
    expect(r.entry.args).toEqual({ api_key: "<redacted>", note: "hi" });
  });
});

describe("scoped keys", () => {
  it("generates, hashes and resolves keys", async () => {
    const key = generateAgentKey();
    expect(key.startsWith("agk_")).toBe(true);
    const hash = await hashAgentKey(key);
    const policy = parsePolicy({ agents: [{ name: "deployer", key_hash: hash }] });
    expect((await resolveAgent(policy, { key })).agent?.name).toBe("deployer");
    expect((await resolveAgent(policy, { key: "agk_nope" })).error).toBe("UNKNOWN_KEY");
    expect((await resolveAgent(policy, { name: "deployer" })).agent?.name).toBe("deployer");
    expect((await resolveAgent(policy, { name: "x" })).error).toBe("UNKNOWN_AGENT");
    expect(keyFromHeaders(new Headers({ authorization: `Bearer ${key}` }))).toBe(key);
    expect(keyFromHeaders(new Headers({ "x-agentguard-key": key }))).toBe(key);
    expect(keyFromHeaders(new Headers({ authorization: "Bearer upstream-token" }))).toBeUndefined();
  });
});

describe("Guard.spend force", () => {
  it("records post-hoc spend over the cap and alerts instead of throwing", async () => {
    const events: GuardEvent[] = [];
    const guard = new Guard({
      policy: parsePolicy({ caps: { per_run: { spend_usd: 1 } } }),
      env: {},
      onEvent: (e) => void events.push(e),
    });
    const entry = await guard.spend("r", 5, {
      label: "llm:gpt-4o",
      force: true,
      details: { model: "gpt-4o" },
    });
    expect(entry.outcome).toBe("ok");
    expect(entry.reason).toContain("over cap after the fact");
    expect(events.map((e) => e.type)).toEqual(["CAP_EXCEEDED"]);
    expect((await guard.canSpend("r", 0.01)).ok).toBe(false);
  });

  it("stops a run whose dollars are only known from results, once the cap is spent", async () => {
    // The headline claim is a hard spend limit. When a tool reveals its price only in its result
    // there is nothing to estimate before the call, so the cap has to bite on the accumulated
    // total. Before this, every call after the first sailed through at an estimate of $0.
    const charge = { name: "vendor_charge_card" };
    const { guard } = makeGuard({
      mode: "enforce",
      classify: { spend: ["vendor_*"] },
      caps: { per_run: { spend_usd: 20 } },
      loop: { max_repeats: 99 },
    });
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await guard.run(
        { tool: charge, args: { customer: `c_${i}` }, runId: "spend_run" },
        async () => ({ content: [{ type: "text", text: JSON.stringify({ amount_usd: 12 }) }] }),
      );
      outcomes.push(r.ok ? "ok" : (r.error?.code ?? "?"));
    }
    expect(outcomes).toEqual(["ok", "ok", "CAP_EXCEEDED", "CAP_EXCEEDED"]);
    const usage = await guard.caps.usage("spend_run");
    expect(usage.per_run.spend_usd).toBe(24);
  });

  it("reads dollars out of results for a policy with no spend: block", async () => {
    // The object-level default used to override the field defaults with an empty list, which
    // switched result-priced spend off for every policy that did not mention `spend:`.
    const { guard } = makeGuard({ mode: "enforce", classify: { spend: ["vendor_*"] } });
    const r = await guard.run(
      { tool: { name: "vendor_charge_card" }, args: {}, runId: "r" },
      async () => ({ content: [{ type: "text", text: JSON.stringify({ amount_usd: 7.5 }) }] }),
    );
    expect(r.ok).toBe(true);
    expect((await guard.caps.usage("r")).per_run.spend_usd).toBe(7.5);
  });
});
