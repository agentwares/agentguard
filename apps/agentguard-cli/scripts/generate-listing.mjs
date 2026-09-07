#!/usr/bin/env node
/** Writes server.json, llms.txt and the registry publish workflow from package.json. */
import { generateServerJson, registryPublishWorkflow, renderLlmsTxt } from "@agentwares/mcp-kit";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const serverJson = generateServerJson({
  name: "io.github.agentwares/agentguard",
  title: "agentguard",
  description:
    "MCP policy proxy: spend caps, approvals for destructive tools, kill switch, dry-run, audit log.",
  version: pkg.version,
  repository: {
    url: "https://github.com/agentwares/agentguard",
    source: "github",
    subfolder: "apps/agentguard-cli",
  },
  websiteUrl: "https://github.com/agentwares/agentguard/tree/main/apps/agentguard-cli",
  npmPackage: {
    identifier: "@agentwares/agentguard",
    version: pkg.version,
    runtimeHint: "npx",
    environmentVariables: [
      {
        name: "AGENTGUARD_CONFIG",
        description: "Path to agentguard.yaml (default ./agentguard.yaml)",
        isRequired: false,
        format: "filepath",
      },
      {
        name: "AGENTGUARD_KILL",
        description: "Set to 1 to halt every tool call (kill switch)",
        isRequired: false,
      },
    ],
  },
});
// The registry entry has no package arguments: a client spawns bare `npx @agentwares/agentguard`, and the CLI
// serves the stdio proxy when stdout is a pipe (see cli.ts).
writeFileSync(path.join(root, "server.json"), JSON.stringify(serverJson, null, 2) + "\n");

writeFileSync(
  path.join(root, "llms.txt"),
  renderLlmsTxt({
    name: "agentguard",
    summary:
      "MCP policy proxy for AI agents: hard spend limits, destructive-action gating with approvals, kill switch, scoped agent keys, dry-run writes with mutation diffs, semantic loop breaker, blast-radius caps, hash-chained audit log. CLI `npx @agentwares/agentguard`; SDK `@agentwares/agentguard-sdk`. No LLM calls, no phone-home, no account.",
    links: [
      {
        title: "README (install in 60 seconds)",
        url: "https://github.com/agentwares/agentguard/tree/main/apps/agentguard-cli#readme",
      },
      {
        title: "Policy file reference",
        url: "https://github.com/agentwares/agentguard/tree/main/apps/agentguard-cli#policy",
      },
      {
        title: "SDK / middleware",
        url: "https://github.com/agentwares/agentguard/tree/main/packages/agentguard-sdk#readme",
      },
      {
        title: "npm: @agentwares/agentguard",
        url: "https://www.npmjs.com/package/@agentwares/agentguard",
      },
      {
        title: "Permission-diff GitHub Action",
        url: "https://github.com/agentwares/agentguard/tree/main/permission-diff",
      },
    ],
    tools: [],
  }),
);

writeFileSync(
  path.join(root, "publish-mcp.workflow.yml"),
  // Registry publishing only: GitHub OIDC, no secrets. npm publishing stays in the
  // monorepo (`scripts/publish-npm.sh`), and must happen first — the registry verifies
  // that the published npm package carries `mcpName`.
  registryPublishWorkflow({
    serverJsonPath: "apps/agentguard-cli/server.json",
    tagPattern: "agentguard-v*",
    workflowName: "Publish agentguard to the MCP Registry",
  }),
);
console.log("wrote server.json, llms.txt, publish-mcp.workflow.yml");
