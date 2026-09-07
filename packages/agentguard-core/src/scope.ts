/**
 * Per-agent scoped credentials. The proxy holds upstream tokens; agents get a scoped key
 * (`agk_…`). Only `sha256:<hex>` of the key is stored in the policy file.
 */
import { sha256Hex } from "./normalize.js";
import type { AgentScope, Policy } from "./policy.js";

export const KEY_PREFIX = "agk_";

export function generateAgentKey(random: () => string = () => crypto.randomUUID()): string {
  return `${KEY_PREFIX}${random().replace(/-/g, "")}${random().replace(/-/g, "").slice(0, 8)}`;
}

export async function hashAgentKey(key: string): Promise<string> {
  return `sha256:${await sha256Hex(key.trim())}`;
}

/** Resolve the agent for a request: by key (HTTP) or by name (stdio `--agent`). */
export async function resolveAgent(
  policy: Policy,
  opts: { key?: string | null; name?: string | null },
): Promise<{ agent: AgentScope | undefined; error?: "UNKNOWN_KEY" | "UNKNOWN_AGENT" }> {
  if (opts.key) {
    const hash = await hashAgentKey(opts.key);
    const agent = policy.agents.find((a) => a.key_hash === hash);
    return agent ? { agent } : { agent: undefined, error: "UNKNOWN_KEY" };
  }
  if (opts.name) {
    const agent = policy.agents.find((a) => a.name === opts.name);
    return agent ? { agent } : { agent: undefined, error: "UNKNOWN_AGENT" };
  }
  return { agent: undefined };
}

/** Bearer token or X-Agentguard-Key header, if any. */
export function keyFromHeaders(
  headers: Headers | Record<string, string | undefined>,
): string | undefined {
  const get = (name: string): string | undefined =>
    headers instanceof Headers
      ? (headers.get(name) ?? undefined)
      : (headers[name] ?? headers[name.toLowerCase()]);
  const explicit = get("x-agentguard-key");
  if (explicit) return explicit.trim();
  const auth = get("authorization");
  if (auth && /^bearer\s+/i.test(auth)) {
    const token = auth.replace(/^bearer\s+/i, "").trim();
    if (token.startsWith(KEY_PREFIX)) return token;
  }
  return undefined;
}
