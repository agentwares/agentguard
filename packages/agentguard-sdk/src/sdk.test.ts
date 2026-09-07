import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GuardError, type GuardEvent } from "@agentwares/agentguard-core";
import { readAuditFile, verifyAuditFile } from "@agentwares/agentguard-core/node";
import { createGuard } from "./guard.js";
import { createGuardedFetch, normalizeUsage, usageFromSse } from "./fetch.js";
import { wrapOpenAIAgentsTools } from "./adapters/openai-agents.js";
import { wrapLangChainTool } from "./adapters/langchain.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("createGuard + wrap", () => {
  it("dry-run fakes writes and passes reads for plain functions", async () => {
    const ag = await createGuard({ policy: { mode: "dry-run" }, env: {} });
    const executed: string[] = [];
    const tools = ag.wrapAll({
      crm_get_contact: async ({ id }: { id: string }) => {
        executed.push("get");
        return { id, name: "Ada" };
      },
      crm_delete_contact: async ({ id }: { id: string }) => {
        executed.push("delete");
        return { deleted: true, id };
      },
    });
    expect(await tools.crm_get_contact({ id: "c_1" })).toEqual({ id: "c_1", name: "Ada" });
    const faked = (await tools.crm_delete_contact({ id: "c_1" })) as Record<string, unknown>;
    expect(faked.dry_run).toBe(true);
    expect(executed).toEqual(["get"]);
    const report = await ag.report();
    expect(report.wouldHave.deletes).toBe(1);
    expect(await ag.reportMarkdown()).toContain("**deleted 1 record**");
  });

  it("enforce: caps, loops and kill throw GuardError (or return the body)", async () => {
    const events: GuardEvent[] = [];
    const ag = await createGuard({
      policy: { mode: "enforce", caps: { per_run: { writes: 2 } }, loop: { max_repeats: 2 } },
      env: {},
      onEvent: (e) => void events.push(e),
    });
    const update = ag.wrap(async ({ id }: { id: number }) => ({ id }), {
      name: "crm_update_contact",
    });
    await update({ id: 1 });
    await expect(update({ id: 1 })).rejects.toMatchObject({ code: "LOOP_DETECTED" });
    await update({ id: 2 });
    await expect(update({ id: 3 })).rejects.toBeInstanceOf(GuardError);
    const soft = ag.wrap(async ({ id }: { id: number }) => ({ id }), {
      name: "crm_update_contact",
      onBlock: "return",
    });
    expect(await soft({ id: 9 })).toMatchObject({ code: "CAP_EXCEEDED" });
    await ag.halt("stop");
    await expect(update({ id: 4 })).rejects.toMatchObject({ code: "KILLED" });
    await ag.resume();
    ag.newRun("second");
    expect(await update({ id: 4 })).toEqual({ id: 4 });
    expect(events.map((e) => e.type)).toEqual([
      "LOOP_DETECTED",
      "CAP_EXCEEDED",
      "CAP_EXCEEDED",
      "KILLED",
    ]);
  });

  it("approval round-trip through the SDK", async () => {
    const ag = await createGuard({
      policy: { mode: "enforce", approval: { tools: ["*_delete_*"] } },
      env: {},
    });
    const del = ag.wrap(async ({ id }: { id: string }) => ({ deleted: id }), {
      name: "crm_delete_contact",
      onBlock: "return",
    });
    const first = (await del({ id: "c_1" })) as { code: string; details: { approvalId: string } };
    expect(first.code).toBe("APPROVAL_REQUIRED");
    expect((await ag.pendingApprovals()).map((a) => a.id)).toEqual([first.details.approvalId]);
    await ag.approve(first.details.approvalId, "umer");
    expect(await del({ id: "c_1" })).toEqual({ deleted: "c_1" });
  });

  it("file-backed: shares state, audit and kill file with the CLI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentguard-sdk-"));
    dirs.push(dir);
    const policyPath = join(dir, "agentguard.yaml");
    writeFileSync(
      policyPath,
      "mode: enforce\ncaps:\n  per_run: { writes: 1 }\nagents:\n  - name: bot\n    deny: [crm_delete_*]\n",
    );
    const ag = await createGuard({ policy: policyPath, agent: "bot", runId: "r1", env: {} });
    const create = ag.wrap(async (a: { name: string }) => a, {
      name: "crm_create_contact",
      onBlock: "return",
    });
    expect(await create({ name: "x" })).toEqual({ name: "x" });
    expect(await create({ name: "y" })).toMatchObject({ code: "CAP_EXCEEDED" });
    const del = ag.wrap(async (a: { id: string }) => a, {
      name: "crm_delete_contact",
      onBlock: "return",
    });
    expect(await del({ id: "1" })).toMatchObject({ code: "TOOL_DENIED" });
    const entries = readAuditFile(join(dir, ".agentguard", "audit.jsonl"));
    expect(entries.map((e) => e.outcome)).toEqual(["ok", "blocked", "blocked"]);
    expect(entries[0]?.agent).toBe("bot");
    expect((await verifyAuditFile(join(dir, ".agentguard", "audit.jsonl"))).ok).toBe(true);
    await ag.halt("sdk kill");
    expect(existsSync(join(dir, ".agentguard", "KILL"))).toBe(true);
    const again = await createGuard({ policy: policyPath, runId: "r2", env: {} });
    expect(
      await again.wrap(async () => 1, { name: "crm_get_x", onBlock: "return" })({}),
    ).toMatchObject({ code: "KILLED" });
    await expect(createGuard({ policy: policyPath, agent: "nope", env: {} })).rejects.toMatchObject(
      { code: "INVALID_POLICY" },
    );
  });
});

