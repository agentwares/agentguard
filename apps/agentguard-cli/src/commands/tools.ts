/**
 * `agentguard tools` — connect to every upstream and print the tools the agent will see,
 * with their class and why. Also the probe `init` uses to seed the policy.
 */
import {
  Guard,
  classifyTool,
  parsePolicy,
  type Classification,
  type Policy,
  type Upstream,
} from "@agentwares/agentguard-core";
import type { LoadedPolicy } from "@agentwares/agentguard-core/node";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ProxyRuntime } from "../proxy/runtime.js";
import { loadPolicyFor, type Io } from "../context.js";
import type { ParsedArgs } from "../args.js";
import { flagBool } from "../args.js";

export interface ProbedTool {
  upstream: string;
  name: string;
  tool: Tool;
  classification: Classification;
}

export interface ProbeResult {
  tools: ProbedTool[];
  upstreams: { name: string; connected: boolean; tools: number; error?: string }[];
}

/** Connect to the upstreams (with a policy for classification), list tools, disconnect. */
export async function probeUpstreams(
  upstreams: Upstream[],
  opts: {
    policy?: Policy;
    timeoutMs?: number;
    log?: (l: string) => void;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ProbeResult> {
  const policy = opts.policy ?? parsePolicy({ upstreams });
  const loaded: LoadedPolicy = {
    policy: { ...policy, upstreams },
    path: "",
    baseDir: process.cwd(),
    stateDir: "",
    auditPath: "",
    killPath: "",
  };
  const guard = new Guard({ policy: loaded.policy, env: opts.env ?? {} });
  const runtime = new ProxyRuntime({
    loaded,
    guard,
    defaultRunId: "probe",
    log: opts.log ?? (() => undefined),
    connectTimeoutMs: opts.timeoutMs ?? 15_000,
  });
  try {
    await runtime.start();
    return {
      tools: runtime.listTools().map((t) => ({
        upstream: t.upstream,
        name: t.name,
        tool: t.tool,
        classification: classifyTool(
          { name: t.name, annotations: t.tool.annotations },
          loaded.policy,
        ),
      })),
      upstreams: runtime.upstreamStatus(),
    };
  } finally {
    await runtime.close();
  }
}

export function formatToolTable(tools: ProbedTool[]): string[] {
  const width = Math.min(48, Math.max(12, ...tools.map((t) => t.name.length)));
  const lines = [
    `${"tool".padEnd(width)}  ${"class".padEnd(8)}${"verb".padEnd(9)}${"upstream".padEnd(14)}why`,
  ];
  for (const t of tools) {
    const c = t.classification;
    lines.push(
      `${t.name.padEnd(width)}  ${c.class.padEnd(8)}${c.verb.padEnd(9)}${t.upstream.padEnd(14)}${c.source}: ${c.reason}`,
    );
  }
  return lines;
}

export async function toolsCommand(args: ParsedArgs, io: Io): Promise<number> {
  const loaded = loadPolicyFor(args, io);
  const result = await probeUpstreams(loaded.policy.upstreams, {
    policy: loaded.policy,
    log: io.err,
    env: io.env,
  });
  if (flagBool(args, "json")) {
    io.out(
      JSON.stringify(
        {
          upstreams: result.upstreams,
          tools: result.tools.map((t) => ({
            name: t.name,
            upstream: t.upstream,
            ...t.classification,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  for (const u of result.upstreams)
    io.err(
      `${u.connected ? "ok  " : "down"} ${u.name}: ${u.connected ? `${u.tools} tools` : u.error}`,
    );
  for (const line of formatToolTable(result.tools)) io.out(line);
  const counts = result.tools.reduce<Record<string, number>>(
    (acc, t) => ({ ...acc, [t.classification.class]: (acc[t.classification.class] ?? 0) + 1 }),
    {},
  );
  io.err(
    `\n${result.tools.length} tools: ${Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ")} · mode ${loaded.policy.mode}`,
  );
  return result.upstreams.every((u) => u.connected) ? 0 : 2;
}
