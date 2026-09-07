/**
 * Structured errors an agent can act on. Same wire shape as `@agentwares/mcp-kit`'s tool
 * errors (`{ code, cause, fix, retryable, details? }`) so proxied and SDK-wrapped tools fail
 * identically.
 */

export const GUARD_ERROR_CODES = [
  "KILLED",
  "APPROVAL_REQUIRED",
  "APPROVAL_DENIED",
  "LOOP_DETECTED",
  "CAP_EXCEEDED",
  "TOOL_DENIED",
  "UNKNOWN_TOOL",
  "UPSTREAM_ERROR",
  "INVALID_POLICY",
  "INTERNAL",
] as const;

export type GuardErrorCode = (typeof GUARD_ERROR_CODES)[number] | (string & Record<never, never>);

export interface GuardErrorBody {
  code: string;
  /** what went wrong, one sentence */
  cause: string;
  /** what the caller should do next */
  fix: string;
  /** whether the identical call can succeed on retry without any change */
  retryable: boolean;
  details?: unknown;
  [extra: string]: unknown;
}

export interface GuardErrorInit {
  code: GuardErrorCode;
  cause: string;
  fix: string;
  retryable?: boolean;
  details?: unknown;
  extra?: Record<string, unknown>;
}

const RETRYABLE_DEFAULT: Record<string, boolean> = {
  APPROVAL_REQUIRED: true,
  UPSTREAM_ERROR: true,
};

export class GuardError extends Error {
  readonly code: string;
  override readonly cause: string;
  readonly fix: string;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly extra?: Record<string, unknown>;

  constructor(init: GuardErrorInit) {
    super(`${init.code}: ${init.cause}`);
    this.name = "GuardError";
    this.code = init.code;
    this.cause = init.cause;
    this.fix = init.fix;
    this.retryable = init.retryable ?? RETRYABLE_DEFAULT[init.code] ?? false;
    this.details = init.details;
    this.extra = init.extra;
  }

  toJSON(): GuardErrorBody {
    const body: GuardErrorBody = {
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

export function guardError(init: GuardErrorInit): GuardError {
  return new GuardError(init);
}

export function isGuardError(err: unknown): err is GuardError {
  return err instanceof GuardError;
}

/** Coerce anything into a `GuardErrorBody`; unknown errors become `INTERNAL`. */
export function toErrorBody(err: unknown): GuardErrorBody {
  if (err instanceof GuardError) return err.toJSON();
  if (err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string") {
    const e = err as Partial<GuardErrorBody>;
    return {
      code: e.code as string,
      cause: typeof e.cause === "string" ? e.cause : String(e.cause ?? ""),
      fix: typeof e.fix === "string" ? e.fix : "retry; if it persists, report the audit entry id",
      retryable: e.retryable === true,
      ...(e.details !== undefined ? { details: e.details } : {}),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: "INTERNAL",
    cause: message,
    fix: "retry; if it persists, report the audit entry id",
    retryable: false,
  };
}
