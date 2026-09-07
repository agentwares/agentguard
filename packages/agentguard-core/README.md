# @agentwares/agentguard-core

The policy engine behind [`agentguard`](../../apps/agentguard-cli) (MCP proxy) and [`@agentwares/agentguard-sdk`](../agentguard-sdk) (middleware). Web-standard (`crypto.subtle`, no `fs`) so the same engine runs on Node, Workers and the hosted tier; Node file stores live under `@agentwares/agentguard-core/node`.

```ts
import { Guard, loadPolicyFromYaml } from "@agentwares/agentguard-core";

const guard = new Guard({ policy: loadPolicyFromYaml(yamlText, { env: process.env }) });
const result = await guard.run(
  {
    tool: { name: "crm_delete_contact", annotations: { destructiveHint: true } },
    args: { id: "c_1" },
    runId: "run_1",
  },
  async (args) => upstream.call(args), // only runs when the policy allows
);
// result: { ok, value | error: { code, cause, fix, retryable }, outcome: ok|error|blocked|faked|halted|pending, faked, entry }
```

`Guard.run` applies, in order: kill switch → agent scope (allow/deny/upstreams) → classification (policy patterns → MCP annotations → verb heuristics; `unknown` is a write in enforce) → approvals (`APPROVAL_REQUIRED` bound to tool + args hash, consumed once) → semantic loop breaker (normalized args; repeats and A→B→A→B cycles) → per-run / per-day caps (counts and dollars) → dry-run synthesis from `outputSchema` or execute → spend accounting from results → hash-chained audit entry → `onEvent` for alerts.

Modules: `policy` (zod schema, `${ENV}` substitution, defaults), `classify`, `loop`, `caps`, `spend` (argument rules, result fields, LLM list prices), `dryrun`, `audit` (`ChainWriter`, `verifyChain`), `kill`, `approvals`, `scope` (agent keys), `report` (`buildReport`, `renderReportMarkdown`, `renderMutationDiff`), `permission-diff` (`agentguard.yaml`, `.claude/settings.json`, `mcp.json`). Stores are interfaces (`StateStore`, `AuditSink`, `KillSwitch`, `ApprovalStore`) with memory implementations here and file implementations in `./node` (`FileStateStore`, `FileAuditSink`, `FileKillSwitch`, `FileApprovalStore`, `loadPolicyFile`, `verifyAuditFile`).

Audit entries: `{ seq, ts, run_id, agent?, upstream?, tool, class, verb, mode, outcome, error?, args_hash, args (redacted), result_hash?, mutation?, usd?, counters?, latency_ms?, reason, prev_hash, hash }` with `hash = sha256(prev_hash + canonical(entry))`.
