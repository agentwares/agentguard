/**
 * `agentguard report` (the incident-shaped summary), `diff` (mutation diff), `verify` (audit
 * chain), `status` (counters and remaining budget).
 */
import { resolve } from "node:path";
import {
  buildReport,
  latestRunId,
  listRuns,
  renderMutationDiff,
  renderReportMarkdown,
} from "@agentwares/agentguard-core";
import { readAuditFile, verifyAuditFile } from "@agentwares/agentguard-core/node";
import { flagBool, flagString, type ParsedArgs } from "../args.js";
import { createFileGuard, loadPolicyFor, readRegistration, type Io } from "../context.js";

function pickRun(args: ParsedArgs, entries: ReturnType<typeof readAuditFile>): string | undefined {
  if (flagBool(args, "all")) return undefined;
  return flagString(args, "run") ?? latestRunId(entries);
}

export async function reportCommand(args: ParsedArgs, io: Io): Promise<number> {
  const loaded = loadPolicyFor(args, io, { allowMissingEnv: true });
  const entries = readAuditFile(loaded.auditPath);
  const runId = pickRun(args, entries);
  const report = buildReport(entries, { runId });
  if (flagBool(args, "json")) {
    io.out(
      JSON.stringify(
        {
          ...report,
          mutations: report.mutations.map((m) => ({
            seq: m.seq,
            ts: m.ts,
            tool: m.tool,
            mutation: m.mutation,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  io.out(renderReportMarkdown(report));
  const chain = await verifyAuditFile(loaded.auditPath);
  io.out(
    chain.ok
      ? `Audit chain: ${chain.entries} entries, verified (${loaded.auditPath}).`
      : `Audit chain BROKEN at entry ${chain.brokenAt}: ${chain.reason}`,
  );
  if (runId && listRuns(entries).length > 1) io.out(`Other runs: agentguard report --all`);
  return 0;
}

export async function diffCommand(args: ParsedArgs, io: Io): Promise<number> {
  const loaded = loadPolicyFor(args, io, { allowMissingEnv: true });
  const entries = readAuditFile(loaded.auditPath);
  const runId = pickRun(args, entries);
  io.out(renderMutationDiff(entries, { runId }).trimEnd());
  return 0;
}

export async function verifyCommand(args: ParsedArgs, io: Io): Promise<number> {
  let path = args.positionals[0];
  if (!path) path = loadPolicyFor(args, io, { allowMissingEnv: true }).auditPath;
  path = resolve(io.cwd, path);
  const result = await verifyAuditFile(path);
  if (flagBool(args, "json")) io.out(JSON.stringify({ path, ...result }));
  else if (result.ok)
    io.out(
      `ok: ${result.entries} entries, chain intact, head ${result.head?.slice(0, 16)}… (${path})`,
    );
  else io.out(`BROKEN at entry ${result.brokenAt}: ${result.reason} (${path})`);
  return result.ok ? 0 : 1;
}

export async function statusCommand(args: ParsedArgs, io: Io): Promise<number> {
  const loaded = loadPolicyFor(args, io, { allowMissingEnv: true });
  const { guard, kill } = createFileGuard(loaded, { alerts: false, env: io.env });
  const entries = readAuditFile(loaded.auditPath);
  const runId = flagString(args, "run") ?? latestRunId(entries) ?? "(none yet)";
  const status = await guard.status(runId);
  const killed = kill.check();
  const reg = readRegistration(loaded);
  const pending = await guard.approvals.list("pending");
  if (flagBool(args, "json")) {
    io.out(
      JSON.stringify(
        {
          policy: loaded.path,
          mode: loaded.policy.mode,
          runId,
          ...status,
          killed,
          pendingApprovals: pending.length,
          http: reg ? { url: reg.url, pid: reg.pid } : undefined,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  io.out(
    `policy   ${loaded.path} (mode: ${loaded.policy.mode}, ${loaded.policy.upstreams.length} upstreams)`,
  );
  io.out(
    `kill     ${killed.killed ? `ON — ${killed.reason} (agentguard resume to clear)` : "off"}`,
  );
  io.out(
    `http     ${reg ? `${reg.url} (pid ${reg.pid})` : "not running (agentguard proxy --http)"}`,
  );
  io.out(`audit    ${entries.length} entries in ${loaded.auditPath}`);
  io.out(
    `pending  ${pending.length} approval${pending.length === 1 ? "" : "s"}${pending.length ? ` — agentguard approvals` : ""}`,
  );
  io.out(`run      ${runId}`);
  const fmt = (scope: "per_run" | "per_day"): string =>
    Object.entries(status.caps[scope])
      .map(([k, limit]) => `${k} ${status.usage[scope][k] ?? 0}/${limit}`)
      .join("  ") || "no caps";
  io.out(`  per_run  ${fmt("per_run")}`);
  io.out(`  per_day  ${fmt("per_day")}`);
  return 0;
}