describe("adapters", () => {
  it("OpenAI Agents SDK tools: blocked calls return the error JSON, faked calls return JSON strings", async () => {
    const ag = await createGuard({
      policy: { mode: "enforce", caps: { per_run: { deletes: 1 } } },
      env: {},
    });
    let invoked = 0;
    const tool = {
      type: "function",
      name: "crm_delete_contact",
      description: "delete",
      parameters: { type: "object" },
      invoke: async (_ctx: unknown, input: string) => {
        invoked += 1;
        return `deleted ${(JSON.parse(input) as { id: string }).id}`;
      },
    };
    const [wrapped] = wrapOpenAIAgentsTools(ag, [tool]);
    expect(wrapped!.type).toBe("function");
    expect(await wrapped!.invoke({}, JSON.stringify({ id: "c_1" }))).toBe("deleted c_1");
    const blocked = JSON.parse(
      (await wrapped!.invoke({}, JSON.stringify({ id: "c_2" }))) as string,
    ) as { code: string; fix: string };
    expect(blocked.code).toBe("CAP_EXCEEDED");
    expect(blocked.fix).toContain("stop");
    expect(invoked).toBe(1);
    const dry = await createGuard({ policy: { mode: "dry-run" }, env: {} });
    const [dryTool] = wrapOpenAIAgentsTools(dry, [tool]);
    const out = JSON.parse(
      (await dryTool!.invoke({}, JSON.stringify({ id: "c_3" }))) as string,
    ) as { dry_run: boolean };
    expect(out.dry_run).toBe(true);
    expect(invoked).toBe(1);
  });

  it("LangChain tools: _call is intercepted, prototype is preserved, invoke still works", async () => {
    class FakeStructuredTool {
      name = "crm_send_email";
      description = "send";
      calls = 0;
      async invoke(input: unknown): Promise<unknown> {
        return this._call(input);
      }
      async _call(input: unknown): Promise<string> {
        this.calls += 1;
        return `sent to ${(input as { to: string }).to}`;
      }
    }
    const ag = await createGuard({
      policy: { mode: "enforce", caps: { per_run: { emails: 1 } } },
      env: {},
    });
    const tool = new FakeStructuredTool();
    const wrapped = wrapLangChainTool(ag, tool);
    expect(wrapped).toBeInstanceOf(FakeStructuredTool);
    expect(await wrapped.invoke({ to: "a@b.c" })).toBe("sent to a@b.c");
    const blocked = JSON.parse((await wrapped.invoke({ to: "d@e.f" })) as string) as {
      code: string;
    };
    expect(blocked.code).toBe("CAP_EXCEEDED");
    expect(tool.calls).toBe(1);
    const throwing = wrapLangChainTool(ag, new FakeStructuredTool(), { onBlock: "throw" });
    await expect(throwing.invoke({ to: "x@y.z" })).rejects.toMatchObject({ code: "CAP_EXCEEDED" });
    expect(() => wrapLangChainTool(ag, { name: "nope" })).toThrow(/cannot wrap/);
  });
});

