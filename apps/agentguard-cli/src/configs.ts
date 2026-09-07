/**
 * Find the agent's existing MCP config (Claude Code, Claude Desktop, Cursor, VS Code, Windsurf,
 * generic `mcp.json`), read its servers, and rewrite it so every server goes through the proxy.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import type { Upstream } from "@agentwares/agentguard-core";

export type ClientKind =
  | "claude-code-project"
  | "claude-code-user"
  | "claude-desktop"
  | "cursor-project"
  | "cursor-user"
  | "vscode"
  | "windsurf"
  | "generic";

export interface ClientConfigFile {
  kind: ClientKind;
  label: string;
  path: string;
  /** `mcpServers` (most clients) or `servers` (VS Code) */
  serversKey: "mcpServers" | "servers";
}

export interface ServerEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  [k: string]: unknown;
}

export function candidateConfigs(
  cwd: string = process.cwd(),
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): ClientConfigFile[] {
  const desktop =
    platform() === "darwin"
      ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : platform() === "win32"
        ? join(
            env.APPDATA ?? join(home, "AppData", "Roaming"),
            "Claude",
            "claude_desktop_config.json",
          )
        : join(
            env.XDG_CONFIG_HOME ?? join(home, ".config"),
            "Claude",
            "claude_desktop_config.json",
          );
  return [
    {
      kind: "claude-code-project",
      label: "Claude Code (project .mcp.json)",
      path: join(cwd, ".mcp.json"),
      serversKey: "mcpServers",
    },
    {
      kind: "cursor-project",
      label: "Cursor (project)",
      path: join(cwd, ".cursor", "mcp.json"),
      serversKey: "mcpServers",
    },
    {
      kind: "vscode",
      label: "VS Code (project)",
      path: join(cwd, ".vscode", "mcp.json"),
      serversKey: "servers",
    },
    { kind: "generic", label: "mcp.json", path: join(cwd, "mcp.json"), serversKey: "mcpServers" },
    { kind: "claude-desktop", label: "Claude Desktop", path: desktop, serversKey: "mcpServers" },
    {
      kind: "cursor-user",
      label: "Cursor (user)",
      path: join(home, ".cursor", "mcp.json"),
      serversKey: "mcpServers",
    },
    {
      kind: "windsurf",
      label: "Windsurf",
      path: join(home, ".codeium", "windsurf", "mcp_config.json"),
      serversKey: "mcpServers",
    },
    {
      kind: "claude-code-user",
      label: "Claude Code (user ~/.claude.json)",
      path: join(home, ".claude.json"),
      serversKey: "mcpServers",
    },
  ];
}

/** Configs that exist on disk, project-level first. */
export function detectClientConfigs(
  cwd?: string,
  home?: string,
  env?: NodeJS.ProcessEnv,
): ClientConfigFile[] {
  return candidateConfigs(cwd, home, env).filter((c) => existsSync(c.path));
}

/** Describe an explicit path the user passed with `--client`. */
export function describeConfigPath(path: string): ClientConfigFile {
  const abs = resolve(path);
  const known = candidateConfigs().find((c) => c.path === abs);
  if (known) return known;
  let serversKey: "mcpServers" | "servers" = "mcpServers";
  try {
    const parsed = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
    if (parsed.servers && !parsed.mcpServers) serversKey = "servers";
  } catch {
    // unreadable: caller reports
  }
  return {
    kind: abs.includes(".vscode") ? "vscode" : "generic",
    label: abs,
    path: abs,
    serversKey,
  };
}

export function readServers(file: ClientConfigFile): Record<string, ServerEntry> {
  const raw = JSON.parse(readFileSync(file.path, "utf8")) as Record<string, unknown>;
  const servers = raw[file.serversKey];
  if (!servers || typeof servers !== "object") return {};
  return servers as Record<string, ServerEntry>;
}

export const PROXY_SERVER_NAME = "agentguard";

export function isProxyEntry(entry: ServerEntry): boolean {
  return (
    (entry.args ?? []).some((a) => a === "agentguard" || /(^|\/)agentguard(\.js)?$/.test(a)) &&
    (entry.args ?? []).includes("proxy")
  );
}

/** Client servers → policy upstreams. Names are sanitized; secrets stay where they were (in the config). */
export function serversToUpstreams(servers: Record<string, ServerEntry>): {
  upstreams: Upstream[];
  skipped: { name: string; reason: string }[];
} {
  const upstreams: Upstream[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const [rawName, entry] of Object.entries(servers)) {
    if (isProxyEntry(entry)) {
      skipped.push({ name: rawName, reason: "already the agentguard proxy" });
      continue;
    }
    const name =
      rawName.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^[^a-zA-Z0-9]+/, "") || "upstream";
    if (entry.url) {
      upstreams.push({
        name,
        url: entry.url,
        headers: entry.headers ?? {},
        args: [],
        env: {},
        prefix: false,
        timeout_ms: 60_000,
      });
    } else if (entry.command) {
      upstreams.push({
        name,
        command: entry.command,
        args: entry.args ?? [],
        env: entry.env ?? {},
        cwd: entry.cwd,
        headers: {},
        prefix: false,
        timeout_ms: 60_000,
      });
    } else {
      skipped.push({ name: rawName, reason: "no `command` or `url`" });
    }
  }
  return { upstreams, skipped };
}

export function backupPath(file: ClientConfigFile): string {
  return `${file.path}.agentguard-backup`;
}

/** The entry that replaces every server: one proxy, all upstreams behind it. */
export function proxyEntry(
  file: ClientConfigFile,
  policyPath: string,
  opts: { agent?: string } = {},
): ServerEntry {
  const args = ["-y", "agentguard", "proxy", "--config", policyPath];
  if (opts.agent) args.push("--agent", opts.agent);
  const entry: ServerEntry = { command: "npx", args };
  if (file.serversKey === "servers") entry.type = "stdio";
  return entry;
}

/** Back up the file (once) and replace its servers with the single proxy entry. */
export function rewriteClientConfig(
  file: ClientConfigFile,
  policyPath: string,
  opts: { agent?: string } = {},
): { backup: string; replaced: string[] } {
  const raw = JSON.parse(readFileSync(file.path, "utf8")) as Record<string, unknown>;
  const servers = (raw[file.serversKey] as Record<string, ServerEntry> | undefined) ?? {};
  const replaced = Object.keys(servers).filter((n) => !isProxyEntry(servers[n]!));
  const backup = backupPath(file);
  if (!existsSync(backup)) copyFileSync(file.path, backup);
  raw[file.serversKey] = { [PROXY_SERVER_NAME]: proxyEntry(file, policyPath, opts) };
  writeFileSync(file.path, JSON.stringify(raw, null, 2) + "\n");
  return { backup, replaced };
}

/** `agentguard init --undo`: restore the backup. */
export function restoreClientConfig(file: ClientConfigFile): boolean {
  const backup = backupPath(file);
  if (!existsSync(backup)) return false;
  copyFileSync(backup, file.path);
  return true;
}
