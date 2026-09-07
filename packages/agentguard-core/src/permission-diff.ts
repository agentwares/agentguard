/**
 * Permission diff for pull requests: which changes to `agentguard.yaml`, `.claude/settings.json`
 * (Claude Code permissions) and `mcp.json` widen what an agent may do. Pure functions over file
 * text; the CLI reads git, the Action posts the markdown.
 */
import YAML from "yaml";

export type Severity = "widen" | "narrow" | "change";

export interface Finding {
  file: string;
  severity: Severity;
  path: string;
  message: string;
  before?: unknown;
  after?: unknown;
}

function parseAny(file: string, text: string | undefined): unknown {
  if (text === undefined || text.trim() === "") return undefined;
  if (/\.ya?ml$/i.test(file)) return YAML.parse(text) ?? {};
  try {
    return JSON.parse(text);
  } catch {
    return YAML.parse(text) ?? {};
  }
}

function get(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function asList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

function listDiff(before: unknown, after: unknown): { added: string[]; removed: string[] } {
  const b = new Set(asList(before));
  const a = new Set(asList(after));
  return { added: [...a].filter((x) => !b.has(x)), removed: [...b].filter((x) => !a.has(x)) };
}

function numberDiff(
  file: string,
  path: string,
  before: unknown,
  after: unknown,
  higherIsWider: boolean,
  out: Finding[],
): void {
  const b = typeof before === "number" ? before : undefined;
  const a = typeof after === "number" ? after : undefined;
  if (b === a) return;
  if (b === undefined && a !== undefined) {
    out.push({ file, severity: "narrow", path, message: `cap added: ${a}`, before: b, after: a });
    return;
  }
  if (a === undefined) {
    out.push({
      file,
      severity: "widen",
      path,
      message: `cap removed (was ${b}) — unlimited`,
      before: b,
      after: a,
    });
    return;
  }
  const wider = higherIsWider ? a > b! : a < b!;
  out.push({
    file,
    severity: wider ? "widen" : "narrow",
    path,
    message: `${b} → ${a}`,
    before: b,
    after: a,
  });
}

/** `agentguard.yaml` — caps, mode, allow/deny, dry-run, approvals, agents, upstreams. */
export function diffAgentguardPolicy(
  file: string,
  beforeText: string | undefined,
  afterText: string | undefined,
): Finding[] {
  const before = parseAny(file, beforeText) ?? {};
  const after = parseAny(file, afterText) ?? {};
  const out: Finding[] = [];

  const modeB = (get(before, ["mode"]) as string | undefined) ?? "dry-run";
  const modeA = (get(after, ["mode"]) as string | undefined) ?? "dry-run";
  if (modeB !== modeA) {
    out.push({
      file,
      severity: modeA === "enforce" ? "widen" : "narrow",
      path: "mode",
      message: `${modeB} → ${modeA}${modeA === "enforce" ? " (writes will really execute)" : ""}`,
      before: modeB,
      after: modeA,
    });
  }
  for (const scope of ["per_run", "per_day"]) {
    const keys = new Set([
      ...Object.keys((get(before, ["caps", scope]) as object) ?? {}),
      ...Object.keys((get(after, ["caps", scope]) as object) ?? {}),
    ]);
    for (const key of keys)
      numberDiff(
        file,
        `caps.${scope}.${key}`,
        get(before, ["caps", scope, key]),
        get(after, ["caps", scope, key]),
        true,
        out,
      );
  }
  for (const [path, widenOnAdd] of [
    [["allow"], true],
    [["deny"], false],
    [["dry_run", "tools"], false],
    [["approval", "tools"], false],
    [["classify", "read"], true],
    [["classify", "write"], false],
    [["classify", "spend"], false],
  ] as const) {
    const { added, removed } = listDiff(get(before, [...path]), get(after, [...path]));
    const label = path.join(".");
    if (added.length)
      out.push({
        file,
        severity: widenOnAdd ? "widen" : "narrow",
        path: label,
        message: `added ${added.map((s) => `\`${s}\``).join(", ")}`,
        after: added,
      });
    if (removed.length)
      out.push({
        file,
        severity: widenOnAdd ? "narrow" : "widen",
        path: label,
        message: `removed ${removed.map((s) => `\`${s}\``).join(", ")}`,
        before: removed,
      });
  }
  const unknownB = (get(before, ["classify", "unknown"]) as string | undefined) ?? "write";
  const unknownA = (get(after, ["classify", "unknown"]) as string | undefined) ?? "write";
  if (unknownB !== unknownA) {
    const rank: Record<string, number> = { block: 0, write: 1, read: 2 };
    out.push({
      file,
      severity: (rank[unknownA] ?? 1) > (rank[unknownB] ?? 1) ? "widen" : "narrow",
      path: "classify.unknown",
      message: `${unknownB} → ${unknownA}`,
      before: unknownB,
      after: unknownA,
    });
  }
  for (const [key, val] of [
    ["window", get(after, ["loop", "window"])],
    ["max_repeats", get(after, ["loop", "max_repeats"])],
    ["max_cycle_len", get(after, ["loop", "max_cycle_len"])],
  ] as const) {
    const b = get(before, ["loop", key]);
    if (typeof val === "number" && typeof b === "number" && val !== b) {
      const wider = key === "window" ? val < b : val > b;
      out.push({
        file,
        severity: wider ? "widen" : "narrow",
        path: `loop.${key}`,
        message: `${b} → ${val}`,
        before: b,
        after: val,
      });
    }
  }
  const upB = new Map(
    ((get(before, ["upstreams"]) as { name?: string }[]) ?? []).map((u) => [u.name ?? "", u]),
  );
  const upA = new Map(
    (
      (get(after, ["upstreams"]) as {
        name?: string;
        url?: string;
        command?: string;
        args?: string[];
      }[]) ?? []
    ).map((u) => [u.name ?? "", u]),
  );
  for (const [name, u] of upA) {
    if (!upB.has(name))
      out.push({
        file,
        severity: "widen",
        path: `upstreams.${name}`,
        message: `new upstream ${u.url ?? [u.command, ...(u.args ?? [])].join(" ")}`,
        after: u,
      });
    else if (JSON.stringify(upB.get(name)) !== JSON.stringify(u))
      out.push({
        file,
        severity: "change",
        path: `upstreams.${name}`,
        message: "upstream changed",
        before: upB.get(name),
        after: u,
      });
  }
  for (const name of upB.keys())
    if (!upA.has(name))
      out.push({
        file,
        severity: "narrow",
        path: `upstreams.${name}`,
        message: "upstream removed",
      });
  const agB = new Map(
    ((get(before, ["agents"]) as { name?: string; allow?: string[]; deny?: string[] }[]) ?? []).map(
      (a) => [a.name ?? "", a],
    ),
  );
  const agA = new Map(
    ((get(after, ["agents"]) as { name?: string; allow?: string[]; deny?: string[] }[]) ?? []).map(
      (a) => [a.name ?? "", a],
    ),
  );
  for (const [name, a] of agA) {
    const b = agB.get(name);
    if (!b) {
      out.push({
        file,
        severity: "change",
        path: `agents.${name}`,
        message: `new agent scope (allow: ${(a.allow ?? []).join(", ") || "all"})`,
        after: a,
      });
      continue;
    }
    const allow = listDiff(b.allow, a.allow);
    const deny = listDiff(b.deny, a.deny);
    if (allow.added.length)
      out.push({
        file,
        severity: "widen",
        path: `agents.${name}.allow`,
        message: `added ${allow.added.join(", ")}`,
        after: allow.added,
      });
    if (allow.removed.length && (a.allow ?? []).length === 0)
      out.push({
        file,
        severity: "widen",
        path: `agents.${name}.allow`,
        message: "allowlist removed — agent may call every tool",
      });
    else if (allow.removed.length)
      out.push({
        file,
        severity: "narrow",
        path: `agents.${name}.allow`,
        message: `removed ${allow.removed.join(", ")}`,
      });
    if (deny.removed.length)
      out.push({
        file,
        severity: "widen",
        path: `agents.${name}.deny`,
        message: `removed ${deny.removed.join(", ")}`,
      });
    if (deny.added.length)
      out.push({
        file,
        severity: "narrow",
        path: `agents.${name}.deny`,
        message: `added ${deny.added.join(", ")}`,
      });
  }
  return out;
}

/** `.claude/settings.json` — `permissions.allow/deny/ask`, `defaultMode`, hooks, MCP servers. */
export function diffClaudeSettings(
  file: string,
  beforeText: string | undefined,
  afterText: string | undefined,
): Finding[] {
  const before = parseAny(file, beforeText) ?? {};
  const after = parseAny(file, afterText) ?? {};
  const out: Finding[] = [];
  for (const [key, widenOnAdd] of [
    ["allow", true],
    ["deny", false],
    ["ask", false],
  ] as const) {
    const { added, removed } = listDiff(
      get(before, ["permissions", key]),
      get(after, ["permissions", key]),
    );
    if (added.length)
      out.push({
        file,
        severity: widenOnAdd ? "widen" : "narrow",
        path: `permissions.${key}`,
        message: `added ${added.map((s) => `\`${s}\``).join(", ")}`,
        after: added,
      });
    if (removed.length)
      out.push({
        file,
        severity: widenOnAdd ? "narrow" : "widen",
        path: `permissions.${key}`,
        message: `removed ${removed.map((s) => `\`${s}\``).join(", ")}`,
        before: removed,
      });
  }
  const modeB = get(before, ["permissions", "defaultMode"]);
  const modeA = get(after, ["permissions", "defaultMode"]);
  if (modeB !== modeA) {
    const rank: Record<string, number> = {
      plan: 0,
      default: 1,
      acceptEdits: 2,
      bypassPermissions: 3,
    };
    const wider = (rank[String(modeA)] ?? 1) > (rank[String(modeB ?? "default")] ?? 1);
    out.push({
      file,
      severity: wider ? "widen" : "narrow",
      path: "permissions.defaultMode",
      message: `${String(modeB ?? "default")} → ${String(modeA ?? "default")}`,
      before: modeB,
      after: modeA,
    });
  }
  const dirs = listDiff(
    get(before, ["permissions", "additionalDirectories"]),
    get(after, ["permissions", "additionalDirectories"]),
  );
  if (dirs.added.length)
    out.push({
      file,
      severity: "widen",
      path: "permissions.additionalDirectories",
      message: `added ${dirs.added.join(", ")}`,
      after: dirs.added,
    });
  const bypassB =
    get(before, ["skipDangerousModePermissionPrompt"]) ??
    get(before, ["dangerouslySkipPermissions"]);
  const bypassA =
    get(after, ["skipDangerousModePermissionPrompt"]) ?? get(after, ["dangerouslySkipPermissions"]);
  if (bypassA === true && bypassB !== true)
    out.push({
      file,
      severity: "widen",
      path: "dangerouslySkipPermissions",
      message: "permission prompts disabled",
      before: bypassB,
      after: bypassA,
    });
  const hooksB = JSON.stringify(get(before, ["hooks"]) ?? {});
  const hooksA = JSON.stringify(get(after, ["hooks"]) ?? {});
  if (hooksB !== hooksA)
    out.push({
      file,
      severity: "change",
      path: "hooks",
      message: "hooks changed (review the commands they run)",
    });
  const serversDiff = diffServers(
    file,
    (get(before, ["mcpServers"]) as Record<string, unknown>) ?? {},
    (get(after, ["mcpServers"]) as Record<string, unknown>) ?? {},
    "mcpServers",
  );
  out.push(...serversDiff);
  const enableB = listDiff(
    get(before, ["enabledMcpjsonServers"]),
    get(after, ["enabledMcpjsonServers"]),
  );
  if (enableB.added.length)
    out.push({
      file,
      severity: "widen",
      path: "enabledMcpjsonServers",
      message: `enabled ${enableB.added.join(", ")}`,
      after: enableB.added,
    });
  return out;
}

function summarizeServer(v: unknown): string {
  if (!v || typeof v !== "object") return String(v);
  const s = v as { url?: string; command?: string; args?: string[]; type?: string };
  if (s.url) return s.url;
  return [s.command, ...(s.args ?? [])].filter(Boolean).join(" ");
}

function diffServers(
  file: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  root: string,
): Finding[] {
  const out: Finding[] = [];
  for (const [name, v] of Object.entries(after)) {
    if (!(name in before))
      out.push({
        file,
        severity: "widen",
        path: `${root}.${name}`,
        message: `new server: \`${summarizeServer(v)}\``,
        after: v,
      });
    else if (summarizeServer(before[name]) !== summarizeServer(v))
      out.push({
        file,
        severity: "change",
        path: `${root}.${name}`,
        message: `\`${summarizeServer(before[name])}\` → \`${summarizeServer(v)}\``,
        before: before[name],
        after: v,
      });
    else {
      const envB = Object.keys((get(before[name], ["env"]) as object) ?? {});
      const envA = Object.keys((get(v, ["env"]) as object) ?? {});
      const added = envA.filter((k) => !envB.includes(k));
      if (added.length)
        out.push({
          file,
          severity: "change",
          path: `${root}.${name}.env`,
          message: `new env: ${added.join(", ")}`,
          after: added,
        });
    }
  }
  for (const name of Object.keys(before))
    if (!(name in after))
      out.push({ file, severity: "narrow", path: `${root}.${name}`, message: "server removed" });
  return out;
}

