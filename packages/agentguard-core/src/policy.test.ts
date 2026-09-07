import { describe, expect, it } from "vitest";
import {
  defaultPolicy,
  effectiveCaps,
  loadPolicyFromYaml,
  parsePolicy,
  substituteEnv,
  upstreamHeaders,
} from "./policy.js";

describe("policy", () => {
  it("fills defaults for an empty file", () => {
    const p = loadPolicyFromYaml("");
    expect(p.mode).toBe("dry-run");
    expect(p.loop.max_repeats).toBe(3);
    expect(p.classify.unknown).toBe("write");
    expect(p.kill.file).toBe(".agentguard/KILL");
    expect(defaultPolicy().audit.path).toBe(".agentguard/audit.jsonl");
  });

  it("parses the documented example", () => {
    const p = loadPolicyFromYaml(
      `
version: 1
mode: enforce
upstreams:
  - name: crm
    url: https://mcp.example.com/mcp
    auth: \${CRM_TOKEN}
classify:
  write: [crm_update_*, crm_delete_*, email_send]
  spend: [stripe_*, x402_*]
caps:
  per_run: { writes: 50, emails: 5, spend_usd: 25, tool_calls: 400 }
  per_day: { spend_usd: 200 }
loop: { window: 30, max_repeats: 3, max_cycle_len: 4 }
dry_run: { tools: [crm_delete_*], synthesize: true }
approval: { tools: [crm_delete_*], wait_s: 0 }
agents:
  - name: deployer
    key_hash: sha256:abc
    allow: [crm_get_*]
    caps: { per_run: { writes: 5 } }
`,
      { env: { CRM_TOKEN: "tok_123" } },
    );
    expect(p.mode).toBe("enforce");
    expect(p.upstreams[0]?.auth).toBe("tok_123");
    expect(upstreamHeaders(p.upstreams[0]!)).toEqual({ Authorization: "Bearer tok_123" });
    expect(p.caps.per_run.writes).toBe(50);
    expect(effectiveCaps(p, p.agents[0]).per_run).toEqual({
      writes: 5,
      emails: 5,
      spend_usd: 25,
      tool_calls: 400,
    });
    expect(effectiveCaps(p, p.agents[0]).per_day).toEqual({ spend_usd: 200 });
  });

  it("names missing env vars", () => {
    expect(() =>
      loadPolicyFromYaml("alerts:\n  slack: ${SLACK_WEBHOOK}\n", { env: {} }),
    ).toThrowError(/SLACK_WEBHOOK/);
    const p = loadPolicyFromYaml("alerts:\n  slack: ${SLACK_WEBHOOK}\n", {
      env: {},
      allowMissingEnv: true,
    });
    expect(p.alerts.slack).toBe("");
    expect(substituteEnv("${A:-x}", {}).value).toBe("x");
  });

  it("rejects invalid shapes with a field path", () => {
    expect(() => parsePolicy({ mode: "yolo" })).toThrowError(/mode/);
    expect(() => parsePolicy({ upstreams: [{ name: "a" }] })).toThrowError(
      /url.*command|command|url/,
    );
    expect(() =>
      parsePolicy({
        upstreams: [
          { name: "a", command: "x" },
          { name: "a", url: "https://x" },
        ],
      }),
    ).toThrowError(/duplicate/);
    expect(() => loadPolicyFromYaml("mode: [")).toThrowError(/YAML/);
  });
});
