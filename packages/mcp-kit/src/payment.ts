/**
 * `withPayment` — gate a tool behind a price. Wave 0: nothing is charged; callers without an
 * entitlement get a 402-shaped `PAYMENT_REQUIRED` result advertising both rails (x402 on Base,
 * Stripe MPP) with `comingSoon: true`, and `sample: true` returns an example for free.
 */
import {
  StubVerifier,
  buildPaymentRequired,
  paymentRequiredResponse,
  type PaymentRequiredBody,
  type PaymentVerifier,
} from "@agentwares/x402";
import { z } from "zod";
import { toolError, type McpToolError } from "./errors.js";
import { defineTool, type ToolContext, type ToolDef } from "./tool.js";

export interface AuthorizeResult {
  ok: boolean;
  userId?: string;
  /** why not, e.g. "API key revoked" — surfaced in `details.reason` */
  reason?: string;
}

export interface WithPaymentOptions {
  /** price per successful call, in USD (e.g. 0.05) */
  priceUsd: number;
  /** Entitlement check (API key + credits, subscription tier). `ok: true` skips payment. */
  authorize?: (ctx: ToolContext) => Promise<AuthorizeResult> | AuthorizeResult;
  /** Payment verifier for the request headers. Default: `StubVerifier` (never accepts). */
  verifier?: PaymentVerifier;
  /** set once pay-per-call is live (drops `comingSoon`) */
  live?: boolean;
  /** name of the boolean input field that requests a free sample (default `sample`) */
  sampleField?: string;
  /** shown in the payment requirement */
  description?: string;
  payTo?: string;
  signupUrl?: string;
}

/** A `McpToolError` whose body is the x402 `PaymentRequiredBody` (code `PAYMENT_REQUIRED`). */
export function paymentRequiredError(body: PaymentRequiredBody, reason?: string): McpToolError {
  const { code, cause, fix, retryable, ...rest } = body;
  return toolError({
    code,
    cause,
    fix,
    retryable,
    httpStatus: 402,
    details: reason !== undefined ? { reason } : undefined,
    extra: rest,
  });
}

function formatUsd(priceUsd: number): string {
  return priceUsd
    .toFixed(6)
    .replace(/0+$/, "")
    .replace(/\.$/, ".00")
    .replace(/\.(\d)$/, ".$10");
}

/**
 * Wrap a tool so it requires an entitlement or payment. The returned tool has the same name,
 * schema and output, plus an optional boolean `sample` input (default false) documented as
 * "return an example response at no charge".
 *
 * Flow per call: `sample` → handler with `ctx.sample = true`; else `authorize` ok → handler
 * (with `ctx.userId`); else verifier accepts the request's payment headers → handler; else a
 * `PAYMENT_REQUIRED` error result (`_meta.httpStatus: 402`).
 */
export function withPayment(tool: ToolDef, opts: WithPaymentOptions): ToolDef {
  if (!Number.isFinite(opts.priceUsd) || opts.priceUsd < 0) {
    throw new Error(`withPayment(${tool.name}): priceUsd must be a non-negative number`);
  }
  const sampleField = opts.sampleField ?? "sample";
  if (sampleField in tool.input.shape) {
    throw new Error(
      `withPayment(${tool.name}): input already has a field named ${JSON.stringify(sampleField)}; pass sampleField to rename it`,
    );
  }
  const verifier = opts.verifier ?? new StubVerifier();
  const input = tool.input.extend({
    [sampleField]: z
      .boolean()
      .default(false)
      .describe(
        "Set true to return an example response at no charge (sample mode). Default false.",
      ),
  });
  const description = `${tool.description.trim()} Paid: $${formatUsd(opts.priceUsd)} per call; without credit you get a PAYMENT_REQUIRED result. Set ${sampleField}=true for a free example response.`;

  return defineTool({
    name: tool.name,
    title: tool.title,
    description,
    input,
    output: tool.output,
    annotations: tool.annotations,
    async handler(raw, ctx) {
      const record: Record<string, unknown> = { ...raw };
      const sample = record[sampleField] === true;
      delete record[sampleField];

      if (sample) return tool.handler(record, { ...ctx, sample: true });

      let reason: string | undefined;
      if (opts.authorize) {
        const auth = await opts.authorize(ctx);
        if (auth.ok) return tool.handler(record, { ...ctx, userId: auth.userId });
        reason = auth.reason;
      }

      const required = buildPaymentRequired({
        resource: tool.name,
        priceUsd: opts.priceUsd,
        live: opts.live,
        description: opts.description,
        payTo: opts.payTo,
        signupUrl: opts.signupUrl,
      });
      const requirement = required.body.accepts[0];
      if (requirement) {
        const verified = await verifier.verify(
          new Request(`https://mcp.local/${tool.name}`, { headers: ctx.headers }),
          requirement,
        );
        if (verified.ok) return tool.handler(record, ctx);
        reason = reason ?? verified.reason;
      }
      throw paymentRequiredError(required.body, reason);
    },
  });
}

/** Web-standard 402 `Response` for plain HTTP endpoints (re-export of `@agentwares/x402`). */
export const paymentRequiredHttpResponse = paymentRequiredResponse;

export { StubVerifier, buildPaymentRequired };
export type { PaymentRequiredBody, PaymentVerifier };
