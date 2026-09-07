#!/usr/bin/env node
/**
 * Official MCP conformance suite against the proxy with a sample server behind it:
 *   mcp-kit example server (conformance fixtures) ← agentguard proxy (HTTP) ← conformance client
 *
 *   pnpm conformance                 # builds first
 *   pnpm conformance --no-build
 *   pnpm conformance --scenario tools-call-simple-text
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFORMANCE = "@modelcontextprotocol/conformance@0.1.16";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kit = path.resolve(root, "../../packages/mcp-kit");
const argv = process.argv.slice(2);
const skipBuild = argv.includes("--no-build");
const passthrough = argv.filter((a) => a !== "--no-build");

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
      if (res.ok) return await res.json();
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no answer at ${url} within ${timeoutMs}ms`);
}

if (!skipBuild) {
  for (const cwd of [kit, root]) {
    const build = spawnSync("pnpm", ["build"], { cwd, stdio: "inherit" });
    if (build.status !== 0) process.exit(build.status ?? 1);
  }
}

const upstreamPort = await freePort();
const proxyPort = await freePort();
const children = [];
const kill = () => children.forEach((c) => c.kill("SIGTERM"));

const upstream = spawn(
  process.execPath,
  [
    path.join(kit, "dist/example-http.js"),
    `--port=${upstreamPort}`,
    "--conformance",
    "--stateful",
    "--sse",
  ],
  { cwd: kit, stdio: ["ignore", "inherit", "inherit"] },
);
children.push(upstream);
await waitForHealth(`http://127.0.0.1:${upstreamPort}/health`, 15_000);

const dir = mkdtempSync(path.join(tmpdir(), "agentguard-conformance-"));
const policy = path.join(dir, "agentguard.yaml");
writeFileSync(
  policy,
  `mode: enforce
upstreams:
  - name: sample
    url: http://127.0.0.1:${upstreamPort}/mcp
loop: { max_repeats: 10000, max_read_repeats: 10000 }
`,
);
const proxy = spawn(
  process.execPath,
  [
    path.join(root, "dist/cli.js"),
    "proxy",
    "--config",
    policy,
    "--http",
    "--port",
    String(proxyPort),
  ],
  { cwd: dir, stdio: ["ignore", "inherit", "inherit"] },
);
children.push(proxy);
const health = await waitForHealth(`http://127.0.0.1:${proxyPort}/health`, 20_000);
console.log(
  `\nproxy up: ${health.tools} tools via ${health.upstreams.map((u) => `${u.name}(${u.connected ? "ok" : "down"})`).join(", ")}`,
);

try {
  const url = `http://127.0.0.1:${proxyPort}/mcp`;
  const args = ["-y", CONFORMANCE, "server", "--url", url, ...passthrough];
  console.log(`\n> npx ${args.join(" ")}\n`);
  const run = spawnSync("npx", args, { cwd: root, stdio: "inherit", env: process.env });
  process.exitCode = run.status ?? 1;
} finally {
  kill();
}
