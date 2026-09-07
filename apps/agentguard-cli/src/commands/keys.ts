/**
 * `agentguard key create|list|revoke` — scoped agent credentials. The proxy holds upstream tokens;
 * each agent gets its own `agk_…` key whose hash and scope live in agentguard.yaml.
 */
import { readFileSync, writeFileSync } from "node:fs";
import YAML, { isMap, isSeq, YAMLSeq, type YAMLMap } from "yaml";
import { generateAgentKey, hashAgentKey } from "@agentwares/agentguard-core";
import { flagList, flagNumber, flagString, type ParsedArgs } from "../args.js";
import { policyPathFrom, type Io } from "../context.js";

export async function keyCommand(args: ParsedArgs, io: Io): Promise<number> {
  const [sub, name] = args.positionals;
  const path = policyPathFrom(args, io);
  const doc = YAML.parseDocument(readFileSync(path, "utf8"));
  let agents = doc.get("agents");
  if (!isSeq(agents)) {
    agents = new YAMLSeq();
    doc.set("agents", agents);
  }
  const seq = agents as YAMLSeq;
  const items = seq.items.filter(isMap) as YAMLMap[];

  if (sub === "list" || sub === undefined) {
    if (items.length === 0)
      io.out(
        "no agents in agentguard.yaml — create one: agentguard key create <name> --allow 'crm_get_*'",
      );
    for (const a of items) {
      const allow = a.get("allow");
      io.out(
        `${String(a.get("name")).padEnd(20)} key: ${a.get("key_hash") ? "set" : "none (stdio --agent only)"}  allow: ${isSeq(allow) ? allow.items.map(String).join(", ") : "all"}`,
      );
    }
    return 0;
  }
  if (!name) {
    io.err(
      "usage: agentguard key create <agent> [--allow pattern]... [--deny pattern]... [--writes n] [--spend n] [--deletes n] [--emails n] [--tool-calls n] [--mode dry-run|enforce] [--upstream name]...",
    );
    return 1;
  }
  if (sub === "revoke") {
    const idx = items.findIndex((a) => a.get("name") === name);
    if (idx < 0) {
      io.err(`no agent "${name}"`);
      return 1;
    }
    seq.items.splice(seq.items.indexOf(items[idx]!), 1);
    writeFileSync(path, doc.toString());
    io.out(`revoked ${name}: removed from agentguard.yaml (running proxies pick it up on restart)`);
    return 0;
  }
  if (sub !== "create") {
    io.err(`unknown subcommand "${sub}" — use create, list or revoke`);
    return 1;
  }
  const key = generateAgentKey();
  const keyHash = await hashAgentKey(key);
  const existing = items.find((a) => a.get("name") === name);
  const entry: Record<string, unknown> = { name, key_hash: keyHash };
  const allow = flagList(args, "allow");
  const deny = flagList(args, "deny");
  if (allow.length) entry.allow = allow;
  if (deny.length) entry.deny = deny;
  const upstreams = flagList(args, "upstream");
  if (upstreams.length) entry.upstreams = upstreams;
  const mode = flagString(args, "mode");
  if (mode) entry.mode = mode;
  const perRun: Record<string, number> = {};
  for (const [flag, counter] of [
    ["writes", "writes"],
    ["spend", "spend_usd"],
    ["deletes", "deletes"],
    ["emails", "emails"],
    ["tool-calls", "tool_calls"],
  ] as const) {
    const n = flagNumber(args, flag);
    if (n !== undefined) perRun[counter] = n;
  }
  if (Object.keys(perRun).length) entry.caps = { per_run: perRun };
  if (existing) {
    for (const [k, v] of Object.entries(entry)) existing.set(k, v);
  } else {
    seq.add(doc.createNode(entry));
  }
  writeFileSync(path, doc.toString());
  io.err(
    `${existing ? "rotated" : "created"} agent "${name}" in ${path}${allow.length ? ` (allow: ${allow.join(", ")})` : " (allow: all tools)"}`,
  );
  io.err(
    "the key is shown once; give it to the agent as `Authorization: Bearer <key>` (HTTP) — over stdio use `agentguard proxy --agent " +
      name +
      "`",
  );
  io.out(key);
  return 0;
}
