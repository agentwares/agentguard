import { PROXY_PACKAGE } from "../configs.js";
/**
 * CLI commands against a temp directory: init (config rewrite + starter policy), report, diff,
 * verify, status, kill/resume, approvals, key create, permission-diff on a fixture git repo.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { parsePolicy } from "@agentwares/agentguard-core";
import { loadPolicyFile } from "@agentwares/agentguard-core/node";
import { main } from "../cli.js";
import { createFileGuard, type Io } from "../context.js";
import { renderStarterPolicy } from "./init.js";
import { runPermissionDiff } from "./permission-diff.js";

let dir: string;
let out: string[];
let err: string[];
let io: Io;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentguard-cli-"));
  out = [];
  err = [];
  io = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, USER: "tester" },
  };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const crmServerPath = fileURLToPath(new URL("../fixtures/crm-server.ts", import.meta.url));
const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));

function writeMcpJson(): void {
  writeFileSync(
    join(dir, ".mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          crm: { command: process.execPath, args: ["--import", tsxLoader, crmServerPath] },
          remote: { url: "https://example.invalid/mcp", headers: { Authorization: "Bearer x" } },
        },
      },
      null,
      2,
    ),
  );
}

describe("init", () => {
  it("writes a dry-run policy from .mcp.json and rewrites the config with a backup", async () => {
    writeMcpJson();
    const codeOut = await main(["init", "--no-probe"], io);
    expect(codeOut).toBe(0);
    const policy = loadPolicyFile(join(dir, "agentguard.yaml"));
    expect(policy.policy.mode).toBe("dry-run");
    expect(policy.policy.upstreams.map((u) => u.name)).toEqual(["crm", "remote"]);
    expect(policy.policy.upstreams[1]).toMatchObject({
      url: "https://example.invalid/mcp",
      headers: { Authorization: "Bearer x" },
    });
    expect(policy.policy.caps.per_run.writes).toBe(50);
    const rewritten = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(Object.keys(rewritten.mcpServers)).toEqual(["agentguard"]);
    expect(rewritten.mcpServers.agentguard).toMatchObject({
      command: "npx",
      // The published name. The unscoped one 404s on npm, so the config it wrote could
      // never start, and the name is unclaimed by anyone else.
      args: ["-y", "@agentwares/agentguard", "proxy", "--config", join(dir, "agentguard.yaml")],
    });
    expect(existsSync(join(dir, ".mcp.json.agentguard-backup"))).toBe(true);
    expect(out.join("\n")).toContain("agentguard report");
    // idempotent
    out = [];
    expect(await main(["init", "--no-probe"], io)).toBe(0);
    expect(out.join("\n")).toContain("already initialized");
    // undo
    expect(await main(["init", "--undo"], io)).toBe(0);
    const restored = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(restored.mcpServers)).toEqual(["crm", "remote"]);
  });

  it("never rewrites user-level configs without --client", async () => {
    mkdirSync(join(dir, ".cursor"));
    writeFileSync(
      join(dir, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { x: { command: "y" } } }),
    );
    const project = join(dir, "proj");
    mkdirSync(project);
    const pio = { ...io, cwd: project };
    expect(await main(["init", "--no-probe"], pio)).toBe(0);
    expect(out.join("\n")).toContain("user-level");
    expect(JSON.parse(readFileSync(join(dir, ".cursor", "mcp.json"), "utf8")).mcpServers.x).toEqual(
      { command: "y" },
    );
    expect(existsSync(join(project, "agentguard.yaml"))).toBe(true);
    out = [];
    expect(
      await main(
        ["init", "--no-probe", "--client", join(dir, ".cursor", "mcp.json"), "--force"],
        pio,
      ),
    ).toBe(0);
    expect(
      Object.keys(JSON.parse(readFileSync(join(dir, ".cursor", "mcp.json"), "utf8")).mcpServers),
    ).toEqual(["agentguard"]);
  });

  it("renders a starter policy that parses and lists destructive tools for approval", () => {
    const text = renderStarterPolicy({
      upstreams: [
        {
          name: "crm",
          command: "npx",
          args: ["x"],
          env: {},
          headers: {},
          prefix: false,
          timeout_ms: 60_000,
        },
      ],
      tools: [
        {
          upstream: "crm",
          name: "crm_delete_contact",
          tool: { name: "crm_delete_contact", inputSchema: { type: "object" } },
          classification: {
            class: "write",
            verb: "delete",
            destructive: true,
            source: "heuristic",
            reason: 'verb "delete"',
          },
        },
        {
          upstream: "crm",
          name: "crm_frobnicate",
          tool: { name: "crm_frobnicate", inputSchema: { type: "object" } },
          classification: {
            class: "unknown",
            verb: "unknown",
            destructive: false,
            source: "none",
            reason: "no verb",
          },
        },
      ],
      generatedAt: new Date("2026-09-02T00:00:00Z"),
    });
    const parsed = parsePolicy(YAML.parse(text));
    expect(parsed.approval.tools).toEqual(["crm_delete_contact"]);
    expect(parsed.classify.write).toEqual(["crm_frobnicate"]);
    expect(parsed.upstreams[0]?.command).toBe("npx");
    expect(text).toContain("generated by `agentguard init` on 2026-09-02");
    expect(parsePolicy(YAML.parse(renderStarterPolicy({ upstreams: [] }))).upstreams).toEqual([]);
  });

  it("probes real upstreams over stdio to classify tools", async () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          crm: { command: process.execPath, args: ["--import", tsxLoader, crmServerPath] },
        },
      }),
    );
    expect(await main(["init"], io)).toBe(0);
    const text = readFileSync(join(dir, "agentguard.yaml"), "utf8");
    expect(text).toContain("crm_delete_contact");
    expect(text).toMatch(/crm_frobnicate\s+unknown/);
    const parsed = loadPolicyFile(join(dir, "agentguard.yaml")).policy;
    expect(parsed.approval.tools).toContain("crm_delete_contact");
    expect(parsed.classify.write).toContain("crm_frobnicate");
  });
});

async function seedAudit(policyText = "mode: dry-run\n"): Promise<void> {
  writeFileSync(join(dir, "agentguard.yaml"), policyText);
  const loaded = loadPolicyFile(join(dir, "agentguard.yaml"));
  const { guard } = createFileGuard(loaded, { alerts: false, env: {} });
  await guard.run(
    { tool: { name: "crm_get_contact" }, args: { id: "c_1" }, runId: "r1" },
    async () => ({}),
  );
  await guard.run(
    { tool: { name: "crm_delete_contact" }, args: { id: "c_1" }, runId: "r1", upstream: "crm" },
    async () => ({}),
  );
  await guard.run(
    { tool: { name: "crm_send_email" }, args: { to: "a@b.c" }, runId: "r1", upstream: "crm" },
    async () => ({}),
  );
}

describe("report / diff / verify / status", () => {
  it("reports the latest run and verifies the chain", async () => {
    await seedAudit();
    expect(await main(["report"], io)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("run `r1`");
    expect(text).toContain("**deleted 1 record**");
    expect(text).toContain("sent 1 message");
    expect(text).toContain("Audit chain: 3 entries, verified");
    out = [];
    expect(await main(["report", "--json"], io)).toBe(0);
    expect(JSON.parse(out.join("\n")).wouldHave.deletes).toBe(1);
    out = [];
    expect(await main(["diff"], io)).toBe(0);
    expect(out.join("\n")).toContain("--- DELETE via crm/crm_delete_contact (id=c_1)");
    out = [];
    expect(await main(["verify"], io)).toBe(0);
    expect(out[0]).toContain("ok: 3 entries");
    const auditPath = join(dir, ".agentguard", "audit.jsonl");
    writeFileSync(auditPath, readFileSync(auditPath, "utf8").replace('"id":"c_1"', '"id":"c_9"'));
    out = [];
    expect(await main(["verify"], io)).toBe(1);
    expect(out[0]).toContain("BROKEN");
  });

  it("status shows caps, kill state and pending approvals", async () => {
    await seedAudit("mode: enforce\ncaps:\n  per_run: { writes: 5 }\n");
    expect(await main(["status"], io)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("mode: enforce");
    expect(text).toContain("kill     off");
    expect(text).toContain("writes 2/5");
  });
});

describe("kill / resume / approvals / keys", () => {
  it("kill writes the file; resume removes it", async () => {
    writeFileSync(join(dir, "agentguard.yaml"), "mode: enforce\n");
    expect(await main(["kill", "prod", "incident"], io)).toBe(0);
    const killFile = join(dir, ".agentguard", "KILL");
    expect(readFileSync(killFile, "utf8")).toContain("prod incident");
    out = [];
    expect(await main(["status"], io)).toBe(0);
    expect(out.join("\n")).toContain("kill     ON");
    expect(await main(["resume"], io)).toBe(0);
    expect(existsSync(killFile)).toBe(false);
  });

  it("approve / deny act on pending approvals created by a guard", async () => {
    writeFileSync(
      join(dir, "agentguard.yaml"),
      "mode: enforce\napproval:\n  tools: [crm_delete_*]\n",
    );
    const loaded = loadPolicyFile(join(dir, "agentguard.yaml"));
    const fg = createFileGuard(loaded, { alerts: false, env: {} });
    const r = await fg.guard.run(
      { tool: { name: "crm_delete_contact" }, args: { id: "c_1" }, runId: "r" },
      async () => ({}),
    );
    const id = (r.error?.details as { approvalId: string }).approvalId;
    expect(await main(["approvals"], io)).toBe(0);
    expect(out.join("\n")).toContain(id);
    out = [];
    expect(await main(["approve", id], io)).toBe(0);
    expect(out[0]).toContain("approved");
    const ok = await createFileGuard(loaded, { alerts: false, env: {} }).guard.run(
      { tool: { name: "crm_delete_contact" }, args: { id: "c_1" }, runId: "r" },
      async () => ({ done: true }),
    );
    expect(ok.ok).toBe(true);
    expect(await main(["approve", "apr_nope"], io)).toBe(1);
  });

  it("key create prints the key once and stores only its hash", async () => {
    writeFileSync(join(dir, "agentguard.yaml"), "# keep me\nmode: enforce\nagents: []\n");
    expect(
      await main(
        [
          "key",
          "create",
          "deployer",
          "--allow",
          "crm_get_*",
          "--allow",
          "crm_list_*",
          "--writes",
          "5",
        ],
        io,
      ),
    ).toBe(0);
    const key = out[0]!;
    expect(key.startsWith("agk_")).toBe(true);
    const text = readFileSync(join(dir, "agentguard.yaml"), "utf8");
    expect(text).toContain("# keep me");
    expect(text).not.toContain(key);
    const policy = loadPolicyFile(join(dir, "agentguard.yaml")).policy;
    expect(policy.agents[0]).toMatchObject({
      name: "deployer",
      allow: ["crm_get_*", "crm_list_*"],
      caps: { per_run: { writes: 5 } },
    });
    expect(policy.agents[0]?.key_hash?.startsWith("sha256:")).toBe(true);
    out = [];
    expect(await main(["key", "list"], io)).toBe(0);
    expect(out[0]).toContain("deployer");
    expect(await main(["key", "revoke", "deployer"], io)).toBe(0);
    expect(loadPolicyFile(join(dir, "agentguard.yaml")).policy.agents).toEqual([]);
  });
});

describe("permission-diff", () => {
  function git(...argv: string[]): string {
    return execFileSync("git", argv, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  }
  it("comments on a fixture PR that widens permissions", async () => {
    git("init", "-q", "-b", "main");
    mkdirSync(join(dir, ".claude"));
    writeFileSync(
      join(dir, "agentguard.yaml"),
      "mode: dry-run\ncaps:\n  per_run: { writes: 50 }\ndeny: [db_drop_*]\n",
    );
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(git:*)"] } }),
    );
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { a: { command: "x" } } }));
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    writeFileSync(
      join(dir, "agentguard.yaml"),
      "mode: enforce\ncaps:\n  per_run: { writes: 500 }\ndeny: []\n",
    );
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Bash(git:*)", "Bash(*)"], defaultMode: "bypassPermissions" },
      }),
    );
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { a: { command: "x" }, shell: { command: "npx", args: ["shell-mcp"] } },
      }),
    );
    git("add", "-A");
    git("commit", "-q", "-m", "widen");
    const result = runPermissionDiff(dir, { base: "main", head: "HEAD" });
    expect(result.files.sort()).toEqual([".claude/settings.json", ".mcp.json", "agentguard.yaml"]);
    const widen = result.findings
      .filter((f) => f.severity === "widen")
      .map((f) => `${f.file}:${f.path}`);
    expect(widen).toEqual(
      expect.arrayContaining([
        "agentguard.yaml:mode",
        "agentguard.yaml:caps.per_run.writes",
        "agentguard.yaml:deny",
        ".claude/settings.json:permissions.allow",
        ".claude/settings.json:permissions.defaultMode",
        ".mcp.json:mcpServers.shell",
      ]),
    );
    expect(result.markdown).toContain("widen what an agent may do");
    expect(
      await main(["permission-diff", "--base", "main", "--head", "HEAD", "--fail-on-widen"], io),
    ).toBe(1);
    expect(out.join("\n")).toContain("🔴 widen");
    out = [];
    expect(await main(["permission-diff", "--base", "HEAD", "--head", "HEAD"], io)).toBe(0);
    expect(out.join("\n")).toContain("No permission changes");
  });
});

describe("the package name written into a user's config", () => {
  it("is this package's own published name", async () => {
    // It said `agentguard`, which is not on npm, so every config init wrote failed to start —
    // and the unscoped name is unclaimed, so whoever registers it gets their code fetched by
    // our onboarding. Pinning it to package.json means it cannot drift again.
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { name: string };
    expect(PROXY_PACKAGE).toBe(pkg.name);
  });
});
