#!/usr/bin/env node
/**
 * A scripted "agent" that misbehaves on purpose: reads, then writes, then loops, then bursts
 * writes past the cap. Run it against the proxy to see dry-run diffs, LOOP_DETECTED and
 * CAP_EXCEEDED in `agentguard report`.
 *
 *   node dist/fixtures/demo-agent.js --config agentguard.yaml   # spawns `agentguard proxy` over stdio
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface DemoStep {
  step: string;
  tool: string;
  ok: boolean;
  code?: string;
  dryRun?: boolean;
  text?: string;
}

export interface DemoOptions {
  /** how many writes to burst at the end (default 60 — past a `writes: 50` cap) */
  burst?: number;
  /** how many times to repeat the identical update (default 5 — past `max_repeats: 3`) */
  loop?: number;
  runId?: string;
  log?: (line: string) => void;
}

function summarize(result: CallToolResult): {
  ok: boolean;
  code?: string;
  dryRun?: boolean;
  text?: string;
} {
  const text = result.content.find((c) => c.type === "text")?.text;
  const meta = (result._meta as { agentguard?: { dryRun?: boolean } } | undefined)?.agentguard;
  if (result.isError) {
    let code: string | undefined;
    try {
      code = (JSON.parse(text ?? "{}") as { code?: string }).code;
    } catch {
      // not JSON
    }
    return { ok: false, code, text };
  }
  return { ok: true, dryRun: meta?.dryRun, text };
}

/** Drive a connected client through the scripted scenario. Returns every step's outcome. */
export async function runDemoAgent(client: Client, opts: DemoOptions = {}): Promise<DemoStep[]> {
  const steps: DemoStep[] = [];
  const log = opts.log ?? (() => undefined);
  const meta = opts.runId ? { runId: opts.runId } : undefined;
  const call = async (
    step: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<DemoStep> => {
    const result = (await client.callTool({
      name: tool,
      arguments: args,
      _meta: meta,
    })) as CallToolResult;
    const s = { step, tool, ...summarize(result) };
    steps.push(s);
    log(
      `${s.ok ? (s.dryRun ? "faked " : "ok    ") : `${s.code ?? "error"}`.padEnd(6)} ${step}: ${tool}`,
    );
    return s;
  };

  await call("read: list contacts", "crm_list_contacts", { limit: 10 });
  await call("read: get one", "crm_get_contact", { id: "c_1" });
  await call("write: create", "crm_create_contact", {
    name: "Demo Person",
    email: "demo@example.com",
  });
  await call("write: update", "crm_update_contact", { id: "c_1", fields: { name: "Ada L." } });
  await call("write: delete (destructive)", "crm_delete_contact", { id: "c_2" });
  await call("write: send email", "crm_send_email", {
    to: "ada@example.com",
    subject: "Hi",
    body: "Hello from the demo agent",
  });
  await call("spend: charge $12", "crm_charge_card", {
    customer_id: "c_1",
    amount_cents: 1200,
    currency: "usd",
  });

  const loops = opts.loop ?? 5;
  for (let i = 0; i < loops; i += 1) {
    const s = await call(`loop ${i + 1}/${loops}: identical update`, "crm_update_contact", {
      id: "c_3",
      fields: { name: "Same Thing" },
    });
    if (s.code === "LOOP_DETECTED") break;
  }

  const burst = opts.burst ?? 60;
  for (let i = 0; i < burst; i += 1) {
    const s = await call(`burst ${i + 1}/${burst}: create`, "crm_create_contact", {
      name: `Bulk ${i}`,
      email: `bulk${i}@example.com`,
    });
    if (s.code === "CAP_EXCEEDED") break;
  }
  return steps;
}

const isMain = process.argv[1] !== undefined && /demo-agent\.[cm]?[jt]s$/.test(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = arg("--url");
  const config = arg("--config") ?? "agentguard.yaml";
  const client = new Client({ name: "agentguard-demo-agent", version: "0.1.0" });
  if (url) {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: {
          headers: { "X-Run-Id": arg("--run-id") ?? `demo_${Date.now().toString(36)}` },
        },
      }),
    );
  } else {
    const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../cli.js");
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "proxy", "--config", config],
        stderr: "inherit",
      }),
    );
  }
  try {
    const steps = await runDemoAgent(client, {
      log: (l) => console.log(l),
      runId: arg("--run-id"),
    });
    const halts = steps.filter((s) => !s.ok).map((s) => s.code);
    console.log(
      `\n${steps.length} calls; halts: ${halts.join(", ") || "none"}. Now run: agentguard report`,
    );
  } finally {
    await client.close();
  }
}
