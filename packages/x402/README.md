# @agentwares/x402

`402 Payment Required` for paid HTTP endpoints and MCP tools. It builds the response an agent can
act on without a human: machine-readable payment requirements for both rails (x402 on Base via
USDC, and Stripe's Machine Payments Protocol), a structured `code` / `cause` / `fix` / `retryable`
body, and the `PaymentVerifier` interface your wallet implements.

No dependencies beyond `zod`, no Node built-ins, nothing that holds funds. Web-standard `Request`
and `Response`, so it runs unchanged on Vercel Functions, Cloudflare Workers and Node 20+.

```sh
npm install @agentwares/x402
```

## Answer a paid call

```ts
import { paymentRequiredResponse, StubVerifier } from "@agentwares/x402";

const verifier = new StubVerifier(); // swap for your wallet-backed verifier

export async function GET(request: Request) {
  const paid = await verifier.verify(request, {
    rail: "x402",
    amountUsd: "0.05",
    resource: "/quote",
  });
  if (!paid.ok) {
    return paymentRequiredResponse({
      resource: "/quote",
      priceUsd: 0.05,
      description: "One property quote",
      signupUrl: "https://example.com/keys", // offered as the way to pay today
    });
  }
  return Response.json({ quote: 42 });
}
```

The caller gets `402` with `WWW-Authenticate: Payment realm=…`, an `X-Payment-Requirements`
header (JSON) plus its base64 `PAYMENT-REQUIRED` twin, and a body like:

```json
{
  "code": "PAYMENT_REQUIRED",
  "cause": "This call costs $0.05. Pay-per-call (x402 / Stripe MPP) is coming soon; use an API key with prepaid credits.",
  "fix": "Create an API key at https://example.com/keys and retry with Authorization: Bearer <key>. Try the free sample mode first.",
  "retryable": true,
  "priceUsd": 0.05,
  "accepts": [
    {
      "rail": "x402",
      "amountUsd": "0.05",
      "resource": "/quote",
      "network": "eip155:8453",
      "asset": "USDC",
      "maxTimeoutSeconds": 300
    },
    {
      "rail": "mpp",
      "amountUsd": "0.05",
      "resource": "/quote",
      "currency": "usd",
      "maxTimeoutSeconds": 300
    }
  ],
  "comingSoon": true,
  "alternatives": ["api_key_credits", "sample_mode"]
}
```

## API

| Export                                | What it does                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `buildPaymentRequired(opts)`          | `{ status, headers, body }` for the 402 — use it when you build the response yourself                 |
| `paymentRequiredResponse(opts)`       | the same thing as a Web-standard `Response`                                                           |
| `PaymentVerifier`                     | `verify(request, requirement) => Promise<VerifyResult>` — implement this against your wallet          |
| `StubVerifier`                        | never accepts, never touches funds; use it until a real verifier exists                               |
| `X402_HEADER`, `X402_REQUIRED_HEADER` | the two header names, so clients and servers agree                                                    |
| types                                 | `PaymentRail`, `PaymentRequirement`, `PaymentRequiredBody`, `PaymentRequiredResponse`, `VerifyResult` |

`opts.live` controls the wording: with `live: false` (the default) the body says pay-per-call is
coming soon and points the agent at API keys with prepaid credits, and sets `comingSoon: true`.
Flip it to `true` the day a verifier can actually settle.

## Used by

[`@agentwares/mcp-kit`](https://www.npmjs.com/package/@agentwares/mcp-kit)'s `withPayment` wraps an
MCP tool with exactly this body, so a paid tool and a paid HTTP endpoint answer the same shape.

MIT © agentwares contributors — part of the [agentwares](https://agentwares.vercel.app) portfolio.
