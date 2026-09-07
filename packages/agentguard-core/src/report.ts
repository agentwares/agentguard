/**
 * The incident-shaped report: what this run did, what it would have destroyed or spent, where
 * it was halted — from the audit log alone. Also the mutation diff for `agentguard diff`.
 */
import type { AuditEntry } from "./audit.js";
import type { MutationVerb } from "./classify.js";

export interface RunSummary {
  runId: string;
  agent?: string;
  startedAt: string;
  endedAt: string;
  calls: number;
  writes: number;
  faked: number;
  blocked: number;
  halted: number;
  errors: number;
  usd: number;
  mode: string;
}

export interface Halt {
  seq: number;
  ts: string;
  code: string;
  tool: string;
  cause: string;
}

export interface Report {
  runId?: string;
  runs: RunSummary[];
  entries: number;
  byClass: Record<string, number>;
  byOutcome: Record<string, number>;
  /** dry-run material — what enforce mode would have let through */
  wouldHave: {
    creates: number;
    updates: number;
    deletes: number;
    sends: number;
    executes: number;
    spends: number;
    spendUsd: number;
    mutations: number;
  };
  /** what actually happened upstream */
  did: { writes: number; deletes: number; sends: number; spendUsd: number };
  halts: Halt[];
  topTools: { tool: string; calls: number; class: string }[];
  mutations: AuditEntry[];
  upstreams: string[];
}

