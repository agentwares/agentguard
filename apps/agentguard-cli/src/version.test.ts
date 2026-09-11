import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROXY_VERSION } from "./proxy/server.js";
import { version } from "./version.js";

describe("version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };

  it("reads the installed package version", () => {
    expect(version()).toBe(pkg.version);
    expect(version()).not.toBe("0.0.0");
  });

  // What a client sees in serverInfo must be the build it is actually talking to. These were
  // three separate hand-written literals stuck at 0.1.0 while npm served 0.1.2.
  it("is what the proxy reports to MCP clients", () => {
    expect(PROXY_VERSION).toBe(pkg.version);
  });
});
