/**
 * Web-standard Streamable HTTP handler: `(Request) => Promise<Response>`. Runs unchanged in
 * Next.js route handlers, Vercel Functions and Cloudflare Workers.
 *
 * Stateless by default: a fresh server and transport per request, closed when the response
 * finishes. Opt into `sessions: true` for a long-lived process that needs server→client
 * requests (sampling, elicitation) or the standalone GET stream.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { normalizeError } from "./errors.js";
import { createMcpServer, type McpServerOptions } from "./server.js";

export interface CorsOptions {
  /** `Access-Control-Allow-Origin` (default `*`) */
  origin?: string;
  methods?: string;
  headers?: string;
  exposeHeaders?: string;
  maxAge?: number;
}

export interface SessionOptions {
  /** idle sessions are closed after this long (default 30 minutes) */
  ttlMs?: number;
}

export interface HttpTransportOptions {
  /** `true` for permissive defaults, or explicit values. Off by default. */
  cors?: boolean | CorsOptions;
  /**
   * `true`: each POST is answered with one JSON body — simplest for curl and serverless
   * (default when stateless). `false`: answer with an SSE stream so `ctx.log` / `ctx.progress`
   * notifications and server→client requests reach the client mid-call (default with sessions).
   */
  jsonResponse?: boolean;
  /**
   * `false` (default): stateless — no session ids, safe on serverless. `true` (or options):
   * sessions kept in this process's memory under `Mcp-Session-Id`; needed for sampling,
   * elicitation and the standalone GET stream. Single long-lived process only.
   */
  sessions?: boolean | SessionOptions;
  /** Host header allow-list (DNS-rebinding protection for localhost servers). */
  allowedHosts?: string[];
  allowedOrigins?: string[];
  enableDnsRebindingProtection?: boolean;
}

export type HttpHandlerOptions = McpServerOptions & HttpTransportOptions;
export type HttpHandler = (request: Request) => Promise<Response>;

const DEFAULT_CORS: Required<CorsOptions> = {
  origin: "*",
  methods: "GET, POST, DELETE, OPTIONS",
  headers:
    "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, PAYMENT, X-PAYMENT",
  exposeHeaders:
    "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate, X-Payment-Requirements, PAYMENT-REQUIRED",
  maxAge: 86_400,
};

const DEFAULT_SESSION_TTL_MS = 30 * 60_000;

