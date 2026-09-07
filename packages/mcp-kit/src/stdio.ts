/**
 * `serveStdio` — the same tools over stdio (Claude Desktop, Cursor, `npx` launchers).
 * The only module in the kit that touches Node APIs; loaded lazily so Web-standard bundles
 * never pull it in.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer, type McpServerOptions } from "./server.js";

/** Connect over stdio. Resolves when the transport closes (stdin ends). */
export async function serveStdio(serverOrOpts: McpServer | McpServerOptions): Promise<void> {
  const server = serverOrOpts instanceof McpServer ? serverOrOpts : createMcpServer(serverOrOpts);
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    const previous = transport.onclose;
    transport.onclose = () => {
      previous?.();
      resolve();
    };
  });
}
