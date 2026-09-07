/**
 * `agentguard permission-diff` — which changes between two git refs widen what an agent may do
 * (agentguard.yaml, .claude/settings.json, mcp.json). The GitHub Action posts the markdown.
 */
import { execFileSync } from "node:child_process";
import {
  diffPermissionFile,
  renderPermissionDiffMarkdown,
  type Finding,
} from "@agentwares/agentguard-core";
import { flagBool, flagList, flagString, type ParsedArgs } from "../args.js";
import type { Io } from "../context.js";

export const DEFAULT_PERMISSION_PATHS = [
  "agentguard.yaml",
  "agentguard.yml",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".mcp.json",
  "mcp.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
];

const PERMISSION_FILE =
  /(^|\/)(agentguard[^/]*\.ya?ml|\.claude\/settings(\.local)?\.json|[^/]*mcp[^/]*\.json|claude_desktop_config\.json)$/;

function git(cwd: string, argv: string[]): string | undefined {
  try {
    return execFileSync("git", argv, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

export function showAt(cwd: string, ref: string, path: string): string | undefined {
  return git(cwd, ["show", `${ref}:${path}`]);
}

export function changedPermissionFiles(cwd: string, base: string, head: string): string[] {
  const out = git(cwd, ["diff", "--name-only", base, head]) ?? "";
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && PERMISSION_FILE.test(l));
}

export function resolveBase(cwd: string, explicit: string | undefined): string {
  if (explicit) return explicit;
  for (const candidate of ["origin/main", "main", "origin/master", "master"]) {
    if (git(cwd, ["rev-parse", "--verify", "--quiet", candidate]) !== undefined) return candidate;
  }
  return "HEAD~1";
}

export interface PermissionDiffResult {
  base: string;
  head: string;
  files: string[];
  findings: Finding[];
  markdown: string;
}

export function runPermissionDiff(
  cwd: string,
  opts: { base?: string; head?: string; paths?: string[]; title?: string },
): PermissionDiffResult {
  const base = resolveBase(cwd, opts.base);
  const head = opts.head ?? "HEAD";
  const files = [
    ...new Set([
      ...(opts.paths ?? DEFAULT_PERMISSION_PATHS),
      ...changedPermissionFiles(cwd, base, head),
    ]),
  ];
  const findings: Finding[] = [];
  const touched: string[] = [];
  for (const file of files) {
    const before = showAt(cwd, base, file);
    const after = showAt(cwd, head, file);
    if (before === undefined && after === undefined) continue;
    if (before === after) continue;
    touched.push(file);
    findings.push(...diffPermissionFile(file, before, after));
  }
  return {
    base,
    head,
    files: touched,
    findings,
    markdown: renderPermissionDiffMarkdown(findings, { title: opts.title }),
  };
}

export async function permissionDiffCommand(args: ParsedArgs, io: Io): Promise<number> {
  const paths = flagList(args, "paths");
  const result = runPermissionDiff(io.cwd, {
    base: flagString(args, "base"),
    head: flagString(args, "head"),
    paths: paths.length ? paths : undefined,
  });
  const format = flagString(args, "format") ?? (flagBool(args, "json") ? "json" : "markdown");
  if (format === "json") io.out(JSON.stringify(result, null, 2));
  else io.out(result.markdown);
  const widen = result.findings.filter((f) => f.severity === "widen").length;
  if (flagBool(args, "fail-on-widen") && widen > 0) return 1;
  return 0;
}
