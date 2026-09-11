/**
 * Upstream side of the proxy: one MCP client per upstream (stdio or Streamable HTTP), the merged
 * tool table, resource/prompt routing, notification fan-out to downstream sessions, and
 * `callTool` through the policy engine.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { version as cliVersion } from "../version.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  LoggingMessageNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type CompleteRequest,
  type CompleteResult,
  type GetPromptResult,
  type ListPromptsResult,
  type ListResourceTemplatesResult,
  type ListResourcesResult,
  type LoggingLevel,
  type Prompt,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";
import {
  GuardError,
  classifyTool,
  upstreamHeaders,
  type AgentScope,
  type Classification,
  type Guard,
  type GuardResult,
  type Upstream,
} from "@agentwares/agentguard-core";
import type { LoadedPolicy } from "@agentwares/agentguard-core/node";

export interface ExposedTool {
  /** the name the agent sees */
  name: string;
  upstream: string;
  /** the name the upstream knows */
  original: string;
  tool: Tool;
  classification: Classification;
}

export interface DownstreamSession {
  id: string;
  server: McpServer;
  lastActive: number;
  /** upstream name → downstream request ids currently waiting on it (newest last) */
  inflight: Map<string, RequestId[]>;
}

export interface UpstreamStatus {
  name: string;
  connected: boolean;
  tools: number;
  transport: "stdio" | "http";
  error?: string;
}

interface Connection {
  upstream: Upstream;
  client: Client;
  tools: Tool[];
  capabilities: ReturnType<Client["getServerCapabilities"]>;
  connected: boolean;
  error?: string;
}

export interface RuntimeOptions {
  loaded: LoadedPolicy;
  guard: Guard;
  /** fixed agent scope for stdio (`--agent`) */
  agent?: AgentScope | null;
  /** run id when neither `X-Run-Id` nor `_meta.runId` is present */
  defaultRunId: string;
  log?: (line: string) => void;
  /** connect timeout per upstream (ms) */
  connectTimeoutMs?: number;
  /** in-process upstreams for tests: name → already-connected client */
  clients?: Record<string, Client>;
}

export interface CallContext {
  runId: string;
  agent?: AgentScope | null;
  sessionId?: string;
  onprogress?: (progress: { progress: number; total?: number; message?: string }) => void;
  /** downstream session + request id, so upstream notifications can be related to this call */
  session?: DownstreamSession;
  requestId?: RequestId;
}

export class ProxyRuntime {
  readonly loaded: LoadedPolicy;
  readonly guard: Guard;
  readonly agent: AgentScope | null | undefined;
  readonly defaultRunId: string;
  readonly sessions = new Set<DownstreamSession>();
  private readonly connections = new Map<string, Connection>();
  private exposed: ExposedTool[] = [];
  private readonly resourceOwner = new Map<string, string>();
  private readonly templateOwner = new Map<string, string>();
  private readonly promptOwner = new Map<string, { upstream: string; original: string }>();
  private readonly log: (line: string) => void;
  private readonly connectTimeoutMs: number;
  private readonly testClients: Record<string, Client>;
  /** stop relaying upstream stderr once we are tearing down — shutdown noise is not the user's problem */
  private closing = false;

  constructor(opts: RuntimeOptions) {
    this.loaded = opts.loaded;
    this.guard = opts.guard;
    this.agent = opts.agent;
    this.defaultRunId = opts.defaultRunId;
    this.log = opts.log ?? ((line) => process.stderr.write(`[agentguard] ${line}\n`));
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
    this.testClients = opts.clients ?? {};
  }

  get policy() {
    return this.loaded.policy;
  }

  async start(): Promise<void> {
    await Promise.all(this.policy.upstreams.map((u) => this.connect(u)));
    for (const [name, client] of Object.entries(this.testClients)) {
      if (this.connections.has(name)) continue;
      const upstream: Upstream = {
        name,
        command: "in-memory",
        args: [],
        env: {},
        headers: {},
        prefix: false,
        timeout_ms: 60_000,
      };
      const conn: Connection = {
        upstream,
        client,
        tools: [],
        capabilities: client.getServerCapabilities(),
        connected: true,
      };
      this.connections.set(name, conn);
      this.wire(conn);
      await this.refreshTools(name);
    }
    this.rebuildExposed();
    const status = this.upstreamStatus();
    this.log(
      `connected ${status.filter((s) => s.connected).length}/${status.length} upstreams, ${this.exposed.length} tools, mode ${this.policy.mode}`,
    );
  }

