import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../args.js";
import type { Io } from "../context.js";
import { connectCommand } from "./connect.js";

/** The shape POST /connect actually answers with (apps/agentguard-hosted/src/handler.ts). */
const RESPONSE = {
  proxyId: "px_abc123",
  slug: "acme-prod",
  mode: "enforce",
  mcpUrl: "https://proxy.test/px_abc123/mcp",
  headers: { Authorization: "Bearer agk_live_key" },
  upstreams: ["crm", "email"],
  band: { tier: "team", quantity: 100000 },
  dashboardUrl: "https://app.test/dashboard/proxies/px_abc123",
  mcpServers: {
    agentguard: {
      type: "http",
      url: "https://proxy.test/px_abc123/mcp",
      headers: { Authorization: "Bearer agk_live_key" },
    },
  },
  claudeCode: "claude mcp add --transport http agentguard https://proxy.test/px_abc123/mcp",
};

function harness(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    cwd,
    env: { HOME: cwd },
    tty: true,
  };
  return { io, out, err, stdout: () => out.join("\n"), stderr: () => err.join("\n") };
}

function respond(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("connect", () => {
  it("prints the MCP server block without touching any config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-connect-"));
    const configPath = join(dir, ".mcp.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: { crm: { command: "crm-server" } } }));
    const h = harness(dir);

    const code = await connectCommand(
      parseArgs(["connect", "agk_live_key"]),
      h.io,
      respond(RESPONSE),
    );

    expect(code).toBe(0);
    expect(h.stdout()).toContain("https://proxy.test/px_abc123/mcp");
    expect(h.stdout()).toContain("proxy acme-prod (px_abc123) mode=enforce");
    expect(h.stdout()).toContain("band=team");
    // the whole point of omitting --write: the file is untouched
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      mcpServers: { crm: { command: "crm-server" } },
    });
  });

  it("--write adds the proxy alongside the servers already there, and backs the file up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-connect-"));
    const configPath = join(dir, ".mcp.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: { crm: { command: "crm-server" } } }));
    const h = harness(dir);

    const code = await connectCommand(
      parseArgs(["connect", "agk_live_key", "--write"]),
      h.io,
      respond(RESPONSE),
    );

    expect(code).toBe(0);
    const written = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    // connect merges; it must not do what `init` does and replace the list
    expect(Object.keys(written.mcpServers).sort()).toEqual(["agentguard", "crm"]);
    expect(written.mcpServers.agentguard).toEqual(RESPONSE.mcpServers.agentguard);
    expect(JSON.parse(readFileSync(`${configPath}.agentguard-backup`, "utf8"))).toEqual({
      mcpServers: { crm: { command: "crm-server" } },
    });
  });

  it("re-running --write updates the entry in place rather than duplicating it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-connect-"));
    const configPath = join(dir, ".mcp.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
    const h = harness(dir);
    const args = parseArgs(["connect", "agk_live_key", "--write"]);

    await connectCommand(args, h.io, respond(RESPONSE));
    const moved = { ...RESPONSE, mcpUrl: "https://proxy.test/px_abc123/v2/mcp" };
    moved.mcpServers = { agentguard: { ...RESPONSE.mcpServers.agentguard, url: moved.mcpUrl } };
    await connectCommand(args, h.io, respond(moved));

    const written = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: Record<string, { url: string }>;
    };
    expect(Object.keys(written.mcpServers)).toEqual(["agentguard"]);
    expect(written.mcpServers.agentguard!.url).toBe("https://proxy.test/px_abc123/v2/mcp");
    expect(h.stdout()).toContain("updated");
  });

  it("surfaces the server's structured error for a bad key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-connect-"));
    const h = harness(dir);
    await expect(
      connectCommand(
        parseArgs(["connect", "agk_revoked"]),
        h.io,
        respond(
          {
            code: "UNAUTHORIZED",
            cause: "unknown or revoked key",
            fix: "create a new key on your dashboard",
            retryable: false,
          },
          401,
        ),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", retryable: false });
  });

  it("reports an unreachable proxy as retryable, not as a bad key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-connect-"));
    const h = harness(dir);
    const boom = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    await expect(
      connectCommand(parseArgs(["connect", "agk_k", "--url", "https://nope.test"]), h.io, boom),
    ).rejects.toMatchObject({ code: "PROXY_UNREACHABLE", retryable: true });
  });

  it("exits 2 with usage when no key is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-connect-"));
    const h = harness(dir);
    expect(await connectCommand(parseArgs(["connect"]), h.io, respond(RESPONSE))).toBe(2);
    expect(h.stderr()).toContain("usage: agentguard connect <key>");
  });

  it("--write with no MCP config prints the block and exits non-zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-connect-"));
    const h = harness(dir);
    const code = await connectCommand(
      parseArgs(["connect", "agk_live_key", "--write"]),
      h.io,
      respond(RESPONSE),
    );
    expect(code).toBe(1);
    expect(h.stderr()).toContain("no MCP config found here");
    // still useful: the config the user can paste by hand
    expect(h.stdout()).toContain("https://proxy.test/px_abc123/mcp");
  });
});
