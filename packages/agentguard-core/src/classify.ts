/**
 * Classify a tool as read / write / spend / unknown. Order of precedence:
 * policy overrides (`deny` is not a class) → MCP annotations → name heuristics.
 * In enforce mode an `unknown` tool is treated as a write unless the policy says otherwise.
 */
import { firstMatch, matchesAny } from "./glob.js";
import type { Policy } from "./policy.js";

export type ToolClass = "read" | "write" | "spend" | "unknown";

export interface ToolAnnotationsLike {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [k: string]: unknown;
}

export interface ToolLike {
  name: string;
  description?: string;
  annotations?: ToolAnnotationsLike;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface Classification {
  class: ToolClass;
  /** `policy`, `annotation`, `heuristic`, `none` */
  source: "policy" | "annotation" | "heuristic" | "none";
  /** the pattern, annotation or verb that decided it */
  reason: string;
  /** likely irreversible (delete/purge/…) — drives the `deletes` counter and approval prompts */
  destructive: boolean;
  /** what the call would do, for the mutation diff: create / update / delete / send / spend / execute / read */
  verb: MutationVerb;
}

export type MutationVerb =
  "create" | "update" | "delete" | "send" | "spend" | "execute" | "read" | "unknown";

const SPEND_VERBS = new Set([
  "pay",
  "payment",
  "charge",
  "purchase",
  "buy",
  "order",
  "refund",
  "transfer",
  "spend",
  "checkout",
  "subscribe",
  "topup",
  "withdraw",
  "deposit",
  "invoice",
  "bill",
  "tip",
  "donate",
  "settle",
  "capture",
]);
const SPEND_NAMESPACES = new Set([
  "stripe",
  "x402",
  "paypal",
  "coinbase",
  "braintree",
  "adyen",
  "square",
  "wallet",
  "mpp",
]);

const DELETE_VERBS = new Set([
  "delete",
  "remove",
  "destroy",
  "drop",
  "truncate",
  "purge",
  "rm",
  "rmdir",
  "wipe",
  "clear",
  "erase",
  "terminate",
  "revoke",
  "unlink",
  "prune",
  "nuke",
]);
const CREATE_VERBS = new Set([
  "create",
  "add",
  "insert",
  "new",
  "register",
  "mkdir",
  "upload",
  "import",
  "clone",
  "fork",
  "book",
  "schedule",
  "invite",
  "enroll",
  "open",
]);
const UPDATE_VERBS = new Set([
  "update",
  "set",
  "patch",
  "edit",
  "write",
  "put",
  "modify",
  "change",
  "rename",
  "move",
  "mv",
  "copy",
  "cp",
  "assign",
  "grant",
  "merge",
  "commit",
  "push",
  "revert",
  "reset",
  "restore",
  "archive",
  "unarchive",
  "close",
  "reopen",
  "cancel",
  "approve",
  "reject",
  "resolve",
  "toggle",
  "enable",
  "disable",
  "apply",
  "sync",
  "replace",
  "append",
  "save",
  "tag",
  "label",
  "mark",
  "pin",
  "lock",
  "unlock",
  "rotate",
  "transfer",
]);
const SEND_VERBS = new Set([
  "send",
  "post",
  "publish",
  "email",
  "mail",
  "notify",
  "message",
  "dm",
  "tweet",
  "broadcast",
  "reply",
  "forward",
  "dispatch",
  "sms",
  "call",
]);
const EXECUTE_VERBS = new Set([
  "execute",
  "exec",
  "run",
  "start",
  "stop",
  "restart",
  "deploy",
  "invoke",
  "trigger",
  "launch",
  "kill",
  "spawn",
  "shell",
  "bash",
  "sql",
  "eval",
  "submit",
  "process",
  "migrate",
  "rollback",
  "scale",
  "build",
  "release",
]);
const READ_VERBS = new Set([
  "get",
  "list",
  "search",
  "find",
  "read",
  "fetch",
  "query",
  "describe",
  "show",
  "count",
  "check",
  "view",
  "lookup",
  "browse",
  "head",
  "exists",
  "resolve",
  "status",
  "info",
  "ls",
  "cat",
  "grep",
  "glob",
  "stat",
  "ping",
  "echo",
  "preview",
  "render",
  "calculate",
  "compute",
  "parse",
  "validate",
  "explain",
  "summarize",
  "translate",
  "diff",
  "compare",
  "inspect",
  "select",
  "retrieve",
  "load",
  "scan",
  "detect",
  "analyze",
  "analyse",
  "recommend",
  "suggest",
  "estimate",
  "test",
  "verify",
  "watch",
  "poll",
  "tail",
  "history",
  "metrics",
  "logs",
  "recent",
  "top",
  "whoami",
  "help",
  "version",
  "health",
  "peek",
  "match",
  "filter",
  "sort",
  "format",
  "convert",
  "encode",
  "decode",
  "hash",
  "tokenize",
  "extract",
  "classify",
  "score",
  "rank",
  "generate",
  "draft",
  "plan",
  "think",
  "reason",
  "predict",
  "complete",
  "chat",
  "ask",
  "answer",
  "download",
  "export",
]);

export function tokenizeToolName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export interface HeuristicResult {
  class: ToolClass;
  verb: MutationVerb;
  destructive: boolean;
  reason: string;
}

/** Name-only heuristics (no policy, no annotations). Exported for `agentguard init` suggestions. */
export function classifyByName(name: string): HeuristicResult {
  const tokens = tokenizeToolName(name);
  const namespace = tokens[0] ?? "";
  const find = (set: Set<string>): string | undefined => tokens.find((t) => set.has(t));
  const spend = find(SPEND_VERBS);
  if (spend || SPEND_NAMESPACES.has(namespace)) {
    return {
      class: "spend",
      verb: "spend",
      destructive: false,
      reason: `verb "${spend ?? namespace}"`,
    };
  }
  const del = find(DELETE_VERBS);
  if (del) return { class: "write", verb: "delete", destructive: true, reason: `verb "${del}"` };
  const exec = find(EXECUTE_VERBS);
  if (exec)
    return {
      class: "write",
      verb: "execute",
      destructive: exec === "kill",
      reason: `verb "${exec}"`,
    };
  const send = find(SEND_VERBS);
  if (send) return { class: "write", verb: "send", destructive: false, reason: `verb "${send}"` };
  const create = find(CREATE_VERBS);
  const update = find(UPDATE_VERBS);
  const read = find(READ_VERBS);
  // Prefer the verb that appears first in the name (`get_or_create` reads before it creates, but
  // `create_and_send` is a create). Ties go to the write.
  const candidates = [
    create ? { verb: "create" as const, idx: tokens.indexOf(create), reason: create } : undefined,
    update ? { verb: "update" as const, idx: tokens.indexOf(update), reason: update } : undefined,
    read ? { verb: "read" as const, idx: tokens.indexOf(read), reason: read } : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);
  if (candidates.length > 0) {
    candidates.sort((a, b) => a.idx - b.idx || (a.verb === "read" ? 1 : -1));
    const best = candidates[0]!;
    if (best.verb === "read")
      return { class: "read", verb: "read", destructive: false, reason: `verb "${best.reason}"` };
    return { class: "write", verb: best.verb, destructive: false, reason: `verb "${best.reason}"` };
  }
  return { class: "unknown", verb: "unknown", destructive: false, reason: "no recognizable verb" };
}

function verbFromAnnotations(ann: ToolAnnotationsLike, fallback: MutationVerb): MutationVerb {
  if (ann.readOnlyHint === true) return "read";
  return fallback === "read" || fallback === "unknown" ? "update" : fallback;
}

/** Full classification with policy overrides and annotations. */
export function classifyTool(tool: ToolLike, policy: Policy): Classification {
  const heuristic = classifyByName(tool.name);
  const { classify } = policy;

  const spendPattern = firstMatch(tool.name, classify.spend);
  if (spendPattern) {
    return {
      class: "spend",
      source: "policy",
      reason: `classify.spend: ${spendPattern}`,
      destructive: false,
      verb: "spend",
    };
  }
  const writePattern = firstMatch(tool.name, classify.write);
  if (writePattern) {
    const verb = heuristic.class === "write" ? heuristic.verb : "update";
    return {
      class: "write",
      source: "policy",
      reason: `classify.write: ${writePattern}`,
      destructive: heuristic.destructive,
      verb,
    };
  }
  const readPattern = firstMatch(tool.name, classify.read);
  if (readPattern) {
    return {
      class: "read",
      source: "policy",
      reason: `classify.read: ${readPattern}`,
      destructive: false,
      verb: "read",
    };
  }

  const ann = tool.annotations;
  if (ann && typeof ann.readOnlyHint === "boolean") {
    if (ann.readOnlyHint) {
      return {
        class: "read",
        source: "annotation",
        reason: "readOnlyHint: true",
        destructive: false,
        verb: "read",
      };
    }
    const destructive = ann.destructiveHint === true || heuristic.destructive;
    const cls: ToolClass = heuristic.class === "spend" ? "spend" : "write";
    return {
      class: cls,
      source: "annotation",
      reason: `readOnlyHint: false${ann.destructiveHint === true ? ", destructiveHint: true" : ""}`,
      destructive,
      verb: cls === "spend" ? "spend" : verbFromAnnotations(ann, heuristic.verb),
    };
  }
  if (ann && ann.destructiveHint === true) {
    return {
      class: "write",
      source: "annotation",
      reason: "destructiveHint: true",
      destructive: true,
      verb: heuristic.verb === "unknown" ? "delete" : heuristic.verb,
    };
  }

  if (heuristic.class !== "unknown") {
    return { ...heuristic, source: "heuristic" };
  }
  return {
    class: "unknown",
    source: "none",
    reason: heuristic.reason,
    destructive: false,
    verb: "unknown",
  };
}

/** The class enforcement uses: `unknown` becomes whatever `classify.unknown` says. */
export function effectiveClass(c: Classification, policy: Policy): ToolClass | "block" {
  if (c.class !== "unknown") return c.class;
  return policy.classify.unknown;
}

/** Does this tool count against a named counter? Policy counters override the defaults. */
export function countsFor(
  name: string,
  counters: Record<string, string[]>,
  counter: string,
): boolean {
  return matchesAny(name, counters[counter]);
}