  private async connect(upstream: Upstream): Promise<void> {
    const client = new Client(
      { name: "agentguard", version: cliVersion() },
      { capabilities: { sampling: {}, elicitation: {} } },
    );
    const conn: Connection = {
      upstream,
      client,
      tools: [],
      capabilities: undefined,
      connected: false,
    };
    this.connections.set(upstream.name, conn);
    try {
      const transport = upstream.url
        ? new StreamableHTTPClientTransport(new URL(upstream.url), {
            requestInit: { headers: upstreamHeaders(upstream) },
          })
        : new StdioClientTransport({
            command: upstream.command!,
            args: upstream.args,
            env: { ...getDefaultEnvironment(), ...upstream.env },
            cwd: upstream.cwd,
            stderr: "pipe",
          });
      if (transport instanceof StdioClientTransport) {
        transport.stderr?.on("data", (chunk: Buffer) => {
          if (this.closing) return;
          for (const line of chunk.toString("utf8").split("\n"))
            if (line.trim()) this.log(`${upstream.name}: ${line}`);
        });
      }
      await withTimeout(
        client.connect(transport),
        this.connectTimeoutMs,
        `connect to upstream "${upstream.name}"`,
      );
      conn.capabilities = client.getServerCapabilities();
      conn.connected = true;
      this.wire(conn);
      await this.refreshTools(upstream.name);
    } catch (err) {
      conn.connected = false;
      conn.error = err instanceof Error ? err.message : String(err);
      this.log(`upstream "${upstream.name}" unavailable: ${conn.error}`);
    }
  }

