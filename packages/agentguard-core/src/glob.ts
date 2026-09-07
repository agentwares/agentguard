/**
 * Tool-name patterns used throughout the policy file: `crm_delete_*`, `*_send`, `stripe_*`,
 * `crm.contacts.delete`, `crm/*`. `*` matches any run of characters (including `_`, `.`, `/`),
 * `?` one character. Matching is case-insensitive. A leading `!` negates.
 */

const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;
  const source = pattern
    .split("")
    .map((ch) => {
      if (ch === "*") return ".*";
      if (ch === "?") return ".";
      return ch.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
    })
    .join("");
  const re = new RegExp(`^${source}$`, "i");
  cache.set(pattern, re);
  return re;
}

export function matchesGlob(name: string, pattern: string): boolean {
  if (pattern.startsWith("!")) return !globToRegExp(pattern.slice(1)).test(name);
  return globToRegExp(pattern).test(name);
}

/** True when `name` matches any pattern in the list (negations exclude). */
export function matchesAny(name: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      if (globToRegExp(pattern.slice(1)).test(name)) return false;
    } else if (globToRegExp(pattern).test(name)) {
      matched = true;
    }
  }
  return matched;
}

/** The first pattern that matches, for "why was this classified as X" explanations. */
export function firstMatch(
  name: string,
  patterns: readonly string[] | undefined,
): string | undefined {
  if (!patterns) return undefined;
  return patterns.find((p) => !p.startsWith("!") && globToRegExp(p).test(name));
}
