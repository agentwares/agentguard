import { describe, expect, it } from "vitest";
import { mutationTarget, synthesizeResult } from "./dryrun.js";
import { estimateLlmCost, estimateSpendFromArgs, extractSpendFromResult } from "./spend.js";
import { parsePolicy } from "./policy.js";

describe("synthesizeResult", () => {
  const now = () => new Date("2026-09-02T00:00:00.000Z");
  it("shapes a value from the output schema", () => {
    const value = synthesizeResult({
      tool: "crm_create_contact",
      args: { name: "Ada", email: "ada@example.com" },
      now,
      random: () => "dry_1",
      outputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          created_at: { type: "string", format: "date-time" },
          status: { type: "string", enum: ["active", "archived"] },
          tags: { type: "array", items: { type: "string" } },
          ok: { type: "boolean" },
          count: { type: "integer" },
        },
        required: ["id", "created_at"],
      },
    }) as Record<string, unknown>;
    expect(value).toEqual({
      id: "dry_1",
      name: "Ada",
      created_at: "2026-09-02T00:00:00.000Z",
      status: "active",
      tags: [],
      ok: true,
      count: 1,
    });
  });
  it("falls back to a marked synthetic success", () => {
    const value = synthesizeResult({ tool: "x_delete", random: () => "dry_2" }) as Record<
      string,
      unknown
    >;
    expect(value.dry_run).toBe(true);
    expect(value.id).toBe("dry_2");
  });
  it("finds the record a mutation targets", () => {
    expect(mutationTarget({ contact_id: "c_1", fields: {} })).toBe("contact_id=c_1");
    expect(mutationTarget({ ids: [1, 2, 3] })).toBe("ids=[3 items]");
    expect(mutationTarget({ query: "DROP TABLE users" })).toBe("query=DROP TABLE users");
    expect(mutationTarget("nope")).toBeUndefined();
  });
});

describe("spend", () => {
  const policy = parsePolicy({
    spend: {
      tools: {
        stripe_create_charge: { amount_arg: "amount", divisor: 100, currency_arg: "currency" },
        "openai_*": { fixed_usd: 0.02 },
      },
      models: { "my-model*": { input_per_mtok: 1, output_per_mtok: 2 } },
    },
  });
  it("estimates from arguments", () => {
    expect(
      estimateSpendFromArgs(policy, "stripe_create_charge", { amount: 1999, currency: "usd" })?.usd,
    ).toBe(19.99);
    expect(
      estimateSpendFromArgs(policy, "stripe_create_charge", { amount: 1999, currency: "eur" })?.usd,
    ).toBe(0);
    expect(estimateSpendFromArgs(policy, "openai_complete", {})?.usd).toBe(0.02);
    expect(estimateSpendFromArgs(policy, "crm_get", {})).toBeUndefined();
  });
  it("reads actual spend out of results", () => {
    expect(extractSpendFromResult(policy, { structuredContent: { cost_usd: 1.5 } })).toBe(1.5);
    expect(
      extractSpendFromResult(policy, {
        content: [{ type: "text", text: JSON.stringify({ amount_usd: "2.25" }) }],
      }),
    ).toBe(2.25);
    expect(
      extractSpendFromResult(policy, { content: [{ type: "text", text: "done" }] }),
    ).toBeUndefined();
  });
  it("prices LLM usage with overrides and built-ins", () => {
    expect(
      estimateLlmCost(policy, "my-model-v2", { input_tokens: 1_000_000, output_tokens: 500_000 }),
    ).toBe(2);
    expect(estimateLlmCost(policy, "gpt-4o-mini", { input_tokens: 1_000_000 })).toBe(0.15);
    expect(
      estimateLlmCost(policy, "claude-sonnet-5-20260101", {
        input_tokens: 1000,
        output_tokens: 1000,
        cached_input_tokens: 500,
      }),
    ).toBeCloseTo(0.0111, 4);
    expect(estimateLlmCost(policy, "unknown-model", { input_tokens: 5 })).toBeUndefined();
  });
  it("prices each current model family from its own list price, not a family-wide guess", () => {
    // A tier glob like `claude-opus-4*` used to charge every Opus 4.x at the old $15/$75 rate.
    const perMtok = (model: string): [string, number | undefined, number | undefined] => [
      model,
      estimateLlmCost(policy, model, { input_tokens: 1_000_000 }),
      estimateLlmCost(policy, model, { output_tokens: 1_000_000 }),
    ];
    for (const [model, input, output] of [
      ["claude-opus-5", 5, 25],
      ["claude-opus-4-8", 5, 25],
      ["claude-opus-4-7", 5, 25],
      ["claude-opus-4-6", 5, 25],
      ["claude-fable-5-1", 10, 50],
      ["claude-sonnet-5", 2, 10],
      ["claude-sonnet-4-6", 3, 15],
      ["claude-haiku-4-5", 1, 5],
    ] as const) {
      expect(perMtok(model)).toEqual([model, input, output]);
    }
  });
});
