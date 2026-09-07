/**
 * The real thing: `agentguard proxy` spawned as a child over stdio (what Claude Code / Cursor do),
 * and `--http` with X-Run-Id, scoped agent keys and the control endpoints.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { generateAgentKey, hashAgentKey } from "@agentwares/agentguard-core";
import { readAuditFile, verifyAuditFile } from "@agentwares/agentguard-core/node";
import type { HttpRegistration } from "./http.js";

const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const crm = fileURLToPath(new URL("../fixtures/crm-server.ts", import.meta.url));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function policyYaml(extra = ""): string {
  return `mode: enforce
upstreams:
  - name: crm
    command: ${JSON.stringify(process.execPath)}
    args: ["--import", ${JSON.stringify(tsxLoader)}, ${JSON.stringify(crm)}]
caps:
  per_run: { writes: 3 }
loop: { max_repeats: 3 }
${extra}`;
}

function tempPolicy(extra?: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-e2e-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "agentguard.yaml");
  writeFileSync(path, policyYaml(extra));
  return { dir, path };
}

const code = (r: CallToolResult): string | undefined => {
  try {
    return (JSON.parse(r.content.find((c) => c.type === "text")?.text ?? "{}") as { code?: string })
      .code;
  } catch {
    return undefined;
  }
};

describe("proxy over stdio (spawned)", () => {
  it("serves upstream tools through the policy and writes a verifiable audit file", async () => {
    const { dir, path } = tempPolicy();
    const client = new Client({ name: "e2e", version: "0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", tsxLoader, cli, "proxy", "--config", path, "--run-id", "stdio_run"],
      stderr: "pipe",
    });
    cleanups.push(() => client.close());
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("crm_delete_contact");
    const get = (await client.callTool({
      name: "crm_get_contact",
      arguments: { id: "c_1" },
    })) as CallToolResult;
    expect(get.isError).toBeFalsy();
    const codes: (string | undefined)[] = [];
    for (let i = 0; i < 4; i += 1) {
      const r = (await client.callTool({
        name: "crm_create_contact",
        arguments: { name: `n${i}`, email: `n${i}@x` },
      })) as CallToolResult;
      codes.push(r.isError ? code(r) : "ok");
    }
    expect(codes).toEqual(["ok", "ok", "ok", "CAP_EXCEEDED"]);
    await client.close();
    await new Promise((r) => setTimeout(r, 200));
    const audit = join(dir, ".agentguard", "audit.jsonl");
    const entries = readAuditFile(audit);
    expect(entries.map((e) => e.run_id)).toEqual(Array(5).fill("stdio_run"));
    expect(entries.map((e) => e.outcome)).toEqual(["ok", "ok", "ok", "ok", "blocked"]);
    expect((await verifyAuditFile(audit)).ok).toBe(true);
  });

  it("serves MCP when spawned bare, the way server.json registers it (`npx @agentwares/agentguard`)", async () => {
    // The registry entry carries no package arguments, so a client spawns the bin with none. With
    // stdout piped that has to be the proxy, not the help text (an interactive TTY still gets help).
    const { path } = tempPolicy();
    const client = new Client({ name: "e2e-bare", version: "0" });
    cleanups.push(() => client.close());
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", tsxLoader, cli],
        env: { ...(process.env as Record<string, string>), AGENTGUARD_CONFIG: path },
        stderr: "pipe",
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("crm_delete_contact");
  });
});

async function waitFor<T>(fn: () => T | undefined, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}

function startHttp(
  path: string,
  dir: string,
): Promise<{ child: ChildProcess; reg: HttpRegistration; stderr: string[] }> {
  const stderr: string[] = [];
  const child = spawn(
    process.execPath,
    ["--import", tsxLoader, cli, "proxy", "--config", path, "--http", "--port", "0"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr?.on("data", (d: Buffer) => stderr.push(d.toString()));
  cleanups.push(() => {
    child.kill("SIGTERM");
  });
  return waitFor(() => {
    const f = join(dir, ".agentguard", "http.json");
    if (!existsSync(f)) return undefined;
    try {
      return { child, reg: JSON.parse(readFileSync(f, "utf8")) as HttpRegistration, stderr };
    } catch {
      return undefined;
    }
  });
}

describe("proxy over Streamable HTTP", () => {
  it("X-Run-Id scopes runs, scoped keys restrict tools, /kill and /approve work", async () => {
    const key = generateAgentKey();
    const hash = await hashAgentKey(key);
    const { dir, path } = tempPolicy(
      `approval: { tools: [crm_delete_*] }\nagents:\n  - name: reader\n    key_hash: ${hash}\n    allow: [crm_get_*, crm_list_*]\n`,
    );
    const { reg } = await startHttp(path, dir);
    expect(reg.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const health = (await (await fetch(`${reg.baseUrl}/health`)).json()) as {
      ok: boolean;
      upstreams: { connected: boolean }[];
      tools: number;
    };
    expect(health.ok).toBe(true);
    expect(health.upstreams[0]?.connected).toBe(true);
    expect(health.tools).toBeGreaterThan(5);

    const connect = async (headers: Record<string, string>): Promise<Client> => {
      const c = new Client({ name: "http-agent", version: "0" });
      await c.connect(
        new StreamableHTTPClientTransport(new URL(reg.url), { requestInit: { headers } }),
      );
      cleanups.push(() => c.close());
      return c;
    };
    const a = await connect({ "X-Run-Id": "run_A" });
    const b = await connect({ "X-Run-Id": "run_B" });
    for (let i = 0; i < 3; i += 1)
      expect(
        (
          (await a.callTool({
            name: "crm_create_contact",
            arguments: { name: `a${i}`, email: "a@x" },
          })) as CallToolResult
        ).isError,
      ).toBeFalsy();
    expect(
      code(
        (await a.callTool({
          name: "crm_create_contact",
          arguments: { name: "a4", email: "a@x" },
        })) as CallToolResult,
      ),
    ).toBe("CAP_EXCEEDED");
    expect(
      (
        (await b.callTool({
          name: "crm_create_contact",
          arguments: { name: "b0", email: "b@x" },
        })) as CallToolResult
      ).isError,
    ).toBeFalsy();

    const scoped = await connect({ Authorization: `Bearer ${key}`, "X-Run-Id": "run_scoped" });
    const { tools } = await scoped.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(
      code(
        (await scoped.callTool({
          name: "crm_create_contact",
          arguments: { name: "z", email: "z@x" },
        })) as CallToolResult,
      ),
    ).toBe("TOOL_DENIED");
    expect(
      (
        (await scoped.callTool({
          name: "crm_get_contact",
          arguments: { id: "c_1" },
        })) as CallToolResult
      ).isError,
    ).toBeFalsy();
    const badKey = await connect({ Authorization: "Bearer agk_not_a_real_key" });
    expect(
      code(
        (await badKey.callTool({
          name: "crm_get_contact",
          arguments: { id: "c_1" },
        })) as CallToolResult,
      ),
    ).toBe("TOOL_DENIED");

    const pending = (await b.callTool({
      name: "crm_delete_contact",
      arguments: { id: "c_3" },
    })) as CallToolResult;
    const first = pending.content[0];
    const body = JSON.parse(first?.type === "text" ? first.text : "{}") as {
      code: string;
      details: { approvalId: string; url?: string };
    };
    expect(body.code).toBe("APPROVAL_REQUIRED");
    expect(body.details.url).toBe(
      `${reg.baseUrl}/approve/${body.details.approvalId}?token=${reg.token}`,
    );
    expect(
      (await fetch(`${reg.baseUrl}/approve/${body.details.approvalId}`, { method: "POST" })).status,
    ).toBe(401);
    const approved = (await (await fetch(body.details.url!, { method: "POST" })).json()) as {
      status: string;
    };
    expect(approved.status).toBe("approved");
    expect(
      (
        (await b.callTool({
          name: "crm_delete_contact",
          arguments: { id: "c_3" },
        })) as CallToolResult
      ).isError,
    ).toBeFalsy();

    expect(
      (
        await fetch(`${reg.baseUrl}/kill`, {
          method: "POST",
          headers: { Authorization: `Bearer ${reg.token}` },
          body: JSON.stringify({ reason: "e2e" }),
        })
      ).status,
    ).toBe(200);
    expect(existsSync(join(dir, ".agentguard", "KILL"))).toBe(true);
    expect(
      code(
        (await a.callTool({ name: "crm_get_contact", arguments: { id: "c_1" } })) as CallToolResult,
      ),
    ).toBe("KILLED");
    expect(
      (await fetch(`${reg.baseUrl}/resume?token=${reg.token}`, { method: "POST" })).status,
    ).toBe(200);
    expect(
      ((await a.callTool({ name: "crm_get_contact", arguments: { id: "c_1" } })) as CallToolResult)
        .isError,
    ).toBeFalsy();

    const status = (await (
      await fetch(`${reg.baseUrl}/status?run=run_A&token=${reg.token}`)
    ).json()) as { usage: { per_run: { writes: number } } };
    expect(status.usage.per_run.writes).toBe(3);
  });
});
