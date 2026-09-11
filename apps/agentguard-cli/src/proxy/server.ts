/**
 * Downstream side of the proxy: the MCP server an agent connects to. One instance per session
 * (stdio: one; Streamable HTTP: one per `Mcp-Session-Id`). Every request is served from the
 * runtime; tool calls go through the policy engine.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  keyFromHeaders,
  resolveAgent,
  type AgentScope,
  type GuardErrorBody,
  type GuardResult,
} from "@agentwares/agentguard-core";
import { version as cliVersion } from "../version.js";
import type { DownstreamSession, ExposedTool, ProxyRuntime } from "./runtime.js";

/**
 * Reported to every MCP client in `serverInfo`. Derived from package.json rather than written
 * out, because a hand-maintained copy drifts: this said 0.1.0 while npm served 0.1.2, so a
 * client could not tell which build it was talking to.
 */
export const PROXY_VERSION = cliVersion();

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface DownstreamOptions {
  /** run id for calls that carry neither `X-Run-Id` nor `_meta.runId` (default: runtime.defaultRunId) */
  defaultRunId?: string;
}

function headerValue(extra: Extra, name: string): string | undefined {
  const raw =
    extra.requestInfo?.headers?.[name] ?? extra.requestInfo?.headers?.[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === "string" ? raw : undefined;
}

function headersOf(extra: Extra): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(extra.requestInfo?.headers ?? {}))
    out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

export function runIdFor(
  extra: Extra,
  meta: Record<string, unknown> | undefined,
  fallback: string,
): string {
  const header = headerValue(extra, "x-run-id");
  if (header && header.trim()) return header.trim().slice(0, 128);
  const fromMeta = meta?.runId ?? meta?.["agentguard/runId"] ?? meta?.run_id;
  if (typeof fromMeta === "string" && fromMeta.trim()) return fromMeta.trim().slice(0, 128);
  if (extra.sessionId) return `sess_${extra.sessionId.slice(0, 12)}`;
  return fallback;
}

/** Shape the engine's verdict into what the MCP client receives. */
export function toCallToolResult(
  result: GuardResult,
  tool: ExposedTool | undefined,
): CallToolResult {
  const meta = {
    agentguard: {
      class: result.decision.classification.class,
      verb: result.decision.classification.verb,
      mode: result.decision.mode,
      outcome: result.outcome,
      dryRun: result.faked,
      seq: result.entry.seq,
      run_id: result.entry.run_id,
    },
  };
  const hasOutputSchema = Boolean(tool?.tool.outputSchema);
  if (result.error) {
    const upstream = result.value as CallToolResult | undefined;
    if (upstream && upstream.content) {
      return { ...upstream, isError: true, _meta: { ...(upstream._meta ?? {}), ...meta } };
    }
    const body: GuardErrorBody = result.error;
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(body) }],
      ...(hasOutputSchema ? {} : { structuredContent: body }),
      _meta: { ...meta, httpStatus: httpStatusFor(body.code) },
    };
  }
  if (result.faked) {
    const value = result.value;
    const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
    return {
      content: [
        { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
      ],
      ...(isObject ? { structuredContent: value as Record<string, unknown> } : {}),
      _meta: meta,
    };
  }
  const upstream = result.value as CallToolResult;
  return { ...upstream, _meta: { ...(upstream._meta ?? {}), ...meta } };
}

function httpStatusFor(code: string): number {
  switch (code) {
    case "KILLED":
    case "TOOL_DENIED":
    case "APPROVAL_DENIED":
      return 403;
    case "APPROVAL_REQUIRED":
      return 202;
    case "CAP_EXCEEDED":
    case "LOOP_DETECTED":
      return 429;
    case "UNKNOWN_TOOL":
      return 404;
    case "UPSTREAM_ERROR":
      return 502;
    default:
      return 500;
  }
}

export function annotateTool(t: ExposedTool, mode: string): Tool {
  return {
    ...t.tool,
    name: t.name,
    _meta: {
      ...(t.tool._meta ?? {}),
      agentguard: {
        upstream: t.upstream,
        class: t.classification.class,
        verb: t.classification.verb,
        mode,
      },
    },
  };
}

