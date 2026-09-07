#!/usr/bin/env node
/**
 * `agentguard` — MCP policy proxy: hard spend limits, destructive-action gating with approvals,
 * a kill switch, scoped credentials, dry-run writes, a loop breaker, blast-radius caps and a
 * hash-chained audit log. No LLM calls, no phone-home, no account.
 */
import { readFileSync } from "node:fs";
import { parseArgs, type ParsedArgs } from "./args.js";
import { defaultIo, describeError, type Io } from "./context.js";
import { approvalsCommand, decideCommand, killCommand, resumeCommand } from "./commands/control.js";
import { initCommand } from "./commands/init.js";
import { keyCommand } from "./commands/keys.js";
import { permissionDiffCommand } from "./commands/permission-diff.js";
import { proxyCommand } from "./commands/proxy.js";
import { diffCommand, reportCommand, statusCommand, verifyCommand } from "./commands/report.js";
import { toolsCommand } from "./commands/tools.js";

export function version(): string {
  try {
    return (
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
        version: string;
      }
    ).version;
  } catch {
    return "0.0.0";
  }
}

export const HELP = `agentguard — MCP policy proxy for agents that touch production

  npx @agentwares/agentguard init                 read your MCP config, write agentguard.yaml (dry-run), route every server through the proxy
  agentguard report [--run id|--all]  what this run did / would have destroyed / spent, where it was halted
  agentguard diff [--run id]          record-by-record mutation diff from a dry run
  agentguard verify [audit.jsonl]     prove the hash-chained audit log was not edited

  agentguard proxy [--http --port 8788] [--agent name] [--run-id id] [--mode dry-run|enforce]
  agentguard tools [--json]           the tools your agent will see, with class and why
  agentguard status [--run id]        counters vs caps, kill state, pending approvals

  agentguard kill [reason]            halt every run now (file + running HTTP proxy);  agentguard resume
  agentguard approvals [--all]        pending approvals;  agentguard approve <id> | deny <id> [--note text]
  agentguard key create <agent> [--allow 'crm_get_*']... [--deny p] [--writes n] [--spend n] [--mode m]
  agentguard key list | revoke <agent>
  agentguard permission-diff [--base ref] [--head ref] [--paths a,b] [--format markdown|json] [--fail-on-widen]

Options: --config <agentguard.yaml> (or AGENTGUARD_CONFIG), --json, --help, --version
Docs: https://github.com/agentwares/agentguard/tree/main/apps/agentguard-cli`;

export async function main(argv: readonly string[], io: Io = defaultIo()): Promise<number> {
  const args: ParsedArgs = parseArgs(argv);
  if (args.flags.version) {
    io.out(version());
    return 0;
  }
  if (args.command === undefined && !args.flags.help && io.tty === false) {
    // An MCP client spawned bare `npx @agentwares/agentguard` — that is what server.json registers — and is
    // waiting for JSON-RPC on stdout. Serve the proxy instead of printing help into the stream.
    try {
      return await proxyCommand(args, io);
    } catch (err) {
      io.err(describeError(err));
      return 1;
    }
  }
  if (args.flags.help || args.command === undefined || args.command === "help") {
    io.out(HELP);
    return args.command === undefined && !args.flags.help ? 1 : 0;
  }
  try {
    switch (args.command) {
      case "init":
        return await initCommand(args, io);
      case "proxy":
      case "serve":
        return await proxyCommand(args, io);
      case "report":
        return await reportCommand(args, io);
      case "diff":
        return await diffCommand(args, io);
      case "verify":
        return await verifyCommand(args, io);
      case "status":
        return await statusCommand(args, io);
      case "tools":
        return await toolsCommand(args, io);
      case "kill":
        return await killCommand(args, io);
      case "resume":
        return await resumeCommand(args, io);
      case "approve":
        return await decideCommand("approved", args, io);
      case "deny":
        return await decideCommand("denied", args, io);
      case "approvals":
        return await approvalsCommand(args, io);
      case "key":
      case "keys":
        return await keyCommand(args, io);
      case "permission-diff":
        return await permissionDiffCommand(args, io);
      default:
        io.err(`unknown command "${args.command}"\n`);
        io.err(HELP);
        return 1;
    }
  } catch (err) {
    io.err(describeError(err));
    return 1;
  }
}

const isMain =
  process.argv[1] !== undefined && /(^|\/)(cli\.[cm]?[jt]s|agentguard)$/.test(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${describeError(err)}\n`);
      process.exitCode = 1;
    },
  );
}
