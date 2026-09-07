/**
 * `agentguard.yaml` — the product's UX. Parsed with zod, `${ENV}` substituted, defaults
 * filled. Invalid files fail with `INVALID_POLICY` naming the field and the fix.
 */
import YAML from "yaml";
import { z } from "zod";
import { guardError } from "./errors.js";

const patterns = z.array(z.string().min(1)).default([]);

/** Result fields read as dollars spent, when the policy does not name its own. */
const DEFAULT_RESULT_FIELDS = [
  "cost_usd",
  "amount_usd",
  "spend_usd",
  "_meta.cost_usd",
  "usage.cost_usd",
];

const CapsSchema = z
  .object({
    tool_calls: z.number().nonnegative().optional(),
    writes: z.number().nonnegative().optional(),
    deletes: z.number().nonnegative().optional(),
    emails: z.number().nonnegative().optional(),
    spend_usd: z.number().nonnegative().optional(),
  })
  .catchall(z.number().nonnegative());
export type Caps = z.infer<typeof CapsSchema>;

const CapsBlockSchema = z.object({
  per_run: CapsSchema.default({}),
  per_day: CapsSchema.default({}),
});

const UpstreamSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "letters, digits, _ and - only")
      .max(64),
    /** Streamable HTTP endpoint */
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    /** shorthand for `Authorization: Bearer <auth>` */
    auth: z.string().optional(),
    /** stdio */
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    /** prefix exposed tool names: `true` → `<name>__tool`, string → `<string>__tool` */
    prefix: z.union([z.boolean(), z.string()]).default(false),
    /** per-upstream request timeout in ms (default 60_000) */
    timeout_ms: z.number().positive().default(60_000),
  })
  .refine((u) => Boolean(u.url) !== Boolean(u.command), {
    message: "an upstream needs exactly one of `url` (Streamable HTTP) or `command` (stdio)",
  });
export type Upstream = z.infer<typeof UpstreamSchema>;

const SpendToolSchema = z.object({
  /** argument (dotted path) holding the amount */
  amount_arg: z.string().optional(),
  /** divide the argument by this (100 for cents) */
  divisor: z.number().positive().default(1),
  /** argument holding the currency code; only `usd`-like currencies count by default */
  currency_arg: z.string().optional(),
  /** flat price per call */
  fixed_usd: z.number().nonnegative().optional(),
});
export type SpendTool = z.infer<typeof SpendToolSchema>;

