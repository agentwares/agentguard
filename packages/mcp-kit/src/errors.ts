/**
 * Structured tool errors. Every error an agent sees carries `code`, `cause`, `fix` and
 * `retryable` (CLAUDE.md "Writing for agents") so the caller can decide what to do next
 * without reading prose.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Standard error codes. Products may add their own (e.g. `MONITOR_PAUSED`). */
export const ERROR_CODES = [
  "INVALID_INPUT",
  "NOT_FOUND",
  "UNAUTHORIZED",
  "PAYMENT_REQUIRED",
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
  "INTERNAL",
] as const;

export type StandardErrorCode = (typeof ERROR_CODES)[number];
/** A standard code, or a product-specific UPPER_SNAKE code. */
export type ErrorCode = StandardErrorCode | (string & Record<never, never>);

/** Wire shape of every error body (tool result text, structuredContent and HTTP JSON alike). */
export type ToolErrorBody = {
  code: string;
  /** what went wrong, in one sentence */
  cause: string;
  /** what the caller should do next */
  fix: string;
  /** whether the same call can succeed on retry without changes */
  retryable: boolean;
  /** machine-readable specifics, e.g. validation issues */
  details?: unknown;
  [extra: string]: unknown;
};

export interface ToolErrorInit {
  code: ErrorCode;
  cause: string;
  fix: string;
  /** Defaults per code: PAYMENT_REQUIRED, RATE_LIMITED, UPSTREAM_ERROR are retryable; the rest are not. */
  retryable?: boolean;
  details?: unknown;
  /** HTTP status to use when the error is surfaced over plain HTTP. Defaults per code. */
  httpStatus?: number;
  /** Extra top-level fields merged into the serialized body (e.g. a 402's `accepts`). */
  extra?: Record<string, unknown>;
}

export const DEFAULT_RETRYABLE: Readonly<Record<StandardErrorCode, boolean>> = {
  INVALID_INPUT: false,
  NOT_FOUND: false,
  UNAUTHORIZED: false,
  PAYMENT_REQUIRED: true,
  RATE_LIMITED: true,
  UPSTREAM_ERROR: true,
  INTERNAL: false,
};

export const DEFAULT_HTTP_STATUS: Readonly<Record<StandardErrorCode, number>> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  INTERNAL: 500,
};

export const INTERNAL_FIX = "retry; if it persists, report the request id";

function isStandardCode(code: string): code is StandardErrorCode {
  return (ERROR_CODES as readonly string[]).includes(code);
}

/** Throw this (or `toolError(...)`) from a handler to return a structured error to the caller. */
export class McpToolError extends Error {
  readonly code: string;
  override readonly cause: string;
  readonly fix: string;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly httpStatus: number;
  readonly extra?: Record<string, unknown>;

  constructor(init: ToolErrorInit) {
    super(`${init.code}: ${init.cause}`);
    this.name = "McpToolError";
    this.code = init.code;
    this.cause = init.cause;
    this.fix = init.fix;
    this.retryable =
      init.retryable ?? (isStandardCode(init.code) ? DEFAULT_RETRYABLE[init.code] : false);
    this.details = init.details;
    this.httpStatus =
      init.httpStatus ?? (isStandardCode(init.code) ? DEFAULT_HTTP_STATUS[init.code] : 500);
    this.extra = init.extra;
  }

  /** The body agents see: `{ code, cause, fix, retryable, details?, ...extra }`. */
  toJSON(): ToolErrorBody {
    const body: ToolErrorBody = {
      ...this.extra,
      code: this.code,
      cause: this.cause,
      fix: this.fix,
      retryable: this.retryable,
    };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

/** Build a structured error. Object form or `(code, cause, fix, extra?)`. */
export function toolError(init: ToolErrorInit): McpToolError;
export function toolError(
  code: ErrorCode,
  cause: string,
  fix: string,
  extra?: Omit<ToolErrorInit, "code" | "cause" | "fix">,
): McpToolError;
export function toolError(
  codeOrInit: ErrorCode | ToolErrorInit,
  cause?: string,
  fix?: string,
  extra?: Omit<ToolErrorInit, "code" | "cause" | "fix">,
): McpToolError {
  if (typeof codeOrInit === "object") return new McpToolError(codeOrInit);
  return new McpToolError({ code: codeOrInit, cause: cause ?? "", fix: fix ?? "", ...extra });
}

function describeUnknown(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Coerce anything thrown into a `McpToolError`. Unknown errors become `INTERNAL`. */
export function normalizeError(err: unknown): McpToolError {
  if (err instanceof McpToolError) return err;
  return new McpToolError({
    code: "INTERNAL",
    cause: describeUnknown(err),
    fix: INTERNAL_FIX,
    retryable: false,
  });
}

export interface ErrorResultOptions {
  /** Echoed in `_meta.requestId` so "report the request id" is actionable. */
  requestId?: string;
  /** Merged into `_meta` (always includes `httpStatus`). */
  meta?: Record<string, unknown>;
}

/**
 * Turn an error into a `CallToolResult` with `isError: true`. `content[0].text` is the JSON
 * body and `structuredContent` is the same object, so both text-only and structured clients
 * see `{ code, cause, fix, retryable }`.
 */
export function errorResult(err: unknown, opts: ErrorResultOptions = {}): CallToolResult {
  const error = normalizeError(err);
  const body = error.toJSON();
  const meta: Record<string, unknown> = { httpStatus: error.httpStatus };
  if (opts.requestId !== undefined) meta.requestId = opts.requestId;
  Object.assign(meta, opts.meta);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
    _meta: meta,
  };
}

/** True when a result is an error result produced by this kit (or shaped like one). */
export function isErrorResult(result: CallToolResult): boolean {
  return result.isError === true;
}

/** Read the `{ code, cause, fix, retryable }` body out of a tool result, if it is an error. */
export function readErrorBody(result: CallToolResult): ToolErrorBody | undefined {
  if (result.isError !== true) return undefined;
  const structured = result.structuredContent;
  if (structured && typeof structured.code === "string") return structured as ToolErrorBody;
  const first = result.content[0];
  if (first && first.type === "text") {
    try {
      const parsed: unknown = JSON.parse(first.text);
      if (parsed && typeof parsed === "object" && "code" in parsed) return parsed as ToolErrorBody;
    } catch {
      // not JSON
    }
  }
  return undefined;
}
