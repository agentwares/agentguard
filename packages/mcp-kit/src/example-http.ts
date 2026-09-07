/**
 * CLI: serve the example tools over Streamable HTTP with `node:http`.
 *
 *   node dist/example-http.js [--port=8765] [--host=127.0.0.1] [--path=/mcp] [--sse] [--stateful]
 *                             [--conformance] [--dns-protection]
 *
 * `--sse` answers POSTs with SSE streams (log/progress notifications mid-call) instead of one
 * JSON body. `--stateful` keeps sessions in memory (sampling/elicitation need it). `--conformance`
 * adds the fixture tools/resources/prompts the official conformance suite expects. `PORT` env
 * is honoured when `--port` is absent.
 */
import { registerConformanceFixtures, conformanceTools } from "./conformance-fixtures.js";
import { exampleServerInfo, exampleTools } from "./example.js";
import { createHttpHandler, handleHealth, localhostHosts } from "./http.js";
import { serveNodeHttp } from "./node-http.js";
import { createMcpServer } from "./server.js";

function flag(name: string): string | undefined {
  const arg = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!arg) return undefined;
  const eq = arg.indexOf("=");
  return eq === -1 ? "true" : arg.slice(eq + 1);
}

const port = Number(flag("port") ?? process.env.PORT ?? 8765);
const host = flag("host") ?? "127.0.0.1";
const path = flag("path") ?? "/mcp";
const stateful = flag("stateful") === "true";
const sse = flag("sse") === "true" || (stateful && flag("json") !== "true");
const conformance = flag("conformance") === "true";
const dnsProtection = flag("dns-protection") === "true";

const tools = conformance ? [...exampleTools, ...conformanceTools] : exampleTools;

const handler = createHttpHandler(
  () => {
    const server = createMcpServer({ ...exampleServerInfo, tools });
    if (conformance) registerConformanceFixtures(server);
    return server;
  },
  {
    cors: true,
    jsonResponse: !sse,
    sessions: stateful,
    ...(dnsProtection
      ? {
          enableDnsRebindingProtection: true,
          allowedHosts: [...new Set([host, `${host}:${port}`, ...localhostHosts(port)])],
        }
      : {}),
  },
);

const started = await serveNodeHttp({
  handler,
  port,
  host,
  path,
  health: () => handleHealth({ ...exampleServerInfo, tools }),
});

console.log(
  `mcp-kit example listening on ${started.url} (${tools.length} tools, ${stateful ? "stateful" : "stateless"}, ${sse ? "SSE" : "JSON"} responses${conformance ? ", conformance fixtures" : ""})`,
);

const shutdown = (): void => {
  void started.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
