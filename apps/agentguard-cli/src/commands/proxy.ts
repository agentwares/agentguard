/**
 * `agentguard proxy` — stdio by default (what MCP clients spawn), `--http` for Streamable HTTP
 * with the control endpoints. Logs go to stderr only; stdout is the MCP channel.
 */
import { serveStdio } from "@agentwares/mcp-kit";
import { resolveAgent } from "@agentwares/agentguard-core";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "../args.js";
import { createFileGuard, loadPolicyFor, type Io } from "../context.js";
import { startHttpProxy } from "../proxy/http.js";
import { ProxyRuntime } from "../proxy/runtime.js";
import { createDownstreamServer } from "../proxy/server.js";

export function newRunId(now: Date = new Date()): string {
  return `run_${now
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}`;
}

export async function proxyCommand(args: ParsedArgs, io: Io): Promise<number> {
  const loaded = loadPolicyFor(args, io);
  const log = (line: string): void => io.err(`[agentguard] ${line}`);
  const modeOverride = flagString(args, "mode");
  if (modeOverride === "dry-run" || modeOverride === "enforce") loaded.policy.mode = modeOverride;

  const agentName = flagString(args, "agent");
  let agent = undefined;
  if (agentName) {
    const resolved = await resolveAgent(loaded.policy, { name: agentName });
    if (resolved.error) {
      io.err(
        `unknown agent "${agentName}" — agents in agentguard.yaml: ${loaded.policy.agents.map((a) => a.name).join(", ") || "none"}`,
      );
      return 1;
    }
    agent = resolved.agent;
  }

  const http = flagBool(args, "http") === true;
  let approvalBase: { baseUrl: string; token: string } | undefined;
  const fileGuard = createFileGuard(loaded, {
    log,
    env: io.env,
    approvalUrl: (r) =>
      approvalBase
        ? `${approvalBase.baseUrl}/approve/${r.id}?token=${approvalBase.token}`
        : undefined,
    onEvent: (e) => {
      if (e.type === "APPROVAL_DECIDED") return;
      log(`${e.type} ${e.tool} (run ${e.runId})${e.error ? `: ${e.error.cause}` : ""}`);
      if (e.type === "APPROVAL_REQUIRED" && e.approval)
        log(`approve with: agentguard approve ${e.approval.id}`);
    },
  });
  const runtime = new ProxyRuntime({
    loaded,
    guard: fileGuard.guard,
    agent,
    defaultRunId: flagString(args, "run-id") ?? newRunId(),
    log,
  });
  await runtime.start();
  const killed = await fileGuard.kill.check();
  if (killed.killed)
    log(
      `kill switch is ON (${killed.reason}); every call returns KILLED until \`agentguard resume\``,
    );

  if (http) {
    const server = await startHttpProxy({
      runtime,
      port: flagNumber(args, "port") ?? 8788,
      host: flagString(args, "host") ?? "127.0.0.1",
      token: io.env.AGENTGUARD_HTTP_TOKEN,
    });
    approvalBase = { baseUrl: server.url.replace(/\/mcp$/, ""), token: server.token };
    log(
      `Streamable HTTP at ${server.url} · GET ${approvalBase.baseUrl}/health · control token in ${loaded.stateDir}/http.json`,
    );
    log(
      `point your agent at ${server.url} (send X-Run-Id per run; Authorization: Bearer <agent key> for scoped agents)`,
    );
    const stop = async (): Promise<void> => {
      await server.close();
      await runtime.close();
      process.exit(0);
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    await new Promise<never>(() => undefined);
  }

  const server = createDownstreamServer(runtime);
  const stop = async (): Promise<void> => {
    await runtime.close();
  };
  process.once("SIGINT", () => void stop().then(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().then(() => process.exit(0)));
  await serveStdio(server);
  await stop();
  return 0;
}
