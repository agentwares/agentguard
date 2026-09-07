# @agentwares/agentguard-sdk

The [agentguard](https://github.com/agentwares/agentguard/tree/main/apps/agentguard-cli#readme) policy engine for tool calls that never go through MCP — OpenAI Agents SDK, LangChain, or plain functions — plus a guarded `fetch` that puts a **hard dollar limit on LLM token spend** across OpenAI, Anthropic and Gemini. Same `agentguard.yaml`, same caps, kill switch, approvals, dry-run and hash-chained audit log as the proxy; the CLI (`agentguard report`, `kill`, `approve`, `verify`) works on the same files.

```sh
npm i @agentwares/agentguard-sdk
```

```ts
import { createGuard, createGuardedFetch, wrapOpenAIAgentsTools } from "@agentwares/agentguard-sdk";
import { Agent, run, tool } from "@openai/agents";
import OpenAI, { setDefaultOpenAIClient } from "@openai/agents-openai";

const ag = await createGuard({ policy: "agentguard.yaml" }); // file-backed: shares state with the CLI

// 1. tools: caps, approvals, loop breaker, dry-run — blocked calls return { code, cause, fix } as the tool output
const tools = wrapOpenAIAgentsTools(ag, [deleteContact, sendEmail, chargeCard]);

// 2. tokens: every OpenAI/Anthropic/Gemini response is priced and charged to the same spend_usd caps
setDefaultOpenAIClient(new OpenAI({ fetch: createGuardedFetch(ag) }));

await run(new Agent({ name: "ops", tools }), "clean up stale contacts");
console.log(await ag.reportMarkdown()); // what it did / would have destroyed / spent
```

## API

|                                                                      |                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createGuard({ policy, runId?, agent?, onEvent?, memory?, env? })`   | `policy` is a path to `agentguard.yaml` (file-backed state, shared with the CLI) or an inline policy object (in-memory). `agent` picks a scope from `agents:`.                                                                                           |
| `ag.wrap(fn, { name, annotations?, outputSchema?, onBlock? })`       | wrap `(args) => result`; blocked calls throw `GuardError` (or return the body with `onBlock: "return"`)                                                                                                                                                  |
| `ag.wrapAll({ name: fn, … })`                                        | wrap a map of functions by name                                                                                                                                                                                                                          |
| `wrapOpenAIAgentsTool(s)(ag, tool(s), opts?)`                        | wrap what `tool({...})` returns (duck-typed on `invoke`); blocked → error JSON as the tool output, faked → synthetic JSON                                                                                                                                |
| `wrapLangChainTool(s)(ag, tool(s), opts?)`                           | wrap a `StructuredTool` / `DynamicStructuredTool`; keeps the prototype, intercepts `_call`                                                                                                                                                               |
| `createGuardedFetch(ag, { fetch?, runId?, providers?, onSpend? })`   | a `fetch` for `new OpenAI({ fetch })`, `new Anthropic({ fetch })`, Gemini REST: refuses calls once `spend_usd` is used up (402 `CAP_EXCEEDED`, 403 `KILLED`), prices every response (streamed too) with built-in list prices or `spend.models` overrides |
| `ag.spend(usd, label, { force? })`                                   | record spend from anything else (a paid API); throws `CAP_EXCEEDED` unless `force`                                                                                                                                                                       |
| `ag.halt(reason)` / `ag.resume()`                                    | kill switch (writes the KILL file when file-backed)                                                                                                                                                                                                      |
| `ag.pendingApprovals()` / `ag.approve(id)` / `ag.deny(id)`           | approvals                                                                                                                                                                                                                                                |
| `ag.newRun(id?)` / `ag.runId`                                        | run identity for per-run caps and the loop window                                                                                                                                                                                                        |
| `ag.status()` / `ag.audit()` / `ag.report()` / `ag.reportMarkdown()` | counters vs caps; the audit entries; the incident-shaped report                                                                                                                                                                                          |

Errors (`GuardError` or the returned body) always carry `{ code, cause, fix, retryable, details? }` with codes `KILLED`, `APPROVAL_REQUIRED`, `APPROVAL_DENIED`, `LOOP_DETECTED`, `CAP_EXCEEDED`, `TOOL_DENIED`, `UPSTREAM_ERROR`.

## Spend on tokens

`createGuardedFetch` recognizes `api.openai.com` (chat completions and responses, streamed or not — OpenAI chat streams get `stream_options.include_usage` added), `api.anthropic.com` (`message_start` + `message_delta` usage) and `generativelanguage.googleapis.com` (`usageMetadata`). Prices: built-in list prices for current Claude / GPT / Gemini families (`DEFAULT_MODEL_PRICES` in core), overridden per pattern in the policy:

```yaml
caps:
  per_run: { spend_usd: 5 }
  per_day: { spend_usd: 50 }
spend:
  models:
    "gpt-5*": { input_per_mtok: 1.25, output_per_mtok: 10, cached_input_per_mtok: 0.125 }
    "my-finetune*": { input_per_mtok: 3, output_per_mtok: 12 }
```

Money spent by a response that crosses the cap is still recorded (`reason: over cap after the fact`) and alerts fire; the next call is refused.

A model with no matching price — a fine-tune, or one newer than the built-in table — is recorded at $0 with `reason: no list price for "<model>"`, so `agentguard report` shows a model the budget is not covering instead of under-counting it silently. Add it under `spend.models` to bring it back under the cap.

## Tests

`pnpm test` — plain functions, OpenAI-Agents-shaped and LangChain-shaped fakes (no SDK dependency), file-backed state shared with the CLI, guarded fetch with fake OpenAI/Anthropic responses including SSE streams.
