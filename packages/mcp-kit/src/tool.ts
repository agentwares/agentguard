/**
 * `defineTool` — a typed tool definition with a naming lint, zod input validation and
 * structured error results. The same `ToolDef` is served over stdio and Streamable HTTP.
 */
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { errorResult, toolError, type McpToolError } from "./errors.js";

/** MCP tool annotations (hints for clients; not enforced by servers). */
export interface ToolAnnotations {
  title?: string;
  /** the tool does not modify anything */
  readOnlyHint?: boolean;
  /** the tool may perform destructive updates (default true when not read-only) */
  destructiveHint?: boolean;
  /** repeated calls with the same arguments have no additional effect */
  idempotentHint?: boolean;
  /** the tool interacts with external entities (default true) */
  openWorldHint?: boolean;
}

export type LogLevel =
  "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency";

/** Per-call context handed to handlers. Built from the SDK's `extra` by the server adapter. */
export interface ToolContext {
  /** HTTP request headers (empty over stdio). Use for `Authorization`, payment headers, etc. */
  headers: Headers;
  /** JSON-RPC request id (string form) — quote it in error reports. */
  requestId?: string;
  /** aborted when the client cancels the request */
  signal?: AbortSignal;
  /** transport session id, when the transport is stateful */
  sessionId?: string;
  /** true when the caller asked for a free sample (set by `withPayment`) */
  sample?: boolean;
  /** set by `withPayment`'s `authorize` when the caller is a known user */
  userId?: string;
  /** the request's `_meta` (e.g. `progressToken`) */
  meta?: Record<string, unknown>;
  /** send a log notification to the client (no-op when the transport cannot deliver it) */
  log?: (level: LogLevel, data: unknown) => Promise<void>;
  /** report progress; no-op unless the caller supplied a progress token */
  progress?: (progress: number, total?: number, message?: string) => Promise<void>;
  /**
   * The raw SDK request context — `sendRequest` for sampling (`sampling/createMessage`) and
   * elicitation (`elicitation/create`), `authInfo`, task helpers. Absent when invoked directly.
   */
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>;
}

/** Build a context for calling `tool.invoke` directly (tests, cron jobs, in-process use). */
export function createToolContext(init: Partial<ToolContext> = {}): ToolContext {
  const { headers, ...rest } = init;
  return { headers: headers ?? new Headers(), ...rest };
}

export type ToolInput<TInput extends z.ZodObject> = z.output<TInput>;
export type ToolOutput<TOutput> = TOutput extends z.ZodType ? z.output<TOutput> : unknown;

export interface ToolDef<
  TInput extends z.ZodObject = z.ZodObject,
  TOutput extends z.ZodType | undefined = z.ZodType | undefined,
> {
  /** `<namespace>_<verb>_<object>`, e.g. `agentcheck_create_monitor` */
  readonly name: string;
  readonly title?: string;
  /** written for a new teammate: what it does, when to use it, what it returns */
  readonly description: string;
  readonly input: TInput;
  /** when given, handler results are validated against it and returned as `structuredContent` */
  readonly output?: TOutput;
  readonly annotations?: ToolAnnotations;
  /** The business logic. Throw `toolError(...)` for structured errors. */
  handler(
    input: z.output<TInput>,
    ctx: ToolContext,
  ): ToolOutput<TOutput> | Promise<ToolOutput<TOutput>>;
  /** Validate raw input, run the handler and shape the result. Never throws. */
  invoke(rawInput: unknown, ctx: ToolContext): Promise<CallToolResult>;
}

export interface DefineToolOptions<
  TInput extends z.ZodObject,
  TOutput extends z.ZodType | undefined,
> {
  name: string;
  title?: string;
  description: string;
  input: TInput;
  output?: TOutput;
  annotations?: ToolAnnotations;
  handler(
    input: z.output<TInput>,
    ctx: ToolContext,
  ): ToolOutput<TOutput> | Promise<ToolOutput<TOutput>>;
}

