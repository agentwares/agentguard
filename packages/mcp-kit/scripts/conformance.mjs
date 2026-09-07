#!/usr/bin/env node
/**
 * Build the kit, start the example server (with the conformance fixture tools/resources/prompts)
 * on a free port, run the official MCP conformance suite against it, and exit with its code.
 *
 *   pnpm conformance                  # stateful sessions + SSE responses (full coverage)
 *   pnpm conformance --stateless      # stateless (the serverless default; no sampling/elicitation)
 *   pnpm conformance --json           # JSON responses (no mid-call notifications)
 *   pnpm conformance --no-build       # skip the build step
 *   pnpm conformance --scenario ping  # anything else is passed to `conformance server`
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFORMANCE = "@modelcontextprotocol/conformance@0.1.16";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const jsonMode = argv.includes("--json");
const stateless = argv.includes("--stateless");
const skipBuild = argv.includes("--no-build");
const ownFlags = new Set(["--json", "--stateless", "--no-build"]);
const passthrough = argv.filter((a) => !ownFlags.has(a));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`example server did not answer at ${url} within ${timeoutMs}ms`);
}

if (!skipBuild) {
  const build = spawnSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const port = await freePort();
const serverArgs = [
  path.join(root, "dist/example-http.js"),
  `--port=${port}`,
  "--conformance",
  "--dns-protection",
  ...(stateless ? [] : ["--stateful"]),
  ...(jsonMode ? ["--json"] : ["--sse"]),
];
let finished = false;
const child = spawn(process.execPath, serverArgs, {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
});
child.on("exit", (code) => {
  if (!finished) {
    console.error(`example server exited early (code ${code})`);
    process.exit(1);
  }
});

try {
  await waitForHealth(`http://127.0.0.1:${port}/health`, 15_000);
  const url = `http://127.0.0.1:${port}/mcp`;
  const args = ["-y", CONFORMANCE, "server", "--url", url, ...passthrough];
  console.log(
    `\n> npx ${args.join(" ")}   (${stateless ? "stateless" : "stateful"}, ${jsonMode ? "JSON" : "SSE"} responses)\n`,
  );
  const run = spawnSync("npx", args, { cwd: root, stdio: "inherit", env: process.env });
  process.exitCode = run.status ?? 1;
} finally {
  finished = true;
  child.kill("SIGTERM");
}
