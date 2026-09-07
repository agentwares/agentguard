import { describe, expect, it } from "vitest";
import {
  diffAgentguardPolicy,
  diffClaudeSettings,
  diffMcpConfig,
  diffPermissionFile,
  renderPermissionDiffMarkdown,
} from "./permission-diff.js";

describe("permission-diff", () => {
  it("flags widened caps, mode flips, removed denies and new upstreams", () => {
    const before = `mode: dry-run\ncaps:\n  per_run: { writes: 50, spend_usd: 25 }\ndeny: [db_drop_*]\ndry_run: { tools: [crm_delete_*] }\nupstreams:\n  - name: crm\n    url: https://a/mcp\n`;
    const after = `mode: enforce\ncaps:\n  per_run: { writes: 500 }\ndeny: []\ndry_run: { tools: [] }\nupstreams:\n  - name: crm\n    url: https://a/mcp\n  - name: shell\n    command: npx\n    args: [shell-mcp]\n`;
    const findings = diffAgentguardPolicy("agentguard.yaml", before, after);
    const widen = findings.filter((f) => f.severity === "widen").map((f) => f.path);
    expect(widen).toEqual(
      expect.arrayContaining([
        "mode",
        "caps.per_run.writes",
        "caps.per_run.spend_usd",
        "deny",
        "dry_run.tools",
        "upstreams.shell",
      ]),
    );
    expect(findings.find((f) => f.path === "caps.per_run.spend_usd")?.message).toContain(
      "unlimited",
    );
    expect(
      diffAgentguardPolicy("agentguard.yaml", after, before).filter((f) => f.severity === "widen"),
    ).toHaveLength(0);
    expect(diffAgentguardPolicy("agentguard.yaml", undefined, "mode: dry-run\n")).toHaveLength(0);
  });
  it("diffs Claude Code settings", () => {
    const before = JSON.stringify({
      permissions: { allow: ["Bash(git:*)"], deny: ["Bash(rm:*)"] },
    });
    const after = JSON.stringify({
      permissions: {
        allow: ["Bash(git:*)", "Bash(*)"],
        deny: [],
        defaultMode: "bypassPermissions",
      },
      mcpServers: { shell: { command: "npx", args: ["x"] } },
    });
    const findings = diffClaudeSettings(".claude/settings.json", before, after);
    expect(findings.map((f) => `${f.severity}:${f.path}`)).toEqual(
      expect.arrayContaining([
        "widen:permissions.allow",
        "widen:permissions.deny",
        "widen:permissions.defaultMode",
        "widen:mcpServers.shell",
      ]),
    );
  });
  it("diffs mcp.json in both shapes", () => {
    const findings = diffMcpConfig(
      ".mcp.json",
      JSON.stringify({ mcpServers: { a: { command: "x" } } }),
      JSON.stringify({ mcpServers: { a: { command: "y" }, b: { url: "https://b" } } }),
    );
    expect(findings.map((f) => `${f.severity}:${f.path}`)).toEqual([
      "change:mcpServers.a",
      "widen:mcpServers.b",
    ]);
    const vscode = diffMcpConfig(
      ".vscode/mcp.json",
      undefined,
      JSON.stringify({ servers: { z: { url: "https://z" } } }),
    );
    expect(vscode[0]?.path).toBe("servers.z");
  });
  it("routes by file name and renders markdown", () => {
    expect(
      diffPermissionFile("cfg/agentguard.yaml", "mode: dry-run", "mode: enforce"),
    ).toHaveLength(1);
    expect(
      diffPermissionFile(
        ".claude/settings.local.json",
        "{}",
        JSON.stringify({ permissions: { allow: ["x"] } }),
      ),
    ).toHaveLength(1);
    expect(diffPermissionFile("README.md", "a", "b")).toHaveLength(0);
    const md = renderPermissionDiffMarkdown(
      diffPermissionFile("agentguard.yaml", "mode: dry-run", "mode: enforce"),
    );
    expect(md).toContain("1 change widen");
    expect(md).toContain("🔴 widen");
    expect(renderPermissionDiffMarkdown([])).toContain("No permission changes");
  });
});
