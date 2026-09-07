/**
 * Shared CLI plumbing: locate and load the policy, build the file-backed guard, print things.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Guard, type ApprovalRecord, type GuardEvent } from "@agentwares/agentguard-core";
import {
  FileApprovalStore,
  FileAuditSink,
  FileKillSwitch,
  FileStateStore,
  loadPolicyFile,
  type LoadedPolicy,
} from "@agentwares/agentguard-core/node";
import { existsSync as exists, readFileSync } from "node:fs";
import type { HttpRegistration } from "./proxy/http.js";
import { registrationPath } from "./proxy/http.js";
import { createAlerter } from "./notify.js";
import { flagString, type ParsedArgs } from "./args.js";

export const DEFAULT_POLICY_FILE = "agentguard.yaml";

import { homedir } from "node:os";

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** false when stdout is a pipe — an MCP client spawned us and wants a server, not the help text */
  tty?: boolean;
}

/**
 * The user's home directory as this invocation sees it. Reads `io.env` rather than
 * calling homedir() so an injected environment is honoured — without this, tests
 * (and any sandboxed run) silently read the real user's client configs.
 */
export function homeFrom(io: Io): string {
  return io.env.HOME ?? io.env.USERPROFILE ?? homedir();
}

export function defaultIo(): Io {
  return {
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
    cwd: process.cwd(),
    env: process.env,
    tty: process.stdout.isTTY === true,
  };
}

export function policyPathFrom(args: ParsedArgs, io: Io): string {
  return resolve(
    io.cwd,
    flagString(args, "config") ?? io.env.AGENTGUARD_CONFIG ?? DEFAULT_POLICY_FILE,
  );
}

export function loadPolicyFor(
  args: ParsedArgs,
  io: Io,
  opts: { allowMissingEnv?: boolean } = {},
): LoadedPolicy {
  return loadPolicyFile(policyPathFrom(args, io), {
    env: io.env,
    allowMissingEnv: opts.allowMissingEnv,
  });
}

export interface FileGuard {
  guard: Guard;
  kill: FileKillSwitch;
  audit: FileAuditSink;
  approvals: FileApprovalStore;
  loaded: LoadedPolicy;
}

/** A guard wired to the state dir, audit file, KILL file and approvals of a loaded policy. */
export function createFileGuard(
  loaded: LoadedPolicy,
  opts: {
    onEvent?: (e: GuardEvent) => void | Promise<void>;
    approvalUrl?: (r: ApprovalRecord) => string | undefined;
    log?: (line: string) => void;
    alerts?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): FileGuard {
  const kill = new FileKillSwitch(loaded.killPath);
  const audit = new FileAuditSink(loaded.auditPath);
  const approvals = new FileApprovalStore(loaded.stateDir);
  const alerter =
    opts.alerts === false
      ? undefined
      : createAlerter({ policy: loaded.policy, approvalUrl: opts.approvalUrl, log: opts.log });
  const guard = new Guard({
    policy: loaded.policy,
    state: new FileStateStore(loaded.stateDir),
    audit,
    kill,
    approvals,
    env: opts.env ?? process.env,
    approvalUrl: opts.approvalUrl,
    onEvent: async (event) => {
      await opts.onEvent?.(event);
      await alerter?.(event);
    },
  });
  return { guard, kill, audit, approvals, loaded };
}

/** A running HTTP proxy for this policy, if one registered itself. */
export function readRegistration(loaded: LoadedPolicy): HttpRegistration | undefined {
  const file = registrationPath(loaded.stateDir);
  if (!exists(file)) return undefined;
  try {
    const reg = JSON.parse(readFileSync(file, "utf8")) as HttpRegistration;
    return reg;
  } catch {
    return undefined;
  }
}

export function approvalUrlFor(
  reg: HttpRegistration | undefined,
): ((r: ApprovalRecord) => string | undefined) | undefined {
  if (!reg) return undefined;
  return (r) => `${reg.baseUrl}/approve/${r.id}?token=${reg.token}`;
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function describeError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && "cause" in err) {
    const e = err as { code: string; cause: string; fix?: string };
    return `${e.code}: ${e.cause}${e.fix ? `\n  fix: ${e.fix}` : ""}`;
  }
  return err instanceof Error ? err.message : String(err);
}