function killedError(state: { reason?: string; source?: string }): Error {
  return Object.assign(
    new Error(`agentguard kill switch is on (${state.source ?? "?"}: ${state.reason ?? ""})`),
    { code: -32000 },
  );
}

/** Build the per-session MCP server. */
export function createDownstreamServer(
  runtime: ProxyRuntime,
  opts: DownstreamOptions = {},
): McpServer {
  const server = new McpServer(
    { name: "agentguard", version: PROXY_VERSION, title: "agentguard policy proxy" },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
        logging: {},
        completions: {},
      },
      instructions: `Tool calls pass through agentguard (${runtime.policy.mode} mode). Errors carry { code, cause, fix, retryable }; follow "fix". CAP_EXCEEDED, LOOP_DETECTED and KILLED are not retryable: stop and report to the user. APPROVAL_REQUIRED: relay the approval command to the user, then retry the identical call once.`,
    },
  );
  const session: DownstreamSession = {
    id: crypto.randomUUID(),
    server,
    lastActive: Date.now(),
    inflight: new Map(),
  };
  runtime.attach(session);
  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    previousOnClose?.();
    runtime.detach(session);
  };
  const touch = (): void => {
    session.lastActive = Date.now();
  };

  const agentFor = async (
    extra: Extra,
  ): Promise<{ agent: AgentScope | null | undefined; error?: GuardErrorBody }> => {
    const key = keyFromHeaders(headersOf(extra));
    if (!key) return { agent: undefined };
    const resolved = await resolveAgent(runtime.policy, { key });
    if (resolved.error) {
      return {
        agent: null,
        error: {
          code: "TOOL_DENIED",
          cause: "the agent key in Authorization / X-Agentguard-Key is not in agentguard.yaml",
          fix: "use a key created with `agentguard key create <agent>`, or omit the key to use the global policy",
          retryable: false,
        },
      };
    }
    return { agent: resolved.agent };
  };

  const low = server.server;
  low.setRequestHandler(ListToolsRequestSchema, async (_req, extra) => {
    touch();
    const { agent } = await agentFor(extra);
    const scope = agent === undefined ? runtime.agent : agent;
    return {
      tools: runtime
        .listTools(scope)
        .map((t) => annotateTool(t, scope?.mode ?? runtime.policy.mode)),
    };
  });

  low.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    touch();
    const { agent, error } = await agentFor(extra);
    const runId = runIdFor(extra, req.params._meta, opts.defaultRunId ?? runtime.defaultRunId);
    if (error) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(error) }],
        structuredContent: error,
        _meta: { httpStatus: 401 },
      };
    }
    const progressToken = req.params._meta?.progressToken;
    const { result, tool } = await runtime.callTool(req.params.name, req.params.arguments ?? {}, {
      runId,
      agent,
      sessionId: extra.sessionId ?? session.id,
      session,
      requestId: extra.requestId,
      onprogress:
        progressToken === undefined
          ? undefined
          : (p) => {
              void extra.sendNotification({
                method: "notifications/progress",
                params: { progressToken, ...p },
              });
            },
    });
    return toCallToolResult(result, tool);
  });

  const guardRead = async (): Promise<void> => {
    const state = await runtime.guard.killState();
    if (state.killed) throw killedError(state);
  };

  low.setRequestHandler(ListResourcesRequestSchema, async () => {
    touch();
    return runtime.listResources();
  });
  low.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    touch();
    return runtime.listResourceTemplates();
  });
  low.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    touch();
    await guardRead();
    return runtime.readResource(req.params.uri);
  });
  low.setRequestHandler(SubscribeRequestSchema, async (req) => {
    await runtime.subscribe(req.params.uri, true);
    return {};
  });
  low.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    await runtime.subscribe(req.params.uri, false);
    return {};
  });
  low.setRequestHandler(ListPromptsRequestSchema, async () => {
    touch();
    return runtime.listPrompts();
  });
  low.setRequestHandler(GetPromptRequestSchema, async (req) => {
    touch();
    await guardRead();
    return runtime.getPrompt(req.params.name, req.params.arguments);
  });
  low.setRequestHandler(CompleteRequestSchema, async (req) => {
    touch();
    return runtime.complete(req.params);
  });
  low.setRequestHandler(SetLevelRequestSchema, async (req) => {
    await runtime.setLevel(req.params.level);
    return {};
  });
  return server;
}
