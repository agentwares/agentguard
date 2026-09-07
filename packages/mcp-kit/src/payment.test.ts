import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readErrorBody } from "./errors.js";
import { paymentRequiredHttpResponse, withPayment } from "./payment.js";
import { listToolManifest } from "./server.js";
import { createToolContext, defineTool } from "./tool.js";

const base = defineTool({
  name: "test_paid_lookup",
  description: "A paid lookup used to exercise withPayment in the tests.",
  input: z.object({ q: z.string() }),
  output: z.object({ q: z.string(), sample: z.boolean(), userId: z.string().optional() }),
  handler: ({ q }, ctx) => ({ q, sample: ctx.sample === true, userId: ctx.userId }),
});

function bodyText(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected text");
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe("withPayment", () => {
  it("without auth → PAYMENT_REQUIRED body with both rails and comingSoon", async () => {
    const paid = withPayment(base, { priceUsd: 0.05 });
    const result = await paid.invoke({ q: "x" }, createToolContext());
    expect(result.isError).toBe(true);
    expect(result._meta?.httpStatus).toBe(402);
    const body = readErrorBody(result);
    expect(body).toMatchObject({
      code: "PAYMENT_REQUIRED",
      retryable: true,
      priceUsd: 0.05,
      comingSoon: true,
    });
    expect((body?.accepts as { rail: string; amountUsd: string }[]).map((a) => a.rail)).toEqual([
      "x402",
      "mpp",
    ]);
    expect((body?.accepts as { rail: string; amountUsd: string }[])[0]?.amountUsd).toBe("0.05");
    expect(body?.alternatives).toEqual(["api_key_credits", "sample_mode"]);
    expect(body?.details).toEqual({ reason: "no payment header present" });
    expect(bodyText(result).code).toBe("PAYMENT_REQUIRED");
  });

  it("sample: true → handler result at no charge", async () => {
    const paid = withPayment(base, { priceUsd: 0.05 });
    const result = await paid.invoke({ q: "x", sample: true }, createToolContext());
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ q: "x", sample: true });
  });

  it("authorize ok → handler result with userId; not ok → PAYMENT_REQUIRED with the reason", async () => {
    const paid = withPayment(base, {
      priceUsd: 1,
      authorize: (ctx) =>
        ctx.headers.get("authorization") === "Bearer ak_test_1"
          ? { ok: true, userId: "u1" }
          : { ok: false, reason: "unknown API key" },
    });
    const ok = await paid.invoke(
      { q: "x" },
      createToolContext({ headers: new Headers({ authorization: "Bearer ak_test_1" }) }),
    );
    expect(ok.structuredContent).toEqual({ q: "x", sample: false, userId: "u1" });

    const denied = await paid.invoke({ q: "x" }, createToolContext());
    const body = readErrorBody(denied);
    expect(body?.code).toBe("PAYMENT_REQUIRED");
    expect(body?.details).toEqual({ reason: "unknown API key" });
  });

  it("a custom verifier can accept a payment header", async () => {
    const paid = withPayment(base, {
      priceUsd: 0.5,
      live: true,
      verifier: { verify: async (req) => ({ ok: req.headers.get("payment") === "ok" }) },
    });
    const accepted = await paid.invoke(
      { q: "x" },
      createToolContext({ headers: new Headers({ payment: "ok" }) }),
    );
    expect(accepted.structuredContent).toEqual({ q: "x", sample: false });
    const rejected = readErrorBody(await paid.invoke({ q: "x" }, createToolContext()));
    expect(rejected?.comingSoon).toBe(false);
  });

  it("adds an optional boolean sample field to the schema and the description", () => {
    const paid = withPayment(base, { priceUsd: 0.05 });
    const [entry] = listToolManifest([paid]);
    const properties = entry?.inputSchema.properties as Record<
      string,
      { type: string; default?: unknown }
    >;
    expect(properties.sample).toMatchObject({ type: "boolean", default: false });
    expect(entry?.inputSchema.required).toEqual(["q"]);
    expect(paid.description).toContain("$0.05");
    expect(paid.description).toContain("sample=true");
    expect(paid.name).toBe(base.name);
  });

  it("refuses to shadow an existing input field and negative prices", () => {
    const clash = defineTool({
      name: "test_has_sample",
      description: "Has its own sample field so withPayment must complain.",
      input: z.object({ sample: z.string() }),
      handler: () => ({}),
    });
    expect(() => withPayment(clash, { priceUsd: 1 })).toThrow(/already has a field named "sample"/);
    expect(() => withPayment(base, { priceUsd: -1 })).toThrow(/non-negative/);
  });

  it("re-exports the plain HTTP 402 response", async () => {
    const res = paymentRequiredHttpResponse({ resource: "r", priceUsd: 1 });
    expect(res.status).toBe(402);
    expect(res.headers.get("www-authenticate")).toContain("x402 mpp");
  });
});
