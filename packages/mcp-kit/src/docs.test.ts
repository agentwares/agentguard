import { describe, expect, it } from "vitest";
import { pricingJson, renderLlmsTxt } from "./docs.js";
import { exampleTools } from "./example.js";

describe("renderLlmsTxt", () => {
  it("renders H1, summary, links and the tool list", () => {
    const text = renderLlmsTxt({
      name: "AgentCheck",
      summary: "Uptime and behaviour monitoring for MCP servers.",
      description: "Monitors call your MCP server every 5 minutes and judge nightly.",
      links: [
        { title: "Docs", url: "https://agentcheck.dev/docs", note: "start here" },
        { title: "MCP endpoint", url: "https://agentcheck.dev/mcp" },
      ],
      sections: [
        {
          title: "Optional",
          links: [{ title: "Pricing", url: "https://agentcheck.dev/pricing.json" }],
        },
      ],
      tools: exampleTools,
    });
    expect(
      text.startsWith("# AgentCheck\n\n> Uptime and behaviour monitoring for MCP servers.\n"),
    ).toBe(true);
    expect(text).toContain("- [Docs](https://agentcheck.dev/docs): start here");
    expect(text).toContain("- [MCP endpoint](https://agentcheck.dev/mcp)\n");
    expect(text).toContain("## Optional");
    expect(text).toContain("## MCP tools");
    expect(text).toContain("- `example_add` (a, b): Add two numbers");
    expect(text).toContain("- `example_paid_lookup` (query, sample?): ");
  });
});

describe("pricingJson", () => {
  it("builds the agentwares.pricing/v1 object", () => {
    const json = pricingJson({
      product: "agentcheck",
      currency: "usd",
      tiers: [
        {
          id: "free",
          name: "Free",
          priceUsdMonthly: 0,
          limits: { monitors: 1 },
          features: ["1 monitor"],
        },
        {
          id: "starter",
          name: "Starter",
          priceUsdMonthly: 29,
          limits: { monitors: 10 },
          features: ["10 monitors", "alerts"],
        },
      ],
      meters: [{ eventName: "agentcheck_docs_eval_run", unitPriceUsd: 0.5, unit: "run" }],
      checkoutUrl: "https://agentcheck.dev/checkout",
      updatedAt: "2026-09-01T00:00:00Z",
    });
    expect(json.schema).toBe("agentwares.pricing/v1");
    expect(json.tiers).toHaveLength(2);
    expect(json.meters[0]?.eventName).toBe("agentcheck_docs_eval_run");
    expect(json.updatedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(json.portalUrl).toBeUndefined();
  });

  it("rejects duplicate tiers, bad prices and bad dates", () => {
    const tier = { id: "a", name: "A", priceUsdMonthly: 1, limits: {}, features: [] };
    expect(() =>
      pricingJson({ product: "p", currency: "usd", tiers: [], updatedAt: new Date() }),
    ).toThrow(/at least one tier/);
    expect(() =>
      pricingJson({ product: "p", currency: "usd", tiers: [tier, tier], updatedAt: new Date() }),
    ).toThrow(/duplicate/);
    expect(() =>
      pricingJson({
        product: "p",
        currency: "usd",
        tiers: [{ ...tier, priceUsdMonthly: -1 }],
        updatedAt: new Date(),
      }),
    ).toThrow(/invalid priceUsdMonthly/);
    expect(() =>
      pricingJson({ product: "p", currency: "usd", tiers: [tier], updatedAt: "yesterday" }),
    ).toThrow(/not a date/);
  });
});
