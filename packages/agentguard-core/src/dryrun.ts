/**
 * Dry-run synthesis: a plausible success shaped by the tool's output schema so the agent keeps
 * going, while the intended mutation is recorded for `agentguard diff`.
 */
import type { MutationVerb } from "./classify.js";

type JsonSchema = Record<string, unknown>;

export interface SynthesizeOptions {
  /** the tool name — used to pick sensible ids */
  tool: string;
  /** arguments the agent sent — echoed back where field names match */
  args?: unknown;
  outputSchema?: JsonSchema;
  now?: () => Date;
  random?: () => string;
}

let counter = 0;
function defaultRandom(): string {
  counter += 1;
  return `dry_${Date.now().toString(36)}${counter.toString(36)}`;
}

function pick<T>(v: T | undefined, fallback: T): T {
  return v === undefined ? fallback : v;
}

function synthString(
  key: string,
  schema: JsonSchema,
  opts: Required<Pick<SynthesizeOptions, "now" | "random">>,
  args: Record<string, unknown>,
): string {
  const lower = key.toLowerCase();
  const fromArgs = args[key];
  if (typeof fromArgs === "string") return fromArgs;
  const format = typeof schema.format === "string" ? schema.format : "";
  if (Array.isArray(schema.enum) && typeof schema.enum[0] === "string")
    return schema.enum[0] as string;
  if (format === "date-time" || /(_at|at|date|time|timestamp)$/i.test(key))
    return opts.now().toISOString();
  if (format === "date") return opts.now().toISOString().slice(0, 10);
  if (format === "email" || lower.includes("email")) return "dry-run@example.invalid";
  if (format === "uri" || format === "url" || lower.includes("url") || lower.includes("link"))
    return "https://example.invalid/dry-run";
  if (format === "uuid") return "00000000-0000-4000-8000-000000000000";
  if (/(^|_)id$|_id$|^id$|uuid|key$/i.test(key)) return opts.random();
  if (lower === "status" || lower === "state") return "ok";
  if (lower.includes("name") || lower.includes("title")) return "dry run";
  if (lower.includes("message")) return "dry run — no change was made";
  return "dry-run";
}

function synth(
  schema: JsonSchema | undefined,
  key: string,
  opts: Required<Pick<SynthesizeOptions, "now" | "random">>,
  args: Record<string, unknown>,
  depth: number,
): unknown {
  if (!schema || depth > 6) return null;
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  const anyOf = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    const nonNull = anyOf.find((s) => s.type !== "null") ?? anyOf[0]!;
    return synth(nonNull, key, opts, args, depth + 1);
  }
  let type = schema.type;
  if (Array.isArray(type)) type = type.find((t) => t !== "null") ?? type[0];
  if (type === undefined && schema.properties) type = "object";
  if (type === undefined && schema.items) type = "array";
  switch (type) {
    case "string":
      return synthString(key, schema, opts, args);
    case "integer":
    case "number": {
      if (Array.isArray(schema.enum)) return schema.enum[0];
      const fromArgs = args[key];
      if (typeof fromArgs === "number") return fromArgs;
      if (typeof schema.minimum === "number") return schema.minimum;
      if (/count|total|size|length|affected|rows|n$/i.test(key)) return 1;
      return 0;
    }
    case "boolean":
      return /(^|_)(ok|success|done|created|updated|deleted|sent|accepted)$/i.test(key)
        ? true
        : pick(args[key] as boolean | undefined, true);
    case "null":
      return null;
    case "array": {
      const items = schema.items as JsonSchema | undefined;
      const min = typeof schema.minItems === "number" ? schema.minItems : 0;
      if (min === 0) return [];
      return [synth(items, key, opts, args, depth + 1)];
    }
    case "object": {
      const out: Record<string, unknown> = {};
      const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
      const required = Array.isArray(schema.required)
        ? (schema.required as string[])
        : Object.keys(props);
      for (const [name, sub] of Object.entries(props)) {
        if (required.includes(name) || depth === 0)
          out[name] = synth(sub, name, opts, args, depth + 1);
      }
      if (Object.keys(props).length === 0 && depth === 0)
        return { ok: true, id: opts.random(), dry_run: true };
      return out;
    }
    default:
      return synthString(key, schema, opts, args);
  }
}

/** A plausible success value for a faked write. */
export function synthesizeResult(options: SynthesizeOptions): unknown {
  const opts = { now: options.now ?? (() => new Date()), random: options.random ?? defaultRandom };
  const args =
    options.args && typeof options.args === "object" && !Array.isArray(options.args)
      ? (options.args as Record<string, unknown>)
      : {};
  if (!options.outputSchema) {
    return {
      ok: true,
      id: opts.random(),
      dry_run: true,
      message: `${options.tool} was not executed (agentguard dry-run); this is a synthetic success`,
    };
  }
  return synth(options.outputSchema, "", opts, args, 0);
}

export interface MutationRecord {
  tool: string;
  verb: MutationVerb;
  /** the upstream that would have received it */
  upstream?: string;
  /** what the agent asked for (redacted, possibly truncated) */
  args: unknown;
  /** the record the mutation targets, if an id-like argument was found */
  target?: string;
  /** dollars the call would have spent (spend class) */
  usd?: number;
}

const ID_KEYS = [
  "id",
  "ids",
  "record_id",
  "contact_id",
  "user_id",
  "customer_id",
  "path",
  "file",
  "key",
  "uri",
  "url",
  "name",
  "email",
  "to",
  "channel",
  "table",
  "query",
];

/** Best-effort "what record does this touch" for the diff and report. */
export function mutationTarget(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const obj = args as Record<string, unknown>;
  for (const key of ID_KEYS) {
    const v = obj[key];
    if (typeof v === "string" || typeof v === "number") return `${key}=${String(v).slice(0, 120)}`;
    if (Array.isArray(v) && v.length > 0) return `${key}=[${v.length} items]`;
  }
  for (const [key, v] of Object.entries(obj)) {
    if (/id$/i.test(key) && (typeof v === "string" || typeof v === "number"))
      return `${key}=${String(v).slice(0, 120)}`;
  }
  return undefined;
}
