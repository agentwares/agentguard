import { describe, expect, it } from "vitest";
import { Guard } from "./guard.js";
import { parsePolicy } from "./policy.js";
import {
  buildReport,
  latestRunId,
  listRuns,
  renderMutationDiff,
  renderReportMarkdown,
} from "./report.js";

async function sampleEntries() {
  const guard = new Guard({
    policy: parsePolicy({
      mode: "dry-run",
      caps: { per_run: { writes: 3 } },
      spend: { tools: { stripe_charge: { amount_arg: "usd" } } },
    }),
    env: {},
  });
  await guard.run(
    { tool: { name: "crm_get_contact" }, args: { id: 1 }, runId: "run_a" },
    async () => ({}),
  );
  await guard.run(
    { tool: { name: "crm_delete_contact" }, args: { id: "c_1" }, runId: "run_a", upstream: "crm" },
    async () => ({}),
  );
  await guard.run(
    {
      tool: { name: "crm_update_contact" },
      args: { id: "c_2", name: "x" },
      runId: "run_a",
      upstream: "crm",
    },
    async () => ({}),
  );
  await guard.run(
    { tool: { name: "stripe_charge" }, args: { usd: 40 }, runId: "run_a", upstream: "stripe" },
    async () => ({}),
  );
  await guard.run(
    { tool: { name: "email_send" }, args: { to: "a@b.c" }, runId: "run_a" },
    async () => ({}),
  );
  await guard.run(
    { tool: { name: "crm_get_contact" }, args: { id: 2 }, runId: "run_b" },
    async () => ({}),
  );
  return guard.audit.read();
}

describe("report", () => {
  it("summarizes what a dry run would have done", async () => {
    const entries = await sampleEntries();
    expect(listRuns(entries).map((r) => r.runId)).toEqual(["run_b", "run_a"]);
    expect(latestRunId(entries)).toBe("run_b");
    const report = buildReport(entries, { runId: "run_a" });
    expect(report.wouldHave).toMatchObject({ deletes: 1, updates: 1, mutations: 3, spendUsd: 40 });
    expect(report.halts.map((h) => h.code)).toEqual(["CAP_EXCEEDED"]);
    expect(report.byOutcome).toEqual({ ok: 1, faked: 3, blocked: 1 });
    const md = renderReportMarkdown(report);
    expect(md).toContain("**deleted 1 record**");
    expect(md).toContain("**spent $40.00**");
    expect(md).toContain("CAP_EXCEEDED");
    expect(md).toContain("crm_delete_contact");
    expect(renderReportMarkdown(buildReport([]))).toContain("No tool calls recorded");
  });
  it("renders a mutation diff", async () => {
    const entries = await sampleEntries();
    const diff = renderMutationDiff(entries, { runId: "run_a" });
    expect(diff).toContain("--- DELETE via crm/crm_delete_contact (id=c_1)");
    expect(diff).toContain("~~~ UPDATE via crm/crm_update_contact (id=c_2)");
    expect(diff).toContain("$$$ SPEND via stripe/stripe_charge");
    expect(diff).toContain("3 mutations would have run: 1 delete, 1 update");
    expect(renderMutationDiff([])).toContain("No dry-run mutations");
  });
});
