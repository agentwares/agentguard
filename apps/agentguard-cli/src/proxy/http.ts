/**
 * Streamable HTTP front door plus the local control endpoints: /health, /status, /kill,
 * /resume, /approve/:id, /deny/:id, /approvals. Control endpoints need the per-process token
 * (written to `<state>/http.json` so the CLI can find a running proxy).
 */
import { createHttpHandler, localhostHosts, type HttpHandler } from "@agentwares/mcp-kit";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { FileKillSwitch } from "@agentwares/agentguard-core/node";
import type { ProxyRuntime } from "./runtime.js";
import { createDownstreamServer, PROXY_VERSION } from "./server.js";

export interface HttpProxyOptions {
  runtime: ProxyRuntime;
  port?: number;
  host?: string;
  path?: string;
  token?: string;
  /** write `<stateDir>/http.json` for the CLI (default true) */
  registerFile?: boolean;
}

export interface HttpProxy {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

export interface HttpRegistration {
  url: string;
  baseUrl: string;
  token: string;
  pid: number;
  startedAt: string;
}

export function registrationPath(stateDir: string): string {
  return join(stateDir, "http.json");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(
    `<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;padding:2rem;max-width:40rem">${body}</body>`,
  );
}

async function readBody(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

export async function startHttpProxy(opts: HttpProxyOptions): Promise<HttpProxy> {
  const { runtime } = opts;
  const host = opts.host ?? "127.0.0.1";
  const path = opts.path ?? "/mcp";
  const token = opts.token ?? crypto.randomUUID().replace(/-/g, "");
  const kill = new FileKillSwitch(runtime.loaded.killPath);

  const holder: { mcp?: HttpHandler } = {};
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
      const authorized = (): boolean => {
        const q = url.searchParams.get("token");
        const h = req.headers.authorization?.replace(/^Bearer\s+/i, "");
        return q === token || h === token;
      };
      if (url.pathname === path && holder.mcp) {
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (Array.isArray(v)) for (const item of v) headers.append(k, item);
          else if (typeof v === "string") headers.set(k, v);
        }
        const controller = new AbortController();
        res.on("close", () => {
          if (!res.writableFinished) controller.abort();
        });
        const response = await holder.mcp(
          new Request(url, {
            method: req.method ?? "GET",
            headers,
            body: await readBody(req),
            signal: controller.signal,
          }),
        );
        const out: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          out[k] = v;
        });
        res.writeHead(response.status, out);
        if (!response.body) return res.end();
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } catch {
          // client went away
        }
        return res.end();
      }
      if (url.pathname === "/health") {
        const killed = await runtime.guard.killState();
        return json(res, 200, {
          ok: true,
          name: "agentguard",
          version: PROXY_VERSION,
          mode: runtime.policy.mode,
          killed: killed.killed,
          upstreams: runtime.upstreamStatus(),
          tools: runtime.listTools().length,
          mcp: `${url.origin}${path}`,
        });
      }
      if (url.pathname === "/status") {
        if (!authorized()) return json(res, 401, unauthorized());
        const runId = url.searchParams.get("run") ?? runtime.defaultRunId;
        return json(res, 200, { runId, ...(await runtime.guard.status(runId)) });
      }
      if (url.pathname === "/kill" && req.method === "POST") {
        if (!authorized()) return json(res, 401, unauthorized());
        const body = await readBody(req);
        let reason = "killed via HTTP";
        try {
          const parsed = JSON.parse(Buffer.from(body ?? []).toString("utf8") || "{}") as {
            reason?: string;
          };
          if (parsed.reason) reason = String(parsed.reason).slice(0, 200);
        } catch {
          // no body
        }
        kill.kill(reason);
        await runtime.guard.halt(reason);
        return json(res, 200, { killed: true, reason });
      }
      if (url.pathname === "/resume" && req.method === "POST") {
        if (!authorized()) return json(res, 401, unauthorized());
        kill.resume();
        await runtime.guard.resume();
        return json(res, 200, { killed: false });
      }
      const decision = /^\/(approve|deny)\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (decision) {
        if (!authorized()) return json(res, 401, unauthorized());
        const [, action, id] = decision;
        const record = await runtime.guard.decide(
          id!,
          action === "approve" ? "approved" : "denied",
          "http",
        );
        if (!record)
          return json(res, 404, {
            code: "NOT_FOUND",
            cause: `no approval ${id}`,
            fix: "list pending approvals with `agentguard approvals`",
            retryable: false,
          });
        if (req.headers.accept?.includes("text/html")) {
          return html(
            res,
            200,
            `<h1>${record.status === "approved" ? "Approved" : record.status === "denied" ? "Denied" : record.status}</h1><p><code>${record.tool}</code> — approval <code>${record.id}</code>.</p><p>The agent may now retry the call once.</p>`,
          );
        }
        return json(res, 200, record);
      }
      if (url.pathname === "/approvals") {
        if (!authorized()) return json(res, 401, unauthorized());
        return json(res, 200, {
          approvals: await runtime.guard.approvals.list(
            url.searchParams.get("all") ? undefined : "pending",
          ),
        });
      }
      return json(res, 404, {
        code: "NOT_FOUND",
        cause: `no route for ${url.pathname}`,
        fix: `POST JSON-RPC to ${path}; GET /health`,
        retryable: false,
      });
    })().catch((err: unknown) => {
      if (!res.headersSent)
        json(res, 500, {
          code: "INTERNAL",
          cause: err instanceof Error ? err.message : String(err),
          fix: "retry; if it persists, report the request",
          retryable: false,
        });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8788, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 8788);
  holder.mcp = createHttpHandler(() => createDownstreamServer(runtime), {
    sessions: true,
    jsonResponse: false,
    cors: true,
    allowedHosts: isLoopback(host) ? localhostHosts(port) : undefined,
    enableDnsRebindingProtection: isLoopback(host),
  });

  const baseUrl = `http://${host}:${port}`;
  const url = `${baseUrl}${path}`;
  const regFile = registrationPath(runtime.loaded.stateDir);
  if (opts.registerFile !== false) {
    mkdirSync(runtime.loaded.stateDir, { recursive: true });
    const reg: HttpRegistration = {
      url,
      baseUrl,
      token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(regFile, JSON.stringify(reg, null, 2));
  }
  return {
    url,
    port,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (opts.registerFile !== false && existsSync(regFile)) {
          try {
            unlinkSync(regFile);
          } catch {
            // fine
          }
        }
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function unauthorized(): Record<string, unknown> {
  return {
    code: "UNAUTHORIZED",
    cause: "missing or wrong control token",
    fix: "pass ?token=<token> or Authorization: Bearer <token> from <state>/http.json",
    retryable: false,
  };
}
