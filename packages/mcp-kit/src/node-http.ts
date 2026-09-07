/**
 * Bridge a Web-standard `(Request) => Promise<Response>` handler onto `node:http` — for local
 * runs, tests and the conformance suite. Node-only; loaded lazily.
 */
import type { HttpHandler } from "./http.js";

export interface NodeHttpOptions {
  handler: HttpHandler;
  /** 0 picks a free port (default 8765) */
  port?: number;
  /** default 127.0.0.1 */
  host?: string;
  /** MCP endpoint path (default `/mcp`) */
  path?: string;
  /** optional `GET /health` responder */
  health?: () => Response;
}

export interface NodeHttpServer {
  port: number;
  /** MCP endpoint URL, e.g. `http://127.0.0.1:8765/mcp` */
  url: string;
  close(): Promise<void>;
}

/** Start a `node:http` server that forwards `path` to the handler. */
export async function serveNodeHttp(opts: NodeHttpOptions): Promise<NodeHttpServer> {
  const http = await import("node:http");
  const host = opts.host ?? "127.0.0.1";
  const path = opts.path ?? "/mcp";

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
      let response: Response;
      if (url.pathname === path) {
        const controller = new AbortController();
        res.on("close", () => {
          if (!res.writableFinished) controller.abort();
        });
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(key, item);
          else if (typeof value === "string") headers.set(key, value);
        }
        const method = req.method ?? "GET";
        let body: Uint8Array<ArrayBuffer> | undefined;
        if (method !== "GET" && method !== "HEAD") {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          body = new Uint8Array(Buffer.concat(chunks));
        }
        response = await opts.handler(
          new Request(url, { method, headers, body, signal: controller.signal }),
        );
      } else if (url.pathname === "/health" && opts.health) {
        response = opts.health();
      } else {
        response = new Response(
          JSON.stringify({
            code: "NOT_FOUND",
            cause: `no route for ${url.pathname}`,
            fix: `POST JSON-RPC to ${path}`,
            retryable: false,
          }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      const outHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        outHeaders[key] = value;
      });
      res.writeHead(response.status, outHeaders);
      if (!response.body) {
        res.end();
        return;
      }
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch {
        // client went away mid-stream
      }
      res.end();
    })().catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: "INTERNAL",
          cause: err instanceof Error ? err.message : String(err),
          fix: "retry; if it persists, report the request id",
          retryable: false,
        }),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8765, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 8765);
  return {
    port,
    url: `http://${host}:${port}${path}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
