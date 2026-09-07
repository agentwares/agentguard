# agentguard

A policy proxy between an AI agent and the tools it can reach: hard spend limits,
approval before anything destructive, a kill switch, per-agent scoped credentials,
dry-run writes with a mutation diff, a semantic loop breaker, and a hash-chained
audit log you can verify.

```bash
npx @agentwares/agentguard init
```

No LLM calls anywhere in it. No phone-home. No account. MIT.

- `packages/agentguard-core` — the policy engine (Web-standard, runs anywhere)
- `apps/agentguard-cli` — `agentguard`, the proxy and its commands
- `packages/agentguard-sdk` — the same engine for non-MCP tool calls
- `assets/permission-diff-action` — a GitHub Action that comments when agent permissions widen
- `packages/mcp-kit`, `packages/notify`, `packages/x402` — generic plumbing the CLI bundles

Hosted incident dashboard, audit retention and alerting: https://agentwares-agentguard.vercel.app

This repository is exported from a private monorepo, which is why it has no long history.
The exported source is complete and is exactly what is published to npm.
