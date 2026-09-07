# @agentwares/mcp-kit

Expose any package as an MCP server. One `defineTool` definition is served over **stdio** and
**Streamable HTTP** from the same code; the HTTP handler is Web-standard (`Request → Response`)
so it runs unchanged in Next.js route handlers, Vercel Functions and Cloudflare Workers.

- `defineTool` — zod input/output, naming lint (`<namespace>_<verb>_<object>`), descriptions written for a new teammate
- errors always carry `{ code, cause, fix, retryable }` (in the result text and, where the client can take it, `structuredContent`)
- `withPayment` — 402 with x402 + Stripe MPP payment options (Wave 0 stub: `comingSoon: true`, free `sample` mode)
- `generateServerJson` + `registryPublishWorkflow` — official MCP registry `server.json` and a tag-triggered OIDC publish workflow
- `renderLlmsTxt`, `pricingJson`, `listToolManifest` — the machine-readable docs every product ships

```sh
npm install @agentwares/mcp-kit
```

## Define a tool, serve both transports

```ts
import { z } from "zod";
import { createHttpHandler, defineTool, serveStdio, toolError } from "@agentwares/mcp-kit";

const createMonitor = defineTool({
  name: "agentcheck_create_monitor", // namespaced or it throws at boot
  description:
    "Create an uptime monitor for an MCP endpoint. Returns the monitor id and when it is first checked.",
  input: z.object({ url: z.url(), intervalMinutes: z.number().int().min(5).default(5) }),
  output: z.object({ id: z.string(), nextCheckAt: z.string() }),
  annotations: { readOnlyHint: false, idempotentHint: false },
  async handler({ url, intervalMinutes }, ctx) {
    if (!ctx.headers.get("authorization"))
      throw toolError("UNAUTHORIZED", "no API key sent", "retry with Authorization: Bearer <key>");
    return {
      id: await createMonitorRow(url, intervalMinutes),
      nextCheckAt: new Date().toISOString(),
    };
  },
});

const server = { name: "agentcheck", version: "1.0.0", tools: [createMonitor] };
export const POST = createHttpHandler(server); // Next.js app/mcp/route.ts (also Workers: `fetch: handler`)
if (process.argv.includes("--stdio")) await serveStdio(server); // npx entry for Claude Desktop / Cursor
```

`ctx` carries `headers` (empty over stdio), `requestId`, `signal`, `sessionId`, `log()`, `progress()` and
`extra` (the raw SDK context: `sendRequest` for sampling/elicitation).
`createMcpServer(opts)` returns the SDK `McpServer` if you need resources or prompts too; pass a factory
`createHttpHandler(() => server)` in that case.

The HTTP handler is stateless by default (fresh server + transport per request, one JSON body per
POST, `GET` → 405) — right for Vercel/Workers. Pass `jsonResponse: false` to stream SSE so
`ctx.log`/`ctx.progress` reach the client mid-call. Pass `sessions: true` on a long-lived process to
keep `Mcp-Session-Id` sessions in memory (SSE by default): that enables sampling/elicitation via
`ctx.extra.sendRequest` and the standalone GET stream. `OPTIONS` handles CORS when `cors: true`;
`handleHealth({ name, version, tools })` gives you a `/health` JSON response.

`tools/list` is served from `listToolManifest(tools)` — JSON Schema 2020-12 with
`additionalProperties: false` for plain `z.object`s (use `z.looseObject` to allow extra keys) — so
what `llms.txt` documents is exactly what the server advertises.

## Errors

```ts
throw toolError("NOT_FOUND", "no monitor mon_1", "list monitors and use an existing id");
throw toolError({
  code: "RATE_LIMITED",
  cause: "10 req/min exceeded",
  fix: "wait 30s",
  retryable: true,
  details: { resetAt },
});
```

Every failure — thrown `toolError`, plain `Error` (→ `INTERNAL`), invalid arguments (→ `INVALID_INPUT`
naming the fields, zod issues in `details`) — becomes a result with `isError: true`, the JSON body in
`content[0].text` and `_meta.httpStatus`. Codes: `INVALID_INPUT` `NOT_FOUND` `UNAUTHORIZED`
`PAYMENT_REQUIRED` `RATE_LIMITED` `UPSTREAM_ERROR` `INTERNAL` (plus your own). `structuredContent`
also carries the body unless the tool declares an `output` schema, because the official SDK client
validates any `structuredContent` against `outputSchema` even on errors.

## Payment stub (Wave 0)

```ts
const paidLookup = withPayment(lookup, {
  priceUsd: 0.05,
  authorize: async (ctx) => entitlementFor(ctx.headers),
});
```

Adds an optional `sample: boolean` input ("return an example response at no charge"). Flow per call:
`sample` → handler with `ctx.sample = true`; else `authorize` ok → handler with `ctx.userId`; else the
verifier checks the request's payment headers (default `StubVerifier`, never accepts); else a
`PAYMENT_REQUIRED` result whose body is `@agentwares/x402`'s `PaymentRequiredBody` — both rails in
`accepts`, `comingSoon: true` until the wallet ships, `_meta.httpStatus: 402`. For plain HTTP endpoints
use `paymentRequiredHttpResponse({ resource, priceUsd })`.

## Registry: server.json + publish on tag

```ts
const serverJson = generateServerJson({
  name: "io.github.acme/deal-memo", // io.github.<owner>/ is required for OIDC publishing
  description: "Turn a pitch deck into a scored deal memo.", // ≤ 100 chars
  version: "0.1.0",
  repository: {
    url: "https://github.com/acme/deal-memo",
    source: "github",
  },
  remoteUrl: "https://deal-memo.example.com/mcp",
  npmPackage: { identifier: "@acme/deal-memo-mcp", version: "0.1.0" }, // package.json needs `mcpName`
});
writeFileSync(
  ".github/workflows/publish-mcp.yml",
  registryPublishWorkflow({ serverJsonPath: "server.json" }),
);
```

Schema: `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`. The workflow
runs on tags matching `mcp-*`, installs `mcp-publisher`, `login github-oidc`, `publish` — no secrets.

## Docs

`renderLlmsTxt({ name, summary, links, tools })` → `llms.txt`; `pricingJson({ product, tiers, meters, updatedAt })`
→ `{ schema: "agentwares.pricing/v1", ... }`; `listToolManifest(tools)` → `[{ name, description, inputSchema, annotations }]`.

## Example + conformance

```sh
pnpm example:http        # serves example_echo / example_add / example_paid_lookup at http://127.0.0.1:8765/mcp
pnpm conformance         # builds, starts the example (stateful + SSE) with the suite's fixture tools/resources/prompts,
                         # runs npx -y @modelcontextprotocol/conformance@0.1.16 server --url http://127.0.0.1:<port>/mcp
pnpm conformance --stateless   # the serverless default: everything but sampling/elicitation passes
pnpm conformance --json        # JSON responses: additionally no mid-call log/progress notifications
```

`dist/example-http.js` flags: `--port= --host= --path= --sse --stateful --conformance --dns-protection`.
`conformanceTools` / `registerConformanceFixtures(server)` are exported so any product server can run the suite.

MIT © agentwares contributors — part of the [agentwares](https://agentwares.vercel.app) portfolio.