  private wire(conn: Connection): void {
    const { client, upstream } = conn;
    client.onclose = () => {
      conn.connected = false;
      conn.error = "connection closed";
      if (!this.closing) this.log(`upstream "${upstream.name}" closed`);
    };
    client.setNotificationHandler(LoggingMessageNotificationSchema, async (n) => {
      await this.broadcast(upstream.name, n.method, n.params);
    });
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => {
      await this.broadcast(upstream.name, n.method, n.params);
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
      this.resourceOwner.clear();
      await this.broadcast(upstream.name, "notifications/resources/list_changed", undefined);
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
      this.promptOwner.clear();
      await this.broadcast(upstream.name, "notifications/prompts/list_changed", undefined);
    });
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await this.refreshTools(upstream.name);
      this.rebuildExposed();
      for (const s of this.sessions) s.server.server.sendToolListChanged().catch(() => undefined);
    });
    // Relay server→client requests (sampling, elicitation) to the downstream session that is
    // waiting on this upstream. Clients created without those capabilities (tests) skip this.
    try {
      client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
        const session = this.pickSession(upstream.name);
        if (!session) throw new Error("no downstream client is connected to relay sampling to");
        const related = session.inflight.get(upstream.name)?.at(-1);
        return session.server.server.createMessage(req.params, { relatedRequestId: related });
      });
      client.setRequestHandler(ElicitRequestSchema, async (req) => {
        const session = this.pickSession(upstream.name);
        if (!session) throw new Error("no downstream client is connected to relay elicitation to");
        const related = session.inflight.get(upstream.name)?.at(-1);
        return session.server.server.elicitInput(req.params, { relatedRequestId: related });
      });
    } catch {
      // client declared no sampling/elicitation capability
    }
  }

  private pickSession(upstream: string): DownstreamSession | undefined {
    let best: DownstreamSession | undefined;
    for (const s of this.sessions) {
      if ((s.inflight.get(upstream)?.length ?? 0) > 0) return s;
      if (!best || s.lastActive > best.lastActive) best = s;
    }
    return best;
  }

  private async broadcast(upstream: string, method: string, params: unknown): Promise<void> {
    for (const s of this.sessions) {
      const related = s.inflight.get(upstream)?.at(-1);
      try {
        await s.server.server.notification(
          { method, params: params as Record<string, unknown> | undefined },
          related !== undefined ? { relatedRequestId: related } : undefined,
        );
      } catch {
        // session gone
      }
    }
  }

  private async refreshTools(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn?.connected) return;
    if (conn.capabilities && !conn.capabilities.tools) {
      conn.tools = [];
      return;
    }
    try {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await conn.client.listTools(cursor ? { cursor } : undefined, {
          timeout: conn.upstream.timeout_ms,
        });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      conn.tools = tools;
    } catch (err) {
      this.log(
        `tools/list failed for "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
      conn.tools = [];
    }
  }

  private rebuildExposed(): void {
    const taken = new Set<string>();
    const out: ExposedTool[] = [];
    const order = [...this.policy.upstreams.map((u) => u.name), ...Object.keys(this.testClients)];
    for (const name of order) {
      const conn = this.connections.get(name);
      if (!conn) continue;
      const prefix =
        conn.upstream.prefix === true
          ? name
          : typeof conn.upstream.prefix === "string"
            ? conn.upstream.prefix
            : undefined;
      for (const tool of conn.tools) {
        let exposedName = prefix ? `${prefix}__${tool.name}` : tool.name;
        if (taken.has(exposedName)) exposedName = `${name}__${tool.name}`;
        if (taken.has(exposedName)) {
          this.log(`skipping duplicate tool ${exposedName} from ${name}`);
          continue;
        }
        taken.add(exposedName);
        out.push({
          name: exposedName,
          upstream: name,
          original: tool.name,
          tool,
          classification: classifyTool(
            {
              name: exposedName,
              description: tool.description,
              annotations: tool.annotations,
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema,
            },
            this.policy,
          ),
        });
      }
    }
    this.exposed = out;
  }

  listTools(agent?: AgentScope | null): ExposedTool[] {
    if (agent?.upstreams) return this.exposed.filter((t) => agent.upstreams!.includes(t.upstream));
    return this.exposed;
  }

  findTool(name: string): ExposedTool | undefined {
    return this.exposed.find((t) => t.name === name);
  }

  upstreamStatus(): UpstreamStatus[] {
    return [...this.connections.values()].map((c) => ({
      name: c.upstream.name,
      connected: c.connected,
      tools: c.tools.length,
      transport: c.upstream.url ? "http" : "stdio",
      error: c.error,
    }));
  }

  attach(session: DownstreamSession): void {
    this.sessions.add(session);
  }
  detach(session: DownstreamSession): void {
    this.sessions.delete(session);
  }

  /** Run a tool call through the policy engine and, if allowed, the upstream. */
  async callTool(
    name: string,
    args: unknown,
    ctx: CallContext,
  ): Promise<{ result: GuardResult; tool?: ExposedTool }> {
    const tool = this.findTool(name);
    const agent = ctx.agent === undefined ? this.agent : ctx.agent;
    if (!tool) {
      const result = await this.guard.run(
        { tool: { name }, args, runId: ctx.runId, agent, sessionId: ctx.sessionId },
        async () => {
          throw new GuardError({
            code: "UNKNOWN_TOOL",
            cause: `no upstream exposes a tool named "${name}"`,
            fix: "call tools/list and use one of the listed names",
            retryable: false,
          });
        },
      );
      return { result };
    }
    const conn = this.connections.get(tool.upstream);
    const track = (): (() => void) => {
      if (!ctx.session || ctx.requestId === undefined) return () => undefined;
      const list = ctx.session.inflight.get(tool.upstream) ?? [];
      list.push(ctx.requestId);
      ctx.session.inflight.set(tool.upstream, list);
      return () => {
        const l = ctx.session!.inflight.get(tool.upstream) ?? [];
        const i = l.indexOf(ctx.requestId!);
        if (i >= 0) l.splice(i, 1);
      };
    };
    const result = await this.guard.run(
      {
        tool: {
          name: tool.name,
          description: tool.tool.description,
          annotations: tool.tool.annotations,
          inputSchema: tool.tool.inputSchema,
          outputSchema: tool.tool.outputSchema,
        },
        args,
        runId: ctx.runId,
        agent,
        sessionId: ctx.sessionId,
        upstream: tool.upstream,
      },
      async (finalArgs) => {
        if (!conn?.connected) {
          throw new GuardError({
            code: "UPSTREAM_ERROR",
            cause: `upstream "${tool.upstream}" is not connected${conn?.error ? ` (${conn.error})` : ""}`,
            fix: "check the upstream command/url in agentguard.yaml and restart the proxy",
            retryable: true,
          });
        }
        const untrack = track();
        try {
          return (await conn.client.callTool(
            { name: tool.original, arguments: (finalArgs ?? {}) as Record<string, unknown> },
            undefined,
            {
              timeout: conn.upstream.timeout_ms,
              resetTimeoutOnProgress: true,
              onprogress: ctx.onprogress,
            },
          )) as CallToolResult;
        } finally {
          untrack();
        }
      },
    );
    return { result, tool };
  }

  private connectedWith(
    capability: "resources" | "prompts" | "completions" | "logging",
  ): Connection[] {
    return [...this.connections.values()].filter(
      (c) => c.connected && (c.capabilities?.[capability] || c.capabilities === undefined),
    );
  }

  async listResources(): Promise<ListResourcesResult> {
    const resources: Resource[] = [];
    for (const conn of this.connectedWith("resources")) {
      try {
        const page = await conn.client.listResources(undefined, {
          timeout: conn.upstream.timeout_ms,
        });
        for (const r of page.resources) {
          this.resourceOwner.set(r.uri, conn.upstream.name);
          resources.push(r);
        }
      } catch {
        // upstream has no resources
      }
    }
    return { resources };
  }

  async listResourceTemplates(): Promise<ListResourceTemplatesResult> {
    const resourceTemplates: ResourceTemplate[] = [];
    for (const conn of this.connectedWith("resources")) {
      try {
        const page = await conn.client.listResourceTemplates(undefined, {
          timeout: conn.upstream.timeout_ms,
        });
        for (const t of page.resourceTemplates) {
          this.templateOwner.set(t.uriTemplate, conn.upstream.name);
          resourceTemplates.push(t);
        }
      } catch {
        // none
      }
    }
    return { resourceTemplates };
  }

  private ownerForUri(uri: string): Connection[] {
    const owner = this.resourceOwner.get(uri);
    if (owner && this.connections.get(owner)?.connected) return [this.connections.get(owner)!];
    for (const [template, name] of this.templateOwner) {
      if (templateMatches(template, uri) && this.connections.get(name)?.connected)
        return [this.connections.get(name)!];
    }
    return this.connectedWith("resources");
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    let lastError: unknown;
    for (const conn of this.ownerForUri(uri)) {
      try {
        const result = await conn.client.readResource(
          { uri },
          { timeout: conn.upstream.timeout_ms },
        );
        this.resourceOwner.set(uri, conn.upstream.name);
        return result;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error(`no upstream serves resource ${uri}`);
  }

  async subscribe(uri: string, on: boolean): Promise<void> {
    for (const conn of this.ownerForUri(uri)) {
      try {
        if (on) await conn.client.subscribeResource({ uri });
        else await conn.client.unsubscribeResource({ uri });
        return;
      } catch {
        // try next
      }
    }
  }

  async listPrompts(): Promise<ListPromptsResult> {
    const prompts: Prompt[] = [];
    const taken = new Set<string>();
    this.promptOwner.clear();
    for (const conn of this.connectedWith("prompts")) {
      try {
        const page = await conn.client.listPrompts(undefined, {
          timeout: conn.upstream.timeout_ms,
        });
        for (const p of page.prompts) {
          const name = taken.has(p.name) ? `${conn.upstream.name}__${p.name}` : p.name;
          taken.add(name);
          this.promptOwner.set(name, { upstream: conn.upstream.name, original: p.name });
          prompts.push({ ...p, name });
        }
      } catch {
        // none
      }
    }
    return { prompts };
  }

  async getPrompt(
    name: string,
    args: Record<string, string> | undefined,
  ): Promise<GetPromptResult> {
    if (this.promptOwner.size === 0) await this.listPrompts();
    const owner = this.promptOwner.get(name);
    const conns = owner ? [this.connections.get(owner.upstream)!] : this.connectedWith("prompts");
    let lastError: unknown;
    for (const conn of conns) {
      try {
        return await conn.client.getPrompt(
          { name: owner?.original ?? name, arguments: args },
          { timeout: conn.upstream.timeout_ms },
        );
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error(`no upstream serves prompt ${name}`);
  }

  async complete(params: CompleteRequest["params"]): Promise<CompleteResult> {
    let conns: Connection[];
    if (params.ref.type === "ref/prompt") {
      if (this.promptOwner.size === 0) await this.listPrompts();
      const owner = this.promptOwner.get(params.ref.name);
      conns = owner ? [this.connections.get(owner.upstream)!] : this.connectedWith("completions");
      if (owner) params = { ...params, ref: { ...params.ref, name: owner.original } };
    } else {
      if (this.templateOwner.size === 0) await this.listResourceTemplates();
      conns = this.ownerForUri(params.ref.uri);
    }
    let lastError: unknown;
    for (const conn of conns) {
      try {
        return await conn.client.complete(params, { timeout: conn.upstream.timeout_ms });
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error("no upstream supports completions");
  }

  async setLevel(level: LoggingLevel): Promise<void> {
    await Promise.all(
      this.connectedWith("logging").map((c) =>
        c.client.setLoggingLevel(level).catch(() => undefined),
      ),
    );
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const conn of this.connections.values()) {
      try {
        await conn.client.close();
      } catch {
        // already closed
      }
    }
    this.connections.clear();
  }
}

function templateMatches(template: string, uri: string): boolean {
  const re = new RegExp(
    "^" + template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]+\\\}/g, "[^/]+") + "$",
  );
  return re.test(uri);
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