/** `namespace_verb_object`: lowercase, digits, single underscores, at least one underscore. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
export const MIN_NAMESPACE_LENGTH = 3;
export const MIN_DESCRIPTION_LENGTH = 20;

export function isValidToolName(name: string): boolean {
  if (!TOOL_NAME_PATTERN.test(name)) return false;
  const namespace = name.split("_")[0] ?? "";
  return namespace.length >= MIN_NAMESPACE_LENGTH;
}

/** Naming lint: throws unless `name` is `<namespace>_<verb>_<object>` with a namespace of 3+ chars. */
export function assertToolName(name: string): void {
  if (!isValidToolName(name)) {
    throw new Error(
      `tool name must be namespaced: <namespace>_<verb>_<object>, got ${JSON.stringify(name)}`,
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A handler may return a ready-made `CallToolResult` (e.g. image/audio content blocks). */
export function isCallToolResult(value: unknown): value is CallToolResult {
  if (!isPlainObject(value) || !Array.isArray(value.content)) return false;
  return value.content.every(
    (block: unknown) => isPlainObject(block) && typeof block.type === "string",
  );
}

/** Shape a handler's return value into a `CallToolResult`: JSON text plus `structuredContent`. */
export function toCallToolResult(value: unknown): CallToolResult {
  if (isCallToolResult(value)) return value;
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  const result: CallToolResult = { content: [{ type: "text", text }] };
  if (isPlainObject(value)) result.structuredContent = value;
  return result;
}

interface IssueLike {
  path: PropertyKey[];
  message: string;
  code?: string;
}

function issuePath(issue: IssueLike): string {
  return issue.path.map(String).join(".") || "(root)";
}

/** `INVALID_INPUT` with the offending field names in `fix` and the zod issues in `details`. */
export function invalidInputError(issues: readonly IssueLike[]): McpToolError {
  const fields = [...new Set(issues.map(issuePath))];
  const summary = issues.map((issue) => `${issuePath(issue)}: ${issue.message}`).join("; ");
  return toolError({
    code: "INVALID_INPUT",
    cause: `invalid input for ${fields.join(", ")} — ${summary}`,
    fix: `fix ${fields.join(", ")} to match the tool's inputSchema (see details.issues), then retry`,
    retryable: false,
    details: {
      fields,
      issues: issues.map((issue) => ({
        path: issue.path.map(String),
        code: issue.code,
        message: issue.message,
      })),
    },
  });
}

/**
 * Define a tool. Throws at definition time when the name is not namespaced or the description
 * is too short, so mistakes surface at boot rather than in an agent's transcript.
 */
export function defineTool<
  TInput extends z.ZodObject,
  TOutput extends z.ZodType | undefined = undefined,
>(opts: DefineToolOptions<TInput, TOutput>): ToolDef<TInput, TOutput> {
  assertToolName(opts.name);
  if (
    typeof opts.description !== "string" ||
    opts.description.trim().length < MIN_DESCRIPTION_LENGTH
  ) {
    throw new Error(
      `tool ${opts.name}: description must be at least ${MIN_DESCRIPTION_LENGTH} characters — say what it does, when to use it and what it returns`,
    );
  }
  const { name, title, description, input, output, annotations } = opts;
  const handler = opts.handler.bind(opts);

  const tool: ToolDef<TInput, TOutput> = {
    name,
    title,
    description,
    input,
    output,
    annotations,
    handler,
    async invoke(rawInput, ctx) {
      // The SDK client validates any structuredContent against the advertised outputSchema, even
      // on error results, so tools with an output schema carry the error body in text only.
      const fail = (err: unknown): CallToolResult => {
        const result = errorResult(err, { requestId: ctx.requestId });
        if (output) delete result.structuredContent;
        return result;
      };
      const parsed = input.safeParse(rawInput ?? {});
      if (!parsed.success) return fail(invalidInputError(parsed.error.issues));
      try {
        const value: unknown = await handler(parsed.data, ctx);
        if (output && !isCallToolResult(value)) {
          const checked = output.safeParse(value);
          if (!checked.success) {
            throw toolError({
              code: "INTERNAL",
              cause: `tool ${name} returned a value that does not match its output schema — ${checked.error.issues
                .map((issue) => `${issuePath(issue)}: ${issue.message}`)
                .join("; ")}`,
              fix: "this is a bug in the tool, not in your call; report it with the request id",
              retryable: false,
              details: { issues: checked.error.issues },
            });
          }
          return toCallToolResult(checked.data);
        }
        return toCallToolResult(value);
      } catch (err) {
        return fail(err);
      }
    },
  };
  return tool;
}