/** `mcp.json` / `.mcp.json` / `.cursor/mcp.json` / `.vscode/mcp.json`. */
export function diffMcpConfig(
  file: string,
  beforeText: string | undefined,
  afterText: string | undefined,
): Finding[] {
  const before = parseAny(file, beforeText) ?? {};
  const after = parseAny(file, afterText) ?? {};
  const root =
    get(after, ["servers"]) !== undefined || get(before, ["servers"]) !== undefined
      ? "servers"
      : "mcpServers";
  return diffServers(
    file,
    (get(before, [root]) as Record<string, unknown>) ?? {},
    (get(after, [root]) as Record<string, unknown>) ?? {},
    root,
  );
}

/** Pick the right differ by file name. */
export function diffPermissionFile(
  file: string,
  beforeText: string | undefined,
  afterText: string | undefined,
): Finding[] {
  const base = file.split("/").pop() ?? file;
  if (/agentguard.*\.ya?ml$/i.test(base)) return diffAgentguardPolicy(file, beforeText, afterText);
  if (/settings(\.local)?\.json$/i.test(base) && file.includes(".claude"))
    return diffClaudeSettings(file, beforeText, afterText);
  if (/mcp.*\.json$/i.test(base) || base === "claude_desktop_config.json")
    return diffMcpConfig(file, beforeText, afterText);
  return [];
}

