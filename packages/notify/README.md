# @agentwares/notify

Transactional email (Resend free tier), Slack/Discord webhooks and HMAC-signed generic webhooks
behind one fan-out call. Plain HTML templates, no images, no tracking. Web-standard only (`fetch`,
`crypto.subtle`): the same code runs on Vercel Functions, Cloudflare Workers and Node 20+.

```sh
npm install @agentwares/notify
```

```ts
import { createNotify } from "@agentwares/notify";

const notify = createNotify({ resendApiKey: env.RESEND_API_KEY, from: env.RESEND_FROM });

await notify.alert(
  { email: ["ops@acme.dev"], slack: user.slackWebhookUrl },
  {
    productName: "agentcheck",
    targetName: "support-bot",
    checkName: "refund-policy",
    statusUrl: "https://agentcheck.vercel.app/acme/support-bot",
    openedAt: incident.openedAt,
    error: { code: "RUBRIC_FAIL", cause: "Score 0.41 < 0.7", fix: "Compare the diff below." },
    transcriptExcerpt: result.transcriptExcerpt,
    diff: { before: lastPass.answer, after: result.answer },
    consecutiveFailures: 2,
  },
);
// -> { email: { ok: true, id: "..." }, slack: { ok: true, status: 200 } }
```

## Exports

| Area      | Export                                                                                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTML      | `escapeHtml`, `safeUrl`, `layout({ title, preheader, bodyHtml, footerHtml })`, `toText(html)`, block helpers (`h1`, `p`, `link`, `button`, `pre`, `table`, `pill`, `callout`, `ul`), `formatDate`, `formatUsd` |
| Templates | `alertTemplate`, `recoveredTemplate`, `digestTemplate`, `driftTemplate`, `receiptTemplate` (each returns `{ subject, html, text }`)                                                                            |
| Channels  | `sendEmail`, `sendSlack`, `sendDiscord`, `sendWebhook`, `hmacSha256Hex`, `verifyWebhookSignature`, `truncate`                                                                                                  |
| Fan-out   | `createNotify({ resendApiKey?, from, replyTo?, fetch?, resend? })` returning `{ email, slack, discord, webhook, alert, recovered, drift, digest }`                                                             |

Every channel resolves a `SendResult = { ok, id?, status?, error? }` and never throws on remote failure. With no `resendApiKey` and no injected client, `email` resolves `{ ok: false, error: "RESEND_API_KEY not configured" }`.

## Templates

All inputs are escaped; output has no `<img>`; `text` is derived from the HTML (links kept as `text (url)`, `<pre>` preserved).

| Template            | Subject                                                 | Inputs                                                                                                                                             |
| ------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alertTemplate`     | `[product] FAILING: target · check`                     | `productName, targetName, checkName, statusUrl, openedAt, error {code, cause?, fix?}, transcriptExcerpt?, diff?, consecutiveFailures, silenceUrl?` |
| `recoveredTemplate` | `[product] RECOVERED: target · check`                   | `productName, targetName, checkName, statusUrl, downtimeMinutes`                                                                                   |
| `digestTemplate`    | `[product] Nightly report <date>[: N decisions needed]` | `productName, date, sections [{title, items}], costUsd?, decisionsNeeded?, reportUrl`                                                              |
| `driftTemplate`     | `[product] <model> shipped: N regressions in <target>`  | `productName, provider, model, releasedAt, targetName, summary, changes [{check, before, after, verdict}], runUrl, shareUrl`                       |
| `receiptTemplate`   | `[product] Receipt [ref]: $total`                       | `productName, lines [{description, amountUsd}], totalUsd, portalUrl, reference?`                                                                   |

`alertTemplate` leads with what failed, then the transcript excerpt, then the diff vs the last pass (unified string or `{ before, after }`), then the status link and a "silence for 24h" link (`silenceUrl`, defaulting to `statusUrl?silence=24h` until the app wires a route). `driftTemplate` is the forwardable one: regressed rows first, a "Forward this" line and the public `shareUrl`.

## Channels

- `sendEmail({ from, to, subject, html, text?, replyTo?, apiKey?, resend?, fetch? })`: Resend SDK (`new Resend(apiKey)`, `emails.send`). Inject `resend` for tests; injecting `fetch` posts to the same REST endpoint through it (the SDK only uses the global fetch).
- `sendSlack(webhookUrl, { text, blocks? })`
- `sendDiscord(webhookUrl, { content, embeds? })`: `content` truncated to 2000 chars without splitting surrogate pairs; returns the message id.
- `sendWebhook(url, payload, { secret?, headers? })`: JSON POST; with `secret`, adds `X-Agentwares-Signature: sha256=<HMAC-SHA256 hex of the raw body>`. Receivers call `verifyWebhookSignature(rawBody, secret, header)`.

Fan-out helpers send the full HTML by email and a one-line summary with the link to Slack/Discord; webhooks receive `{ event, product, subject, summary, url, occurredAt, data }`.

## Environment

Nothing is read from `process.env`: pass `resendApiKey` and `from` to `createNotify` yourself. In the agentwares portfolio those come from `RESEND_API_KEY` and `RESEND_FROM` (use `onboarding@resend.dev` until a domain is verified).

## Tests

`pnpm test` is fully offline (fake fetch / fake Resend). `LIVE_TESTS=1 pnpm test` additionally sends one alert to `delivered@resend.dev` through the real SDK, using `RESEND_API_KEY` from the environment or a repo-root `.env.local`.

MIT © agentwares contributors — part of the [agentwares](https://agentwares.vercel.app) portfolio.