const ModelPriceSchema = z.object({
  input_per_mtok: z.number().nonnegative(),
  output_per_mtok: z.number().nonnegative(),
  cached_input_per_mtok: z.number().nonnegative().optional(),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

const AgentSchema = z.object({
  name: z.string().min(1).max(64),
  /** `sha256:<hex>` of the scoped key handed to the agent; omit for stdio-only agents */
  key_hash: z.string().optional(),
  allow: patterns,
  deny: patterns,
  caps: CapsBlockSchema.optional(),
  mode: z.enum(["dry-run", "enforce"]).optional(),
  /** upstreams this agent may reach (default all) */
  upstreams: z.array(z.string()).optional(),
});
export type AgentScope = z.infer<typeof AgentSchema>;

export const PolicySchema = z.object({
  version: z.literal(1).default(1),
  mode: z.enum(["dry-run", "enforce"]).default("dry-run"),
  upstreams: z.array(UpstreamSchema).default([]),
  classify: z
    .object({
      read: patterns,
      write: patterns,
      spend: patterns,
      /** how a tool nobody could classify is treated in enforce mode */
      unknown: z.enum(["write", "read", "block"]).default("write"),
    })
    .default({ read: [], write: [], spend: [], unknown: "write" }),
  allow: z.array(z.string()).optional(),
  deny: patterns,
  caps: CapsBlockSchema.default({ per_run: {}, per_day: {} }),
  /** custom counters: name → tool patterns. `writes`, `deletes`, `emails` have defaults. */
  counters: z.record(z.string(), z.array(z.string())).default({}),
  loop: z
    .object({
      window: z.number().int().positive().default(30),
      max_repeats: z.number().int().positive().default(3),
      max_cycle_len: z.number().int().positive().default(4),
      ignore_args: z.array(z.string()).default([]),
      /** reads use this (looser) repeat limit; writes and spends use `max_repeats` */
      max_read_repeats: z.number().int().positive().default(10),
    })
    .default({
      window: 30,
      max_repeats: 3,
      max_cycle_len: 4,
      ignore_args: [],
      max_read_repeats: 10,
    }),
  dry_run: z
    .object({
      tools: patterns,
      synthesize: z.boolean().default(true),
    })
    .default({ tools: [], synthesize: true }),
  approval: z
    .object({
      tools: patterns,
      /** seconds to hold the call open waiting for approval (0 → return APPROVAL_REQUIRED at once) */
      wait_s: z.number().nonnegative().default(0),
      /** how long a granted approval stays valid */
      ttl_s: z.number().positive().default(3600),
      notify: z
        .object({
          slack: z.string().optional(),
          webhook: z.string().optional(),
        })
        .default({}),
    })
    .default({ tools: [], wait_s: 0, ttl_s: 3600, notify: {} }),
  kill: z
    .object({
      file: z.string().default(".agentguard/KILL"),
      env: z.string().default("AGENTGUARD_KILL"),
    })
    .default({ file: ".agentguard/KILL", env: "AGENTGUARD_KILL" }),
  spend: z
    .object({
      tools: z.record(z.string(), SpendToolSchema).default({}),
      result_fields: z.array(z.string()).default(DEFAULT_RESULT_FIELDS),
      models: z.record(z.string(), ModelPriceSchema).default({}),
      /** cost assumed for a spend-class call with no other price information */
      default_usd: z.number().nonnegative().default(0),
    })
    // zod returns an object-level default as-is without running the field defaults, so this must
    // spell out the same values. Listing `result_fields: []` here silently switched off
    // result-priced spend for every policy that omits a `spend:` block.
    .default({ tools: {}, result_fields: DEFAULT_RESULT_FIELDS, models: {}, default_usd: 0 }),
  agents: z.array(AgentSchema).default([]),
  audit: z
    .object({
      path: z.string().default(".agentguard/audit.jsonl"),
      redact: z.boolean().default(true),
      include_results: z.boolean().default(false),
      /** truncate recorded args/results to this many characters */
      max_chars: z.number().int().positive().default(4000),
    })
    .default({
      path: ".agentguard/audit.jsonl",
      redact: true,
      include_results: false,
      max_chars: 4000,
    }),
  alerts: z
    .object({
      slack: z.string().optional(),
      webhook: z.string().optional(),
      /** events that trigger alerts */
      on: z
        .array(
          z.enum(["LOOP_DETECTED", "CAP_EXCEEDED", "KILLED", "APPROVAL_REQUIRED", "TOOL_DENIED"]),
        )
        .default(["LOOP_DETECTED", "CAP_EXCEEDED", "KILLED", "APPROVAL_REQUIRED"]),
    })
    .default({ on: ["LOOP_DETECTED", "CAP_EXCEEDED", "KILLED", "APPROVAL_REQUIRED"] }),
  state: z.object({ dir: z.string().default(".agentguard") }).default({ dir: ".agentguard" }),
});

export type Policy = z.infer<typeof PolicySchema>;
export type PolicyInput = z.input<typeof PolicySchema>;
export type Mode = Policy["mode"];

export const DEFAULT_COUNTERS: Record<string, string[]> = {
  deletes: [
    "*delete*",
    "*remove*",
    "*destroy*",
    "*drop*",
    "*truncate*",
    "*purge*",
    "*_rm",
    "rm_*",
    "*wipe*",
  ],
  emails: ["*email*", "*_send_mail*", "*sendmail*", "*_mail_*", "*message_send*", "*send_message*"],
};

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export interface SubstituteResult {
  value: unknown;
  missing: string[];
}

/** Replace `${VAR}` / `${VAR:-default}` in every string. Missing variables are collected. */
export function substituteEnv(
  value: unknown,
  env: Record<string, string | undefined>,
): SubstituteResult {
  const missing = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v.replace(ENV_REF, (_m, name: string, fallback: string | undefined) => {
        const found = env[name];
        if (found !== undefined && found !== "") return found;
        if (fallback !== undefined) return fallback;
        missing.add(name);
        return "";
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) out[k] = walk(item);
      return out;
    }
    return v;
  };
  return { value: walk(value), missing: [...missing] };
}

export interface LoadPolicyOptions {
  env?: Record<string, string | undefined>;
  /** keep going when `${VAR}` is unset (values become empty strings) */
  allowMissingEnv?: boolean;
}

/** Parse a policy object (already JSON/YAML-decoded). Throws `INVALID_POLICY`. */
export function parsePolicy(raw: unknown, opts: LoadPolicyOptions = {}): Policy {
  const { value, missing } = substituteEnv(raw ?? {}, opts.env ?? {});
  if (missing.length > 0 && !opts.allowMissingEnv) {
    throw guardError({
      code: "INVALID_POLICY",
      cause: `agentguard.yaml references unset environment variables: ${missing.join(", ")}`,
      fix: `export ${missing.join(" ")} before starting agentguard, or use \${${missing[0]}:-default}`,
      details: { missing },
    });
  }
  const parsed = PolicySchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`,
    );
    throw guardError({
      code: "INVALID_POLICY",
      cause: `agentguard.yaml is invalid — ${issues.join("; ")}`,
      fix: "fix the listed fields (see https://github.com/agentwares/agentguard/tree/main/apps/agentguard-cli#policy)",
      details: { issues: parsed.error.issues },
    });
  }
  const policy = parsed.data;
  const names = new Set<string>();
  for (const u of policy.upstreams) {
    if (names.has(u.name)) {
      throw guardError({
        code: "INVALID_POLICY",
        cause: `duplicate upstream name "${u.name}"`,
        fix: "give every upstream a unique name",
      });
    }
    names.add(u.name);
  }
  return policy;
}

/** Parse YAML text into a policy. */
export function loadPolicyFromYaml(text: string, opts: LoadPolicyOptions = {}): Policy {
  let raw: unknown;
  try {
    raw = YAML.parse(text) ?? {};
  } catch (err) {
    throw guardError({
      code: "INVALID_POLICY",
      cause: `agentguard.yaml is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      fix: "fix the YAML syntax (a YAML linter shows the line)",
    });
  }
  return parsePolicy(raw, opts);
}

/** The default policy — what you get with an empty file. */
export function defaultPolicy(): Policy {
  return parsePolicy({});
}

/** Effective caps for a run: agent overrides win field-by-field over the policy caps. */
export function effectiveCaps(policy: Policy, agent?: AgentScope | null): Policy["caps"] {
  if (!agent?.caps) return policy.caps;
  return {
    per_run: { ...policy.caps.per_run, ...agent.caps.per_run },
    per_day: { ...policy.caps.per_day, ...agent.caps.per_day },
  };
}

/** Upstream request headers, with the `auth` shorthand applied. Never log the result. */
export function upstreamHeaders(upstream: Upstream): Record<string, string> {
  const headers = { ...upstream.headers };
  if (upstream.auth && !Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) {
    headers.Authorization = upstream.auth.startsWith("Bearer ")
      ? upstream.auth
      : `Bearer ${upstream.auth}`;
  }
  return headers;
}
