# agentguard permission-diff (GitHub Action)

Comments on pull requests that **widen what an agent may do**:

- `agentguard.yaml` — `mode: dry-run → enforce`, raised or removed caps, removed `deny` / `dry_run.tools` / `approval.tools`, new upstreams, widened agent allowlists
- `.claude/settings.json` / `.claude/settings.local.json` — `permissions.allow` additions, `permissions.deny` removals, `defaultMode: bypassPermissions`, `additionalDirectories`, hooks and MCP server changes
- `.mcp.json`, `mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json` — new or changed servers, new env vars

Narrowings and neutral changes are listed too, so reviewers see the whole picture. One comment per PR, updated in place.

```yaml
# .github/workflows/agentguard.yml
name: agentguard permission diff
on:
  pull_request:
    paths: ["agentguard.yaml", ".claude/settings*.json", "**/mcp.json", ".mcp.json"]
permissions:
  contents: read
  pull-requests: write
jobs:
  diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: agentwares/agentguard/permission-diff@main
        with:
          fail-on-widen: "false" # set "true" to block merges that widen permissions
```

Example comment:

> ### agentguard permission diff
>
> **3 changes widen what an agent may do.** Review before merging.
>
> |           | file                    | setting               | change                                         |
> | --------- | ----------------------- | --------------------- | ---------------------------------------------- |
> | 🔴 widen  | `agentguard.yaml`       | `mode`                | dry-run → enforce (writes will really execute) |
> | 🔴 widen  | `agentguard.yaml`       | `caps.per_run.writes` | 50 → 500                                       |
> | 🔴 widen  | `.claude/settings.json` | `permissions.allow`   | added `Bash(*)`                                |
> | 🟢 narrow | `agentguard.yaml`       | `approval.tools`      | added `crm_delete_*`                           |

Inputs: `github-token` (default `${{ github.token }}`), `paths` (extra files), `fail-on-widen`, `version` (agentguard npm version), `comment` (`false` to only print). Outputs: `widen` (count), `markdown-file`.

Locally: `npx @agentwares/agentguard permission-diff --base main --head HEAD [--fail-on-widen]` — the same diff the Action posts. The differ lives in [`@agentwares/agentguard-core`](../../packages/agentguard-core) (`diffPermissionFile`, `renderPermissionDiffMarkdown`) and is tested against a fixture PR in `apps/agentguard-cli/src/commands/commands.test.ts`.
