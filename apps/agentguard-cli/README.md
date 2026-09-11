# agentguard

**60 seconds to a safe first run.** Your agent already has an MCP config. Put agentguard in front of it, run the agent once in dry-run, and read what it _would_ have done:

```sh
npx @agentwares/agentguard init          # finds your MCP config, writes agentguard.yaml (dry-run), routes every server through the proxy
# restart your MCP client, run your agent as usual — writes are faked, nothing executes upstream
npx @agentwares/agentguard report        # "would have deleted 12 records, sent 5 emails, spent $140 — halted a loop at call 31"
npx @agentwares/agentguard diff          # the record-by-record mutation diff
# set `mode: enforce` in agentguard.yaml when it looks right
```

```
# agentguard report — run `run_20260902_a1b2`

61 tool calls between 10:02:11 and 10:02:19 across crm.

## What this run would have done (dry-run, nothing was executed)

It would have **deleted 1 record**, updated 1, created 1, sent 1 message, **spent $12.00**.

## Where agentguard stepped in

| #  | code            | tool               | why                                                          |
|----|-----------------|--------------------|--------------------------------------------------------------|
| 10 | `LOOP_DETECTED` | crm_update_contact | called 3 times with the same arguments in the last 30 calls  |
| 61 | `CAP_EXCEEDED`  | crm_create_contact | writes cap for this run is 50; used 50, this call would make it 51 |
```

agentguard is an MCP policy proxy for agents that touch production. It sits between the agent and its MCP servers, sees every tool call, and enforces one YAML file:

- **Hard spend limits** — per-run and per-day `spend_usd` across every provider, from tool arguments (`stripe_create_charge.amount`), tool results (`cost_usd`), and — with the SDK's guarded `fetch` — LLM token usage from OpenAI, Anthropic and Gemini responses. The call that would exceed the cap gets `CAP_EXCEEDED` with the remaining budget.
- **Destructive-action gating with approvals** — `approval.tools: [crm_delete_*]` makes the agent get `APPROVAL_REQUIRED` + an id; a human runs `agentguard approve <id>` (or clicks the button in Slack) and the agent's identical retry goes through once.
- **Kill switch** — `agentguard kill` (a file), `AGENTGUARD_KILL=1` (env), or `POST /kill` (HTTP): every run halts instantly with `KILLED` until `agentguard resume`.
- **Per-agent scoped credentials** — the proxy holds the upstream tokens; each agent gets an `agk_…` key with its own allowlist, denylist and caps. Only the key's hash lives in the policy.
- **Dry-run writes with mutation diffs** — classified writes return a plausible success shaped by the tool's output schema so the agent keeps going; `agentguard diff` shows what would have changed.
- **Semantic loop breaker** — the same `(tool, normalized args)` 3× in the last 30 calls, or an A→B→A→B cycle, returns `LOOP_DETECTED`. Timestamps, ids, whitespace and key order are ignored.
- **Blast-radius caps** — `tool_calls`, `writes`, `deletes`, `emails`, `spend_usd` and custom counters, per run and per day.
- **Hash-chained audit log** — every call is a JSONL line with `prev_hash` and `hash`; `agentguard verify` proves no entry was edited, removed from the middle, or reordered (see Limits for what a local chain cannot prove on its own).

No LLM calls. No phone-home. No account. MIT.