export function listRuns(entries: readonly AuditEntry[]): RunSummary[] {
  const byRun = new Map<string, RunSummary>();
  for (const e of entries) {
    const run = byRun.get(e.run_id) ?? {
      runId: e.run_id,
      agent: e.agent,
      startedAt: e.ts,
      endedAt: e.ts,
      calls: 0,
      writes: 0,
      faked: 0,
      blocked: 0,
      halted: 0,
      errors: 0,
      usd: 0,
      mode: e.mode,
    };
    run.calls += 1;
    run.endedAt = e.ts > run.endedAt ? e.ts : run.endedAt;
    run.startedAt = e.ts < run.startedAt ? e.ts : run.startedAt;
    if (e.class === "write" || e.class === "spend") run.writes += 1;
    if (e.outcome === "faked") run.faked += 1;
    if (e.outcome === "blocked" || e.outcome === "pending") run.blocked += 1;
    if (e.outcome === "halted") run.halted += 1;
    if (e.outcome === "error") run.errors += 1;
    if ((e.outcome === "ok" || e.outcome === "faked") && typeof e.usd === "number")
      run.usd = round(run.usd + e.usd);
    byRun.set(e.run_id, run);
  }
  return [...byRun.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function latestRunId(entries: readonly AuditEntry[]): string | undefined {
  return listRuns(entries)[0]?.runId;
}

export function buildReport(all: readonly AuditEntry[], opts: { runId?: string } = {}): Report {
  const runId = opts.runId;
  const entries = runId ? all.filter((e) => e.run_id === runId) : all;
  const byClass: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  const wouldHave = {
    creates: 0,
    updates: 0,
    deletes: 0,
    sends: 0,
    executes: 0,
    spends: 0,
    spendUsd: 0,
    mutations: 0,
  };
  const did = { writes: 0, deletes: 0, sends: 0, spendUsd: 0 };
  const halts: Halt[] = [];
  const tools = new Map<string, { calls: number; class: string }>();
  const mutations: AuditEntry[] = [];
  const upstreams = new Set<string>();

  const bump = (verb: MutationVerb, target: typeof wouldHave): void => {
    if (verb === "create") target.creates += 1;
    else if (verb === "delete") target.deletes += 1;
    else if (verb === "send") target.sends += 1;
    else if (verb === "execute") target.executes += 1;
    else if (verb === "spend") target.spends += 1;
    else target.updates += 1;
  };

  for (const e of entries) {
    byClass[e.class] = (byClass[e.class] ?? 0) + 1;
    byOutcome[e.outcome] = (byOutcome[e.outcome] ?? 0) + 1;
    if (e.upstream) upstreams.add(e.upstream);
    const t = tools.get(e.tool) ?? { calls: 0, class: e.class };
    t.calls += 1;
    tools.set(e.tool, t);
    if (e.outcome === "faked") {
      wouldHave.mutations += 1;
      bump(e.mutation?.verb ?? e.verb, wouldHave);
      if (typeof e.usd === "number") wouldHave.spendUsd = round(wouldHave.spendUsd + e.usd);
      mutations.push(e);
    } else if (e.outcome === "ok" && (e.class === "write" || e.class === "spend")) {
      did.writes += 1;
      if (e.verb === "delete") did.deletes += 1;
      if (e.verb === "send") did.sends += 1;
      if (typeof e.usd === "number") did.spendUsd = round(did.spendUsd + e.usd);
    }
    if (e.outcome === "halted" || e.outcome === "blocked" || e.outcome === "pending") {
      halts.push({
        seq: e.seq,
        ts: e.ts,
        code: e.error?.code ?? e.outcome.toUpperCase(),
        tool: e.tool,
        cause: e.error?.cause ?? e.reason ?? "",
      });
    }
  }
  const topTools = [...tools.entries()]
    .map(([tool, v]) => ({ tool, ...v }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 10);
  return {
    runId,
    runs: listRuns(entries),
    entries: entries.length,
    byClass,
    byOutcome,
    wouldHave,
    did,
    halts,
    topTools,
    mutations,
    upstreams: [...upstreams],
  };
}

export function renderReportMarkdown(report: Report): string {
  const lines: string[] = [];
  const scope = report.runId
    ? `run \`${report.runId}\``
    : `${report.runs.length} run${report.runs.length === 1 ? "" : "s"}`;
  lines.push(`# agentguard report — ${scope}`);
  lines.push("");
  if (report.entries === 0) {
    lines.push("No tool calls recorded. Point your agent at the proxy and run it once.");
    return lines.join("\n");
  }
  const first = report.runs[report.runs.length - 1]!;
  const last = report.runs[0]!;
  lines.push(
    `${report.entries} tool calls between ${first.startedAt} and ${last.endedAt}` +
      (report.upstreams.length ? ` across ${report.upstreams.join(", ")}` : "") +
      ".",
  );
  lines.push("");

  const w = report.wouldHave;
  if (w.mutations > 0) {
    lines.push("## What this run would have done (dry-run, nothing was executed)");
    lines.push("");
    const parts: string[] = [];
    if (w.deletes) parts.push(`**deleted ${w.deletes} record${plural(w.deletes)}**`);
    if (w.updates) parts.push(`updated ${w.updates}`);
    if (w.creates) parts.push(`created ${w.creates}`);
    if (w.sends) parts.push(`sent ${w.sends} message${plural(w.sends)}`);
    if (w.executes) parts.push(`executed ${w.executes} command${plural(w.executes)}`);
    if (w.spendUsd) parts.push(`**spent $${w.spendUsd.toFixed(2)}**`);
    lines.push(`It would have ${parts.join(", ")}.`);
    lines.push("");
    lines.push(
      "Run `agentguard diff` for the record-by-record mutation diff. Flip `mode: enforce` when it looks right.",
    );
    lines.push("");
  }
  const d = report.did;
  if (d.writes > 0) {
    lines.push("## What actually happened upstream");
    lines.push("");
    const parts = [`${d.writes} write${plural(d.writes)}`];
    if (d.deletes) parts.push(`${d.deletes} delete${plural(d.deletes)}`);
    if (d.sends) parts.push(`${d.sends} send${plural(d.sends)}`);
    if (d.spendUsd) parts.push(`$${d.spendUsd.toFixed(2)} spent`);
    lines.push(parts.join(", ") + ".");
    lines.push("");
  }
  if (report.halts.length > 0) {
    lines.push("## Where agentguard stepped in");
    lines.push("");
    lines.push("| # | when | code | tool | why |");
    lines.push("|---|------|------|------|-----|");
    for (const h of report.halts.slice(0, 50)) {
      lines.push(`| ${h.seq} | ${h.ts} | \`${h.code}\` | \`${h.tool}\` | ${escapeCell(h.cause)} |`);
    }
    lines.push("");
  }
  lines.push("## Calls");
  lines.push("");
  lines.push(`By class: ${fmtRecord(report.byClass)}`);
  lines.push(`By outcome: ${fmtRecord(report.byOutcome)}`);
  lines.push("");
  lines.push("| tool | class | calls |");
  lines.push("|------|-------|-------|");
  for (const t of report.topTools) lines.push(`| \`${t.tool}\` | ${t.class} | ${t.calls} |`);
  lines.push("");
  if (!report.runId && report.runs.length > 1) {
    lines.push("## Runs");
    lines.push("");
    lines.push("| run | agent | started | calls | writes | faked | blocked | halted | $ |");
    lines.push("|-----|-------|---------|-------|--------|-------|---------|--------|---|");
    for (const r of report.runs.slice(0, 30)) {
      lines.push(
        `| \`${r.runId}\` | ${r.agent ?? "-"} | ${r.startedAt} | ${r.calls} | ${r.writes} | ${r.faked} | ${r.blocked} | ${r.halted} | ${r.usd.toFixed(2)} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** `agentguard diff`: one block per faked mutation, oldest first. */
export function renderMutationDiff(
  entries: readonly AuditEntry[],
  opts: { runId?: string } = {},
): string {
  const faked = entries.filter(
    (e) => e.outcome === "faked" && (!opts.runId || e.run_id === opts.runId),
  );
  if (faked.length === 0) return "No dry-run mutations recorded.\n";
  const out: string[] = [];
  for (const e of faked) {
    const m = e.mutation ?? { tool: e.tool, verb: e.verb, args: e.args };
    const marker =
      m.verb === "delete"
        ? "-"
        : m.verb === "create"
          ? "+"
          : m.verb === "send"
            ? ">"
            : m.verb === "spend"
              ? "$"
              : "~";
    const header = `${marker}${marker}${marker} ${m.verb.toUpperCase()} via ${e.upstream ? `${e.upstream}/` : ""}${m.tool}${m.target ? ` (${m.target})` : ""}${typeof m.usd === "number" && m.usd > 0 ? ` $${m.usd.toFixed(2)}` : ""}  [#${e.seq} ${e.ts}]`;
    out.push(header);
    const body = JSON.stringify(m.args ?? {}, null, 2).split("\n");
    for (const line of body) out.push(`${marker} ${line}`);
    out.push("");
  }
  const w = buildReport(faked).wouldHave;
  out.push(
    `${faked.length} mutation${plural(faked.length)} would have run: ${w.deletes} delete${plural(w.deletes)}, ${w.updates} update${plural(w.updates)}, ${w.creates} create${plural(w.creates)}, ${w.sends} send${plural(w.sends)}, ${w.executes} execute${plural(w.executes)}${w.spendUsd ? `, $${w.spendUsd.toFixed(2)}` : ""}.`,
  );
  return out.join("\n") + "\n";
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
function fmtRecord(r: Record<string, number>): string {
  return Object.entries(r)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
}
function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 200);
}