function corsHeaders(cors: boolean | CorsOptions | undefined): Record<string, string> {
  if (!cors) return {};
  const c = { ...DEFAULT_CORS, ...(typeof cors === "object" ? cors : {}) };
  return {
    "Access-Control-Allow-Origin": c.origin,
    "Access-Control-Allow-Methods": c.methods,
    "Access-Control-Allow-Headers": c.headers,
    "Access-Control-Expose-Headers": c.exposeHeaders,
    "Access-Control-Max-Age": String(c.maxAge),
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function methodNotAllowed(method: string, allow: string, cors: Record<string, string>): Response {
  return jsonResponse(
    {
      code: "METHOD_NOT_ALLOWED",
      cause: `${method} is not supported here without a session`,
      fix: "send JSON-RPC over POST with `Accept: application/json, text/event-stream` (start with `initialize`)",
      retryable: false,
    },
    405,
    { Allow: allow, ...cors },
  );
}

function splitOptions(
  opts: HttpHandlerOptions | (() => McpServer),
  transport: HttpTransportOptions,
): { factory: () => McpServer; transport: HttpTransportOptions } {
  if (typeof opts === "function") return { factory: opts, transport };
  const {
    cors,
    jsonResponse,
    sessions,
    allowedHosts,
    allowedOrigins,
    enableDnsRebindingProtection,
    ...server
  } = opts;
  return {
    factory: () => createMcpServer(server),
    transport: {
      cors,
      jsonResponse,
      sessions,
      allowedHosts,
      allowedOrigins,
      enableDnsRebindingProtection,
      ...transport,
    },
  };
}

interface TransportBase {
  enableJsonResponse: boolean;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  enableDnsRebindingProtection?: boolean;
}

interface HandlerContext {
  factory: () => McpServer;
  cors: Record<string, string>;
  transportBase: TransportBase;
}

function withCors(response: Response, cors: Record<string, string>): Response {
  const keys = Object.keys(cors);
  if (keys.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const key of keys) headers.set(key, cors[key] ?? "");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function errorResponse(err: unknown, cors: Record<string, string>): Response {
  const error = normalizeError(err);
  return jsonResponse(error.toJSON(), error.httpStatus, cors);
}

function createStatelessHandler({ factory, cors, transportBase }: HandlerContext): HttpHandler {
  return async (request) => {
    if (request.method !== "POST") return methodNotAllowed(request.method, "POST, OPTIONS", cors);

    const server = factory();
    const transport = new WebStandardStreamableHTTPServerTransport({
      ...transportBase,
      sessionIdGenerator: undefined,
    });
    let closed = false;
    const cleanup = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        await server.close();
      } catch {
        // already closed
      }
    };

    try {
      await server.connect(transport);
      const response = withCors(await transport.handleRequest(request), cors);
      if (!response.body) {
        await cleanup();
        return response;
      }
      // Close server + transport once the body (JSON or SSE stream) has been fully written.
      request.signal?.addEventListener("abort", () => void cleanup(), { once: true });
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({ flush: () => cleanup() }),
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (err) {
      await cleanup();
      return errorResponse(err, cors);
    }
  };
}

interface Session {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  lastSeen: number;
}

function createStatefulHandler(
  { factory, cors, transportBase }: HandlerContext,
  options: SessionOptions,
): HttpHandler {
  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const sessions = new Map<string, Session>();

  const drop = (id: string): void => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    session.server.close().catch(() => undefined);
  };
  const sweep = (): void => {
    const now = Date.now();
    for (const [id, session] of sessions) if (now - session.lastSeen > ttlMs) drop(id);
  };

  return async (request) => {
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        return jsonResponse(
          {
            code: "NOT_FOUND",
            cause: "unknown or expired Mcp-Session-Id",
            fix: "send `initialize` again without an Mcp-Session-Id header and use the id from the response",
            retryable: true,
          },
          404,
          cors,
        );
      }
      session.lastSeen = Date.now();
      try {
        return withCors(await session.transport.handleRequest(request), cors);
      } catch (err) {
        return errorResponse(err, cors);
      }
    }

    if (request.method !== "POST") return methodNotAllowed(request.method, "POST, OPTIONS", cors);
    sweep();

    const server = factory();
    const transport = new WebStandardStreamableHTTPServerTransport({
      ...transportBase,
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport, lastSeen: Date.now() });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });

    try {
      await server.connect(transport);
      const previousOnClose = transport.onclose;
      transport.onclose = () => {
        previousOnClose?.();
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      const response = withCors(await transport.handleRequest(request), cors);
      // Anything but a successful `initialize` leaves no session behind: release the server.
      if (!transport.sessionId) server.close().catch(() => undefined);
      return response;
    } catch (err) {
      server.close().catch(() => undefined);
      return errorResponse(err, cors);
    }
  };
}

/**
 * Create the request handler. Pass server options, or a factory returning a configured
 * `McpServer` (e.g. one with resources/prompts added) when you need more than tools.
 */
export function createHttpHandler(
  opts: HttpHandlerOptions | (() => McpServer),
  transportOptions: HttpTransportOptions = {},
): HttpHandler {
  const { factory, transport: t } = splitOptions(opts, transportOptions);
  const cors = corsHeaders(t.cors);
  const sessions = t.sessions ? (typeof t.sessions === "object" ? t.sessions : {}) : undefined;
  const context: HandlerContext = {
    factory,
    cors,
    transportBase: {
      enableJsonResponse: t.jsonResponse ?? sessions === undefined,
      allowedHosts: t.allowedHosts,
      allowedOrigins: t.allowedOrigins,
      enableDnsRebindingProtection: t.enableDnsRebindingProtection,
    },
  };
  const handler = sessions
    ? createStatefulHandler(context, sessions)
    : createStatelessHandler(context);
  const allow = sessions ? "GET, POST, DELETE, OPTIONS" : "POST, OPTIONS";

  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { Allow: allow, ...cors } });
    }
    return handler(request);
  };
}

/** Host header values a localhost server should accept (for `allowedHosts`). */
export function localhostHosts(port: number): string[] {
  const hosts = ["localhost", "127.0.0.1", "[::1]"];
  return [...hosts, ...hosts.map((h) => `${h}:${port}`)];
}

export interface HealthInfo {
  name: string;
  version: string;
  /** tool count or the tool list */
  tools: number | readonly unknown[];
}

/** `GET /health` → `{ ok: true, name, version, tools }`. */
export function handleHealth(info: HealthInfo): Response {
  const tools = typeof info.tools === "number" ? info.tools : info.tools.length;
  return jsonResponse({ ok: true, name: info.name, version: info.version, tools }, 200);
}