Two install paths, one policy engine: the **MCP proxy** (`npx @agentwares/agentguard`, stdio + Streamable HTTP, multiple upstreams) and the **SDK/middleware** ([`@agentwares/agentguard-sdk`](https://github.com/agentwares/agentguard/tree/main/packages/agentguard-sdk#readme)) for OpenAI Agents SDK, LangChain or plain-function tools that never go through MCP.

## Install

```sh
npx @agentwares/agentguard init                                  # rewrites the first project-level config it finds
npx @agentwares/agentguard init --all                            # ...or every config: .mcp.json, .cursor/mcp.json, .vscode/mcp.json
npx @agentwares/agentguard init --client ~/.claude.json          # a user-level config, which --all still leaves alone
npx @agentwares/agentguard init --client ~/Library/Application\ Support/Claude/claude_desktop_config.json   # user-level configs only with --client
npx @agentwares/agentguard init --undo                           # restore the backup
```

`init` writes `agentguard.yaml` next to your config, backs the config up (`*.agentguard-backup`), and replaces its servers with one entry:

```json
{
  "mcpServers": {
    "agentguard": {
      "command": "npx",
      "args": ["-y", "agentguard", "proxy", "--config", "/abs/path/agentguard.yaml"]
    }
  }
}
```

Tools keep their names (prefixed `<upstream>__` only on collision). Your MCP client sees one server; agentguard connects to all of them and holds their credentials.

Spawned with no arguments at all — what an install from the MCP registry does — `agentguard` serves the same stdio proxy and reads `AGENTGUARD_CONFIG` or `./agentguard.yaml`. In a terminal it prints the help instead.

Prefer HTTP (several agents, scoped keys, Slack approve buttons)? `agentguard proxy --http --port 8788` and point clients at `http://127.0.0.1:8788/mcp` with an `X-Run-Id` header per run and `Authorization: Bearer agk_…` per agent.

## Policy

`agentguard init` generates this file with every knob explained inline. The short form:

```yaml
version: 1
mode: dry-run                     # dry-run | enforce
upstreams:
  - name: crm
    url: https://mcp.example.com/mcp
    auth: ${CRM_TOKEN}            # the agent never sees this
  - name: files
    command: npx
    args: [-y, "@modelcontextprotocol/server-filesystem", "."]
classify:                         # patterns win over annotations win over verb heuristics
  write: [crm_update_*, crm_delete_*, email_send]
  spend: [stripe_*, x402_*]
  unknown: write                  # unclassifiable tools count as writes (or: read | block)
caps:
  per_run: { writes: 50, deletes: 10, emails: 5, spend_usd: 25, tool_calls: 400 }
  per_day: { spend_usd: 200 }
spend:
  tools:
    stripe_create_charge: { amount_arg: amount, divisor: 100, currency_arg: currency }
loop: { window: 30, max_repeats: 3, max_cycle_len: 4, max_read_repeats: 10 }
dry_run: { tools: [crm_delete_*], synthesize: true }      # always fake these, even in enforce
approval:
  tools: [crm_delete_*, db_drop_*]
  wait_s: 0                       # >0 holds the call open waiting for the decision
  notify: { slack: ${SLACK_WEBHOOK_URL} }
kill: { file: .agentguard/KILL, env: AGENTGUARD_KILL }
agents:                           # agentguard key create deployer --allow 'crm_get_*' --writes 5
  - name: deployer
    key_hash: sha256:…
    allow: [crm_get_*, crm_update_contact]
    caps: { per_run: { writes: 5 } }
alerts: { slack: ${SLACK_WEBHOOK_URL}, on: [LOOP_DETECTED, CAP_EXCEEDED, KILLED, APPROVAL_REQUIRED] }
audit: { path: .agentguard/audit.jsonl, redact: true }
```

Classification order: `classify.*` patterns → MCP `annotations.readOnlyHint` / `destructiveHint` → verb heuristics (`get/list/search…` read, `create/update/delete/send/execute…` write, `pay/charge/refund…` + `stripe_*`/`x402_*` spend). `agentguard tools` prints every tool with its class and why.

## What the agent sees

Every block is an in-band tool result with `isError: true` and a JSON body the model can act on:

```json
{
  "code": "CAP_EXCEEDED",
  "cause": "writes cap for this run is 50; used 50, this call would make it 51",
  "fix": "stop and report to the user what is done and what remains; a human can raise caps.per_run in agentguard.yaml or start a new run",
  "retryable": false,
  "details": {
    "scope": "per_run",
    "counter": "writes",
    "limit": 50,
    "used": 50,
    "remaining": { "writes": { "per_run": 0 } }
  }
}
```

Codes: `KILLED`, `APPROVAL_REQUIRED` (retryable once approved), `APPROVAL_DENIED`, `LOOP_DETECTED`, `CAP_EXCEEDED`, `TOOL_DENIED`, `UNKNOWN_TOOL`, `UPSTREAM_ERROR`. Successful and faked results carry `_meta.agentguard = { class, verb, mode, outcome, dryRun, seq, run_id }`.

Run identity: `X-Run-Id` header (HTTP) → `_meta.runId` on the call → session → one id per proxy process. Per-run caps and the loop window are per run; per-day caps are per policy (and per agent).

## Commands

| Command                                                                                                                         | What it does                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentguard init [--client path] [--all] [--no-probe] [--mode enforce] [--undo]`                                                | generate the policy, rewrite the client config (project-level by default)                                                                               |
| `agentguard proxy [--http --port 8788] [--agent name] [--run-id id] [--mode m]`                                                 | run the proxy (stdio default)                                                                                                                           |
| `agentguard report [--run id \| --all] [--json]`                                                                                | what this run did / would have destroyed / spent; where it was halted; chain status                                                                     |
| `agentguard diff [--run id]`                                                                                                    | mutation diff of faked writes                                                                                                                           |
| `agentguard verify [audit.jsonl]`                                                                                               | recompute the hash chain; exit 1 on the first break                                                                                                     |
| `agentguard status [--run id]`                                                                                                  | counters vs caps, kill state, pending approvals, running HTTP proxy                                                                                     |
| `agentguard tools [--json]`                                                                                                     | every exposed tool with class, verb, upstream and the reason                                                                                            |
| `agentguard kill [reason]` / `agentguard resume`                                                                                | halt everything now / clear it                                                                                                                          |
| `agentguard approvals [--all]` / `approve <id>` / `deny <id> [--note …]`                                                        | the approval queue                                                                                                                                      |
| `agentguard key create <agent> [--allow p]… [--deny p] [--writes n] [--spend n] [--mode m]` / `key list` / `key revoke <agent>` | scoped credentials                                                                                                                                      |
| `agentguard connect <key> [--write] [--client path] [--all] [--url base]`                                                       | point this machine's MCP client at a hosted proxy (paid tiers); prints the config, `--write` merges it in                                               |
| `agentguard permission-diff [--base ref] [--head ref] [--fail-on-widen]`                                                        | which config changes widen agent permissions (also a [GitHub Action](https://github.com/agentwares/agentguard/tree/main/assets/permission-diff-action)) |

### Hosted tiers

The CLI enforces policy on your machine and needs no account. The paid tiers move enforcement
server-side — shared state across machines, retained audit, alerting — and `connect` is how you
point a client at yours:

```sh
npx @agentwares/agentguard connect agk_...            # print the MCP server block
npx @agentwares/agentguard connect agk_... --write    # merge it into your MCP config (existing servers are kept)
```

Unlike `init`, `connect` adds one remote server and leaves the rest of your config alone. The key
comes from your dashboard; everything else — proxy URL, mode, band — is answered by the server.

HTTP control endpoints (token in `.agentguard/http.json`): `GET /health`, `GET /status?run=`, `POST /kill`, `POST /resume`, `GET|POST /approve/:id`, `/deny/:id`, `GET /approvals`.

## Try it with the fixtures

```sh
git clone https://github.com/agentwares/agentguard && cd agentguard && pnpm install && pnpm build
cd apps/agentguard-cli
cat > agentguard.yaml <<'YAML'
mode: dry-run
upstreams:
  - name: crm
    command: node
    args: [dist/fixtures/crm-server.js]
caps: { per_run: { writes: 50 } }
YAML
node dist/fixtures/demo-agent.js --config agentguard.yaml   # a scripted agent: reads, writes, a deliberate loop, a 60-write burst
node dist/cli.js report && node dist/cli.js diff && node dist/cli.js verify
```

## Conformance and tests

`pnpm test` runs the CLI suite (24 tests; 64 more in `agentguard-core`, 10 in the SDK): the engine over InMemoryTransport, the spawned stdio proxy, the Streamable HTTP proxy with `X-Run-Id`, scoped keys and control endpoints, `init` against real configs, and a recorded-fixture replay (`fixtures/recorded/crm-session.json`; re-record with `RECORD_FIXTURES=1`). `pnpm conformance` runs the official `@modelcontextprotocol/conformance` server suite against the proxy with a sample server behind it (tools, resources, prompts, completions, logging, progress, sampling and elicitation are relayed).

## Limits (honest)

- The proxy sees MCP tool calls. Token spend on the model API is only visible through the SDK's guarded `fetch` (or `spend.tools` rules for MCP tools that call models).
- Dry-run synthesizes results from the tool's `outputSchema`; agents that depend on real ids from a create → update chain will see plausible but fake ids. `dry_run.tools` lets you fake only the dangerous tools in enforce mode.
- Per-day counters are a JSON file under a directory lock; fine for a workstation or one box, not a fleet. The hosted tier (coming) is the shared-state version.
- Slack "Approve" buttons are links to the local HTTP proxy; they work for people who can reach it. Without HTTP mode the message carries the `agentguard approve <id>` command.
- A local hash chain is tamper-**evident**, not tamper-proof, and it has one blind spot: entries deleted from the **end** of the file leave a shorter chain that still verifies. Editing, deleting from the middle, and reordering are all caught. `agentguard verify` prints the head hash and the entry count — record them (CI log, ticket, chat) to close the gap, or use the hosted tier, which publishes a daily Merkle root you can check the run against.

## Related

- [`@agentwares/agentguard-sdk`](https://github.com/agentwares/agentguard/tree/main/packages/agentguard-sdk#readme) — the same engine for OpenAI Agents SDK / LangChain / plain functions, plus the guarded `fetch` for LLM spend.
- [`@agentwares/agentguard-core`](https://github.com/agentwares/agentguard/tree/main/packages/agentguard-core#readme) — the Web-standard policy engine (bring your own stores).
- [permission-diff GitHub Action](https://github.com/agentwares/agentguard/tree/main/assets/permission-diff-action) — comments on PRs that widen `agentguard.yaml`, `.claude/settings.json` or `mcp.json`.
