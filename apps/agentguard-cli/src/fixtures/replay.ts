/**
 * Recorded-fixture upstream: serves `tools/list` from a recording and answers `tools/call` with
 * the recorded result for (tool, canonical args). Lets the proxy tests run against a frozen
 * upstream so a change in agentguard's decisions is caught as a diff in `expected`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { stableStringify } from "@agentwares/agentguard-core";

export interface RecordedCall {
  tool: string;
  args: unknown;
  result: CallToolResult;
}

export interface Recording {
  recordedAt: string;
  upstream: string;
  tools: Tool[];
  calls: RecordedCall[];
  /** outcomes agentguard produced over this recording, per scenario */
  expected: Record<string, unknown>;
}

export function callKey(tool: string, args: unknown): string {
  return `${tool}:${stableStringify(args ?? {})}`;
}

export function createReplayServer(recording: Recording): McpServer {
  const server = new McpServer(
    { name: recording.upstream, version: "replay" },
    { capabilities: { tools: {} } },
  );
  const byKey = new Map<string, CallToolResult>();
  for (const c of recording.calls) byKey.set(callKey(c.tool, c.args), c.result);
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: recording.tools }));
  server.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const hit = byKey.get(callKey(req.params.name, req.params.arguments ?? {}));
    if (hit) return hit;
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "NOT_RECORDED",
            cause: `no recorded result for ${req.params.name} ${JSON.stringify(req.params.arguments)}`,
            fix: "re-record with RECORD_FIXTURES=1",
            retryable: false,
          }),
        },
      ],
    } satisfies CallToolResult;
  });
  return server;
}