describe("guarded fetch", () => {
  const openaiUsage = {
    prompt_tokens: 1_000_000,
    completion_tokens: 100_000,
    prompt_tokens_details: { cached_tokens: 0 },
  };
  function fakeFetch(
    handler: (url: URL, init?: RequestInit) => Response,
  ): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
    return async (input, init) =>
      handler(new URL(input instanceof Request ? input.url : String(input)), init);
  }

  it("charges non-streamed OpenAI usage and blocks once the budget is gone", async () => {
    const ag = await createGuard({
      policy: { mode: "enforce", caps: { per_run: { spend_usd: 3 } } },
      env: {},
    });
    let calls = 0;
    const fetch = createGuardedFetch(ag, {
      fetch: fakeFetch(() => {
        calls += 1;
        return new Response(
          JSON.stringify({ id: "chatcmpl", model: "gpt-4o-mini-2026", usage: openaiUsage }),
          { headers: { "Content-Type": "application/json" } },
        );
      }),
    });
    const body = JSON.stringify({ model: "gpt-4o-mini", messages: [] });
    const res = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe("chatcmpl");
    // 1M input @ $0.15 + 100K output @ $0.60/M = 0.21
    expect((await ag.status()).usage.per_run.spend_usd).toBeCloseTo(0.21, 6);
    for (let i = 0; i < 14; i += 1)
      await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body });
    expect((await ag.status()).usage.per_run.spend_usd).toBeCloseTo(3.15, 6);
    const blocked = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body,
    });
    expect(blocked.status).toBe(402);
    expect(((await blocked.json()) as { code: string }).code).toBe("CAP_EXCEEDED");
    expect(calls).toBe(15);
    const other = await fetch("https://example.com/", { method: "GET" });
    expect(other.status).toBe(200);
    const entries = await ag.audit();
    expect(entries[0]).toMatchObject({ tool: "llm:gpt-4o-mini-2026", class: "spend", usd: 0.21 });
    expect(entries.at(-1)?.reason).toContain("over cap after the fact");
  });

  it("records a model with no list price at $0 and says so, instead of dropping the call", async () => {
    const ag = await createGuard({
      policy: { mode: "enforce", caps: { per_run: { spend_usd: 3 } } },
      env: {},
    });
    const seen: (number | undefined)[] = [];
    const fetch = createGuardedFetch(ag, {
      onSpend: (i) => seen.push(i.usd),
      fetch: fakeFetch(
        () =>
          new Response(
            JSON.stringify({ id: "chatcmpl", model: "some-unreleased-model", usage: openaiUsage }),
            { headers: { "Content-Type": "application/json" } },
          ),
      ),
    });
    await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "some-unreleased-model", messages: [] }),
    });
    expect(seen).toEqual([undefined]);
    expect((await ag.status()).usage.per_run.spend_usd ?? 0).toBe(0);
    const entry = (await ag.audit()).at(-1);
    expect(entry).toMatchObject({ tool: "llm:some-unreleased-model", usd: 0 });
    expect(entry?.reason).toContain("no list price");
  });

  it("parses streamed Anthropic usage and asks OpenAI streams for usage", async () => {
    const ag = await createGuard({ policy: { mode: "enforce" }, env: {} });
    const seen: { model: string; usd: number | undefined }[] = [];
    let forwardedBody: string | undefined;
    const sse = [
      'data: {"type":"message_start","message":{"model":"claude-sonnet-5-20260101","usage":{"input_tokens":1000000,"output_tokens":1}}}',
      'data: {"type":"content_block_delta","delta":{"text":"hi"}}',
      'data: {"type":"message_delta","usage":{"output_tokens":100000}}',
      "",
    ].join("\n\n");
    const fetch = createGuardedFetch(ag, {
      fetch: fakeFetch((url, init) => {
        forwardedBody = typeof init?.body === "string" ? init.body : undefined;
        if (url.host === "api.anthropic.com")
          return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
        return new Response(
          'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n',
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }),
      onSpend: (i) => void seen.push({ model: i.model, usd: i.usd }),
    });
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-5-20260101", stream: true }),
    });
    expect(await res.text()).toContain("content_block_delta");
    // 1M input @ $2 + 100K output @ $10/M = 3.0
    expect(seen[0]).toEqual({ model: "claude-sonnet-5-20260101", usd: 3 });
    await (
      await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4o", stream: true }),
      })
    ).text();
    expect(JSON.parse(forwardedBody!)).toMatchObject({ stream_options: { include_usage: true } });
    expect(seen[1]?.model).toBe("gpt-4o");
    expect((await ag.status()).usage.per_run.spend_usd).toBeCloseTo(3.000075, 6);
  });

  it("normalizes usage shapes", () => {
    expect(
      normalizeUsage("openai", {
        input_tokens: 5,
        output_tokens: 2,
        input_tokens_details: { cached_tokens: 1 },
      }),
    ).toEqual({ input_tokens: 5, output_tokens: 2, cached_input_tokens: 1 });
    expect(
      normalizeUsage("anthropic", {
        input_tokens: 5,
        output_tokens: 2,
        cache_read_input_tokens: 3,
      }),
    ).toEqual({ input_tokens: 8, output_tokens: 2, cached_input_tokens: 3 });
    expect(
      normalizeUsage("gemini", {
        promptTokenCount: 5,
        candidatesTokenCount: 2,
        thoughtsTokenCount: 1,
      }),
    ).toEqual({ input_tokens: 5, output_tokens: 3, cached_input_tokens: 0 });
    expect(
      usageFromSse("openai", 'data: {"response":{"usage":{"input_tokens":1,"output_tokens":2}}}\n'),
    ).toEqual({ input_tokens: 1, output_tokens: 2, cached_input_tokens: 0 });
    expect(normalizeUsage("openai", {})).toBeUndefined();
  });

  it("KILLED answers 403 without calling the provider", async () => {
    const ag = await createGuard({ policy: { mode: "enforce" }, env: {} });
    await ag.halt("incident");
    let called = false;
    const fetch = createGuardedFetch(ag, {
      fetch: fakeFetch(() => {
        called = true;
        return new Response("{}");
      }),
    });
    const res = await fetch("https://api.openai.com/v1/responses", { method: "POST", body: "{}" });
    expect(res.status).toBe(403);
    expect(res.headers.get("X-Agentguard")).toBe("KILLED");
    expect(called).toBe(false);
  });
});
