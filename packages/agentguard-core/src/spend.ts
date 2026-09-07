/**
 * Dollar amounts: from arguments (policy `spend.tools`), from results (`spend.result_fields`)
 * and from LLM usage (`spend.models` + built-in list prices for common models).
 */
import { firstMatch } from "./glob.js";
import type { ModelPrice, Policy, SpendTool } from "./policy.js";

const USD_LIKE = new Set(["usd", "usdc", "usdt", "dai", "$", "us$"]);

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return toNumber(o.amount ?? o.value ?? o.usd ?? o.total);
  }
  return undefined;
}

export function spendRuleFor(
  policy: Policy,
  tool: string,
): { pattern: string; rule: SpendTool } | undefined {
  const pattern = firstMatch(tool, Object.keys(policy.spend.tools));
  if (!pattern) return undefined;
  return { pattern, rule: policy.spend.tools[pattern]! };
}

/** Estimated USD the call will spend, from its arguments. `undefined` when unknown. */
export function estimateSpendFromArgs(
  policy: Policy,
  tool: string,
  args: unknown,
): { usd: number; source: string } | undefined {
  const found = spendRuleFor(policy, tool);
  if (!found) return undefined;
  const { rule, pattern } = found;
  if (rule.amount_arg) {
    const raw = toNumber(getPath(args, rule.amount_arg));
    if (raw !== undefined) {
      if (rule.currency_arg) {
        const currency = getPath(args, rule.currency_arg);
        if (typeof currency === "string" && !USD_LIKE.has(currency.toLowerCase())) {
          return { usd: 0, source: `spend.tools.${pattern}: non-USD currency ${currency}` };
        }
      }
      return { usd: raw / rule.divisor, source: `spend.tools.${pattern}.amount_arg` };
    }
  }
  if (rule.fixed_usd !== undefined)
    return { usd: rule.fixed_usd, source: `spend.tools.${pattern}.fixed_usd` };
  return undefined;
}

/** USD reported by the tool's result (structured content or JSON text). */
export function extractSpendFromResult(policy: Policy, result: unknown): number | undefined {
  const candidates: unknown[] = [];
  if (result && typeof result === "object") {
    candidates.push(result);
    const r = result as Record<string, unknown>;
    if (r.structuredContent) candidates.push(r.structuredContent);
    if (r._meta) candidates.push({ _meta: r._meta });
    if (Array.isArray(r.content)) {
      for (const block of r.content) {
        if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
          const text = (block as { text?: string }).text;
          if (typeof text === "string" && text.trimStart().startsWith("{")) {
            try {
              candidates.push(JSON.parse(text));
            } catch {
              // not JSON
            }
          }
        }
      }
    }
  }
  for (const candidate of candidates) {
    for (const field of policy.spend.result_fields) {
      const n = toNumber(getPath(candidate, field));
      if (n !== undefined) return n;
    }
  }
  return undefined;
}

/**
 * List prices (USD per million tokens) for common models, checked 2026-09-02. Patterns are tried in
 * order, so specific ids come before family globs. A model that matches nothing is *not* charged —
 * `estimateLlmCost` returns undefined and the caller records the call at $0 with a reason, so an
 * unpriced model shows up in `agentguard report` rather than quietly escaping the cap. Add it to
 * `spend.models` in agentguard.yaml to bring it under the budget.
 */
export const DEFAULT_MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-fable-5*": { input_per_mtok: 10, output_per_mtok: 50, cached_input_per_mtok: 1 },
  "claude-mythos-5*": { input_per_mtok: 10, output_per_mtok: 50, cached_input_per_mtok: 1 },
  "claude-opus-5*": { input_per_mtok: 5, output_per_mtok: 25, cached_input_per_mtok: 0.5 },
  "claude-opus-4-6*": { input_per_mtok: 5, output_per_mtok: 25, cached_input_per_mtok: 0.5 },
  "claude-opus-4-7*": { input_per_mtok: 5, output_per_mtok: 25, cached_input_per_mtok: 0.5 },
  "claude-opus-4-8*": { input_per_mtok: 5, output_per_mtok: 25, cached_input_per_mtok: 0.5 },
  "claude-sonnet-5*": { input_per_mtok: 2, output_per_mtok: 10, cached_input_per_mtok: 0.2 },
  "claude-sonnet-4-6*": { input_per_mtok: 3, output_per_mtok: 15, cached_input_per_mtok: 0.3 },
  "claude-haiku-4-5*": { input_per_mtok: 1, output_per_mtok: 5, cached_input_per_mtok: 0.1 },
  "claude-3-5-haiku*": { input_per_mtok: 0.8, output_per_mtok: 4 },
  "gpt-5-mini*": { input_per_mtok: 0.25, output_per_mtok: 2, cached_input_per_mtok: 0.025 },
  "gpt-5-nano*": { input_per_mtok: 0.05, output_per_mtok: 0.4 },
  "gpt-5*": { input_per_mtok: 1.25, output_per_mtok: 10, cached_input_per_mtok: 0.125 },
  "gpt-4.1-mini*": { input_per_mtok: 0.4, output_per_mtok: 1.6 },
  "gpt-4.1*": { input_per_mtok: 2, output_per_mtok: 8 },
  "gpt-4o-mini*": { input_per_mtok: 0.15, output_per_mtok: 0.6 },
  "gpt-4o*": { input_per_mtok: 2.5, output_per_mtok: 10 },
  "o3*": { input_per_mtok: 2, output_per_mtok: 8 },
  "o4-mini*": { input_per_mtok: 1.1, output_per_mtok: 4.4 },
  "gemini-2.5-pro*": { input_per_mtok: 1.25, output_per_mtok: 10 },
  "gemini-2.5-flash*": { input_per_mtok: 0.3, output_per_mtok: 2.5 },
};

export interface LlmUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
}

export function priceForModel(
  policy: Policy | undefined,
  model: string,
): { price: ModelPrice; pattern: string } | undefined {
  const custom = policy?.spend.models ?? {};
  const customPattern = firstMatch(model, Object.keys(custom));
  if (customPattern) return { price: custom[customPattern]!, pattern: customPattern };
  const builtin = firstMatch(model, Object.keys(DEFAULT_MODEL_PRICES));
  if (builtin) return { price: DEFAULT_MODEL_PRICES[builtin]!, pattern: builtin };
  return undefined;
}

/** USD for an LLM call. `undefined` when the model has no known price. */
export function estimateLlmCost(
  policy: Policy | undefined,
  model: string,
  usage: LlmUsage,
): number | undefined {
  const found = priceForModel(policy, model);
  if (!found) return undefined;
  const { price } = found;
  const cached = usage.cached_input_tokens ?? 0;
  const input = Math.max(0, (usage.input_tokens ?? 0) - cached);
  const usd =
    (input * price.input_per_mtok +
      cached * (price.cached_input_per_mtok ?? price.input_per_mtok) +
      (usage.output_tokens ?? 0) * price.output_per_mtok) /
    1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}
