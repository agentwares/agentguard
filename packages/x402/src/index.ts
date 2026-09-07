/**
 * @agentwares/x402 — 402 Payment Required helper + verifier interface.
 *
 * Wave 0 ships the *interface* and a stub: endpoints can already answer 402
 * with machine-readable payment requirements for both rails (x402 on Base
 * via the CDP facilitator, and Stripe MPP), but no payment is verified or
 * settled yet. WAL (Wave 3) replaces `StubVerifier` with the live one and
 * wires the prepaid wallet. Nothing here holds funds.
 */

export type PaymentRail = "x402" | "mpp";

export interface PaymentRequirement {
  rail: PaymentRail;
  /** decimal USD string, e.g. "0.05" */
  amountUsd: string;
  /** resource being paid for, usually the request URL or tool name */
  resource: string;
  description?: string;
  /** x402: network + asset; mpp: currency */
  network?: string;
  asset?: string;
  currency?: string;
  /** where to pay; absent while payments are not live */
  payTo?: string;
  /** seconds the quote is valid */
  maxTimeoutSeconds?: number;
}

export interface PaymentRequiredBody {
  code: "PAYMENT_REQUIRED";
  cause: string;
  fix: string;
  retryable: true;
  priceUsd: number;
  accepts: PaymentRequirement[];
  /** true until WAL ships */
  comingSoon: boolean;
  /** how to pay today: API key + prepaid credits */
  alternatives: string[];
}

export interface PaymentRequiredResponse {
  status: 402;
  headers: Record<string, string>;
  body: PaymentRequiredBody;
}

export interface BuildPaymentRequiredOptions {
  resource: string;
  priceUsd: number;
  description?: string;
  /** set once WAL is live */
  live?: boolean;
  payTo?: string;
  signupUrl?: string;
}

export const X402_HEADER = "X-Payment-Requirements";
export const X402_REQUIRED_HEADER = "PAYMENT-REQUIRED";

function toAmount(priceUsd: number): string {
  if (!Number.isFinite(priceUsd) || priceUsd < 0)
    throw new Error("priceUsd must be a non-negative number");
  return priceUsd.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0");
}

/** Build the 402 response (status, headers, JSON body) for a paid resource. */
export function buildPaymentRequired(opts: BuildPaymentRequiredOptions): PaymentRequiredResponse {
  const amountUsd = toAmount(opts.priceUsd);
  const accepts: PaymentRequirement[] = [
    {
      rail: "x402",
      amountUsd,
      resource: opts.resource,
      description: opts.description,
      network: "eip155:8453",
      asset: "USDC",
      payTo: opts.payTo,
      maxTimeoutSeconds: 300,
    },
    {
      rail: "mpp",
      amountUsd,
      resource: opts.resource,
      description: opts.description,
      currency: "usd",
      payTo: opts.payTo,
      maxTimeoutSeconds: 300,
    },
  ];
  const live = opts.live === true;
  const body: PaymentRequiredBody = {
    code: "PAYMENT_REQUIRED",
    cause: live
      ? `This call costs $${amountUsd}. No valid payment or credit was presented.`
      : `This call costs $${amountUsd}. Pay-per-call (x402 / Stripe MPP) is coming soon; use an API key with prepaid credits.`,
    fix: live
      ? "Retry with a PAYMENT header satisfying one of `accepts`, or send an API key with credit balance."
      : `Create an API key${opts.signupUrl ? ` at ${opts.signupUrl}` : ""} and retry with Authorization: Bearer <key>. Try the free sample mode first.`,
    retryable: true,
    priceUsd: opts.priceUsd,
    accepts,
    comingSoon: !live,
    alternatives: ["api_key_credits", "sample_mode"],
  };
  const encoded = JSON.stringify({ x402Version: 2, accepts, resource: opts.resource });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "WWW-Authenticate": `Payment realm="agentwares", methods="x402 mpp", price="${amountUsd} USD"`,
    [X402_HEADER]: encoded,
    [X402_REQUIRED_HEADER]: btoa(encoded),
    "Cache-Control": "no-store",
  };
  return { status: 402, headers, body };
}

export interface VerifyResult {
  ok: boolean;
  rail?: PaymentRail;
  receipt?: unknown;
  reason?: string;
}

/** Implemented for real by WAL. Given a request, decide whether it carries a valid payment. */
export interface PaymentVerifier {
  verify(request: Request, requirement: PaymentRequirement): Promise<VerifyResult>;
}

/** Phase-2 placeholder: never accepts a payment, never touches funds. */
export class StubVerifier implements PaymentVerifier {
  async verify(request: Request, requirement: PaymentRequirement): Promise<VerifyResult> {
    const hasHeader = request.headers.has("PAYMENT") || request.headers.has("X-PAYMENT");
    return {
      ok: false,
      rail: requirement.rail,
      reason: hasHeader
        ? "payments are not live yet (phase 2: wallet). Use an API key with credits."
        : "no payment header present",
    };
  }
}

/** Convenience: a Web-standard Response for the 402. */
export function paymentRequiredResponse(opts: BuildPaymentRequiredOptions): Response {
  const r = buildPaymentRequired(opts);
  return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
}
