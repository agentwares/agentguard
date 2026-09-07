/**
 * `createMcpServer` — an SDK `McpServer` with every `ToolDef` registered, plus the manifest
 * helper used for `llms.txt` and docs.
 */
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type ServerCapabilities,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolAnnotations, ToolContext, ToolDef } from "./tool.js";

export interface McpServerOptions {
  /** server name as shown to clients, e.g. `agentcheck` */
  name: string;
  version: string;
  title?: string;
  websiteUrl?: string;
  /** shown to the model at connect time: what the server is for and how to start */
  instructions?: string;
  tools: ToolDef[];
  /** extra capabilities (tools and logging are always declared) */
  capabilities?: ServerCapabilities;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function isZodObject(schema: unknown): schema is z.ZodObject {
  return schema instanceof z.ZodObject;
}

/** Build a `ToolContext` from the SDK's request `extra` (headers, ids, signal, notifications). */
export function contextFromExtra(extra: Extra): ToolContext {
  const headers = new Headers();
  const raw = extra.requestInfo?.headers;
  if (raw) {
    for (const [key, value] of Object.entries(raw)) {
      if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      else if (typeof value === "string") headers.append(key, value);
    }
  }
  const progressToken = extra._meta?.progressToken;
  return {
    headers,
    requestId: String(extra.requestId),
    signal: extra.signal,
    sessionId: extra.sessionId,
    meta: extra._meta,
    extra,
    log: async (level, data) => {
      await extra.sendNotification({ method: "notifications/message", params: { level, data } });
    },
    progress: async (progress, total, message) => {
      if (progressToken === undefined) return;
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, total, message },
      });
    },
  };
}

/**
 * Create an `McpServer` with all tools registered. Duplicate names throw.
 *
 * Tools are registered with the SDK (capabilities, enable/disable, list-changed notifications),
 * but `tools/list` and `tools/call` are served by the kit: the listing is exactly
 * `listToolManifest(tools)` (JSON Schema 2020-12, `additionalProperties: false`), and invalid
 * arguments or handler failures come back as in-band `{ code, cause, fix, retryable }` results
 * instead of bare JSON-RPC errors.
 */
export function createMcpServer(opts: McpServerOptions): McpServer {
  const byName = new Map<string, ToolDef>();
  for (const tool of opts.tools) {
    if (byName.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
    byName.set(tool.name, tool);
  }

  const server = new McpServer(
    { name: opts.name, version: opts.version, title: opts.title, websiteUrl: opts.websiteUrl },
    { instructions: opts.instructions, capabilities: { logging: {}, ...opts.capabilities } },
  );

  const registered = new Map<string, RegisteredTool>();
  for (const tool of byName.values()) {
    const config: {
      title?: string;
      description: string;
      inputSchema: z.ZodObject;
      outputSchema?: z.ZodObject;
      annotations?: ToolAnnotations;
    } = {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      annotations: tool.annotations,
    };
    if (isZodObject(tool.output)) config.outputSchema = tool.output;
    registered.set(
      tool.name,
      server.registerTool(tool.name, config, () => {
        throw new Error("unreachable: mcp-kit dispatches tools/call itself");
      }),
    );
  }

  if (byName.size > 0) {
    server.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const enabled = [...byName.values()].filter(
        (tool) => registered.get(tool.name)?.enabled !== false,
      );
      return {
        tools: listToolManifest(enabled).map((entry) => ({
          ...entry,
          inputSchema: entry.inputSchema as Tool["inputSchema"],
          outputSchema: entry.outputSchema as Tool["outputSchema"],
        })),
      };
    });
    server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request.params.name;
      const tool = byName.get(name);
      const entry = registered.get(name);
      if (!tool || !entry) throw new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`);
      if (!entry.enabled) throw new McpError(ErrorCode.InvalidParams, `Tool ${name} disabled`);
      return tool.invoke(request.params.arguments ?? {}, contextFromExtra(extra));
    });
  }

  return server;
}

export interface ToolManifestEntry {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

/**
 * JSON Schema (2020-12) for a zod schema, as advertised to clients. Plain `z.object`s strip
 * unknown keys at runtime, so they are advertised with `additionalProperties: false` (strict
 * schemas keep agents from inventing parameters); `z.looseObject` keeps them open.
 */
export function toJsonSchema(
  schema: z.ZodType,
  io: "input" | "output" = "input",
): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io, target: "draft-2020-12" }) as Record<string, unknown>;
  if (
    isZodObject(schema) &&
    schema._zod.def.catchall === undefined &&
    json.additionalProperties === undefined
  ) {
    json.additionalProperties = false;
  }
  return json;
}

/** Plain JSON description of the tools — for `llms.txt`, docs pages and registries. */
export function listToolManifest(tools: readonly ToolDef[]): ToolManifestEntry[] {
  return tools.map((tool) => {
    const entry: ToolManifestEntry = {
      name: tool.name,
      description: tool.description,
      inputSchema: toJsonSchema(tool.input, "input"),
    };
    if (tool.title !== undefined) entry.title = tool.title;
    if (isZodObject(tool.output)) entry.outputSchema = toJsonSchema(tool.output, "output");
    if (tool.annotations !== undefined) entry.annotations = tool.annotations;
    return entry;
  });
}
