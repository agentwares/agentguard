import { describe, expect, it } from "vitest";
import {
  StubVerifier,
  X402_HEADER,
  buildPaymentRequired,
  paymentRequiredResponse,
} from "./index.js";

describe("x402 stub", () => {
  it("builds a 402 with both rails and structured error fields", () => {
    const r = buildPaymentRequired({ resource: "re_deal_memo", priceUsd: 0.75 });
    expect(r.status).toBe(402);
    expect(r.body.code).toBe("PAYMENT_REQUIRED");
    expect(r.body.retryable).toBe(true);
    expect(r.body.comingSoon).toBe(true);
    expect(r.body.accepts.map((a) => a.rail)).toEqual(["x402", "mpp"]);
    expect(r.body.accepts[0]?.amountUsd).toBe("0.75");
    expect(r.headers["WWW-Authenticate"]).toContain("x402 mpp");
    expect(JSON.parse(r.headers[X402_HEADER] ?? "{}").x402Version).toBe(2);
  });

  it("formats small amounts without float noise", () => {
    expect(buildPaymentRequired({ resource: "r", priceUsd: 0.05 }).body.accepts[0]?.amountUsd).toBe(
      "0.05",
    );
    expect(buildPaymentRequired({ resource: "r", priceUsd: 5 }).body.accepts[0]?.amountUsd).toBe(
      "5.0",
    );
    expect(() => buildPaymentRequired({ resource: "r", priceUsd: -1 })).toThrow();
  });

  it("returns a Web-standard Response", async () => {
    const res = paymentRequiredResponse({ resource: "r", priceUsd: 1 });
    expect(res.status).toBe(402);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { priceUsd: number };
    expect(body.priceUsd).toBe(1);
  });

  it("stub verifier never accepts", async () => {
    const v = new StubVerifier();
    const req = new Request("https://x/y", { headers: { PAYMENT: "abc" } });
    const out = await v.verify(req, { rail: "x402", amountUsd: "1.0", resource: "r" });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/not live/);
  });
});
