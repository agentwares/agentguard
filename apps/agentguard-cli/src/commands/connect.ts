/**
 * `agentguard connect <key>` — point this machine's MCP client at a hosted agentguard proxy.
 *
 * The OSS CLI enforces policy locally and needs no account. The hosted tiers move that
 * enforcement server-side, so "connecting" is not an install: it is resolving a key to the
 * customer's own proxy URL and writing one remote MCP server into the client config.
 *
 * Everything the command prints comes from the server, so the CLI never has to know the
 * shape of a proxy id, a band, or the URL scheme — it stays correct when those change.
 */
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { flagBool, flagString, type ParsedArgs } from "../args.js";
import {
  describeConfigPath,
  detectClientConfigs,
  mergeServerIntoConfig,
  PROXY_SERVER_NAME,
  type ClientConfigFile,
  type ServerEntry,
} from "../configs.js";
import { homeFrom, type Io } from "../context.js";

export const DEFAULT_PROXY_URL = "https://agentwares-agentguard-proxy.vercel.app";

/** What POST /connect answers with. Optional fields are tolerated so an older CLI still works. */
interface ConnectResponse {
  proxyId: string;
  slug: string;
  mode: string;
  mcpUrl: string;
  headers: Record<string, string>;
  upstreams?: string[];
  band?: { tier: string; quantity: number };
  dashboardUrl?: string;
  mcpServers: Record<string, ServerEntry>;
  claudeCode?: string;
}

interface StructuredError {
  code: string;
  cause: string;
  fix?: string;
  retryable?: boolean;
}

function fail(e: StructuredError): never {
  throw e;
}

export async function connectCommand(
  args: ParsedArgs,
  io: Io,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const key = args.positionals[0] ?? io.env.AGENTGUARD_KEY;
  if (!key) {
    io.err("usage: agentguard connect <key> [--write] [--client <path>] [--url <proxy-url>]");
    io.err("  the key is on your dashboard; it starts with agk_");
    return 2;
  }

  const base = (
    flagString(args, "url") ??
    io.env.AGENTGUARD_PROXY_URL ??
    DEFAULT_PROXY_URL
  ).replace(/\/+$/, "");

  let res: Response;
  try {
    res = await fetchImpl(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
  } catch (err) {
    // A network failure is the one retryable case here; everything else is a bad key or a bad URL.
    fail({
      code: "PROXY_UNREACHABLE",
      cause: `could not reach ${base}: ${err instanceof Error ? err.message : String(err)}`,
      fix: "check the network, or pass --url if you run your own proxy",
      retryable: true,
    });
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    fail({
      code: "PROXY_BAD_RESPONSE",
      cause: `${base}/connect returned ${res.status} that was not JSON: ${text.slice(0, 200)}`,
      fix: "check --url points at an agentguard proxy, not at the dashboard",
      retryable: false,
    });
  }
  if (!res.ok) {
    const e = body as Partial<StructuredError>;
    fail({
      code: e.code ?? "CONNECT_REFUSED",
      cause: e.cause ?? `${base}/connect returned ${res.status}`,
      fix: e.fix ?? "check the key on your dashboard; revoked keys stop working immediately",
      retryable: e.retryable ?? false,
    });
  }
  const conn = body as ConnectResponse;

  if (flagBool(args, "json")) {
    io.out(JSON.stringify(conn, null, 2));
    return 0;
  }

  const rel = (p: string) => (p.startsWith(io.cwd + "/") ? relative(io.cwd, p) : p);
  const entry = conn.mcpServers[PROXY_SERVER_NAME] ?? {
    type: "http",
    url: conn.mcpUrl,
    headers: conn.headers,
  };

  if (!flagBool(args, "write")) {
    io.out(JSON.stringify({ mcpServers: { [PROXY_SERVER_NAME]: entry } }, null, 2));
  } else {
    const explicit = flagString(args, "client");
    const configs = explicit
      ? [describeConfigPath(explicit)]
      : detectClientConfigs(io.cwd, homeFrom(io), io.env);
    // Same rule as `init`: a user-level config affects every project on the machine, so it is
    // only written when named explicitly.
    const projectLevel = configs.filter((c) => c.path.startsWith(io.cwd + "/"));
    let chosen: ClientConfigFile[];
    if (explicit || flagBool(args, "all")) chosen = configs;
    else chosen = projectLevel.slice(0, 1);

    if (chosen.length === 0) {
      io.err(
        "no MCP config found here (.mcp.json, .cursor/mcp.json, .vscode/mcp.json). Create one, or paste this into your client:",
      );
      io.out(JSON.stringify({ mcpServers: { [PROXY_SERVER_NAME]: entry } }, null, 2));
      return 1;
    }
    for (const c of chosen) {
      if (!existsSync(c.path)) {
        io.err(`no MCP config at ${c.path}`);
        return 1;
      }
      const { backup, replaced } = mergeServerIntoConfig(c, PROXY_SERVER_NAME, entry);
      io.out(
        `${replaced ? "updated" : "wrote  "} ${rel(c.path)} (${c.label}) → ${PROXY_SERVER_NAME} = ${conn.mcpUrl}`,
      );
      io.out(`backup  ${rel(backup)}`);
    }
    for (const c of configs.filter((c) => !chosen.includes(c)))
      io.out(
        `found   ${c.path} (${c.label}, user-level) — not touched; pass --client ${JSON.stringify(c.path)} to write it too`,
      );
  }

  const band = conn.band ? ` band=${conn.band.tier} (${conn.band.quantity} calls/mo)` : "";
  io.out(`\nproxy ${conn.slug} (${conn.proxyId}) mode=${conn.mode}${band}`);
  if (conn.upstreams?.length) io.out(`upstreams: ${conn.upstreams.join(", ")}`);
  if (conn.dashboardUrl) io.out(`dashboard: ${conn.dashboardUrl}`);
  if (conn.claudeCode) io.out(`claude code: ${conn.claudeCode}`);
  if (!flagBool(args, "write"))
    io.out(`\nrun again with --write to add this to your MCP client config`);
  return 0;
}