export function renderPermissionDiffMarkdown(
  findings: readonly Finding[],
  opts: { title?: string } = {},
): string {
  const widen = findings.filter((f) => f.severity === "widen");
  const lines: string[] = [];
  lines.push(`### ${opts.title ?? "agentguard permission diff"}`);
  lines.push("");
  if (findings.length === 0) {
    lines.push(
      "No permission changes in `agentguard.yaml`, `.claude/settings.json` or MCP configs.",
    );
    return lines.join("\n");
  }
  lines.push(
    widen.length > 0
      ? `**${widen.length} change${widen.length === 1 ? "" : "s"} widen what an agent may do.** Review before merging.`
      : "No change widens agent permissions; the rest are narrowings or neutral changes.",
  );
  lines.push("");
  lines.push("| | file | setting | change |");
  lines.push("|-|------|---------|--------|");
  const icon: Record<Severity, string> = {
    widen: "🔴 widen",
    narrow: "🟢 narrow",
    change: "🟡 change",
  };
  const order: Record<Severity, number> = { widen: 0, change: 1, narrow: 2 };
  for (const f of [...findings].sort((a, b) => order[a.severity] - order[b.severity])) {
    lines.push(
      `| ${icon[f.severity]} | \`${f.file}\` | \`${f.path}\` | ${f.message.replace(/\|/g, "\\|")} |`,
    );
  }
  lines.push("");
  lines.push(
    "<sub>Posted by [agentguard](https://github.com/agentwares/agentguard/tree/main/permission-diff) permission-diff.</sub>",
  );
  return lines.join("\n");
}
