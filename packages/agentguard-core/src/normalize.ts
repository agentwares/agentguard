/**
 * Argument normalization for the loop detector and the audit log. Two calls that differ only
 * in key order, whitespace, casing, timestamps or opaque ids are the same call to a human — so
 * they are the same call to the loop breaker.
 */

const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX = /^[0-9a-f]{24,}$/i;
const PREFIXED_ID = /^[a-z]{1,8}_[A-Za-z0-9]{8,}$/;

export interface NormalizeOptions {
  /** argument names (top-level or dotted paths) dropped before comparison */
  ignore?: readonly string[];
  /** replace timestamps / uuids / opaque ids with placeholders (default true) */
  collapseVolatile?: boolean;
}

function isVolatileString(value: string): boolean {
  return (
    ISO_DATE.test(value) || UUID.test(value) || LONG_HEX.test(value) || PREFIXED_ID.test(value)
  );
}

function normalizeValue(value: unknown, opts: Required<NormalizeOptions>, path: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/\s+/g, " ").toLowerCase();
    if (opts.collapseVolatile && isVolatileString(value.trim())) return "<volatile>";
    return trimmed;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map((v, i) => normalizeValue(v, opts, `${path}[${i}]`));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      const child = path ? `${path}.${key}` : key;
      if (opts.ignore.includes(key) || opts.ignore.includes(child)) continue;
      out[key] = normalizeValue((value as Record<string, unknown>)[key], opts, child);
    }
    return out;
  }
  return String(value);
}

/** Canonical JSON string of the arguments, stable across key order and volatile fields. */
export function normalizeArgs(args: unknown, options: NormalizeOptions = {}): string {
  const opts: Required<NormalizeOptions> = {
    ignore: options.ignore ?? [],
    collapseVolatile: options.collapseVolatile ?? true,
  };
  return JSON.stringify(normalizeValue(args ?? {}, opts, ""));
}

/** Stable JSON with sorted keys (no collapsing) — used for hashing audit entries. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

const encoder = new TextEncoder();

/** SHA-256 hex via Web Crypto (Node 20+, Workers, browsers). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Redact obvious secrets in arguments before they reach the audit log. */
const SECRET_KEY =
  /(token|secret|password|passwd|api[_-]?key|authorization|cookie|private[_-]?key)/i;
const SECRET_VALUE = /^(sk|rk|pk|ghp|gho|xox[abp]|AKIA)[A-Za-z0-9_-]{8,}/;

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 12) return "<depth>";
  if (typeof value === "string") return SECRET_VALUE.test(value) ? "<redacted>" : value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        SECRET_KEY.test(key) && typeof v === "string" ? "<redacted>" : redactSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}
