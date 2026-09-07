/** Tiny argv parser: `--flag value`, `--flag=value`, `--bool`, `--no-bool`, repeated flags → arrays. */
export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

const VALUE_FLAGS = new Set([
  "config",
  "client",
  "mode",
  "port",
  "host",
  "agent",
  "run-id",
  "run",
  "base",
  "head",
  "paths",
  "format",
  "by",
  "note",
  "allow",
  "deny",
  "writes",
  "spend",
  "tool-calls",
  "deletes",
  "emails",
  "reason",
  "url",
  "timeout",
  "out",
  "upstream",
]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { command: undefined, positionals: [], flags: {} };
  const push = (key: string, value: string | boolean): void => {
    const existing = out.flags[key];
    if (existing === undefined) out.flags[key] = value;
    else if (Array.isArray(existing)) existing.push(String(value));
    else out.flags[key] = [String(existing), String(value)];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") {
      out.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        push(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      if (body.startsWith("no-")) {
        push(body.slice(3), false);
        continue;
      }
      const next = argv[i + 1];
      if (VALUE_FLAGS.has(body) && next !== undefined && !next.startsWith("--")) {
        push(body, next);
        i += 1;
      } else push(body, true);
      continue;
    }
    if (arg.startsWith("-") && arg.length === 2) {
      const short: Record<string, string> = {
        c: "config",
        y: "yes",
        h: "help",
        v: "version",
        j: "json",
        a: "all",
      };
      const key = short[arg[1]!] ?? arg[1]!;
      const next = argv[i + 1];
      if (VALUE_FLAGS.has(key) && next !== undefined && !next.startsWith("-")) {
        push(key, next);
        i += 1;
      } else push(key, true);
      continue;
    }
    if (out.command === undefined) out.command = arg;
    else out.positionals.push(arg);
  }
  return out;
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  if (Array.isArray(v)) return v[v.length - 1];
  return typeof v === "string" ? v : undefined;
}

export function flagList(args: ParsedArgs, name: string): string[] {
  const v = args.flags[name];
  if (Array.isArray(v)) return v.flatMap((s) => s.split(","));
  return typeof v === "string" ? v.split(",") : [];
}

export function flagBool(args: ParsedArgs, name: string): boolean | undefined {
  const v = args.flags[name];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v !== "false" && v !== "0";
  return undefined;
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const s = flagString(args, name);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
