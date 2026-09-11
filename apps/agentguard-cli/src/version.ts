/**
 * The installed package version, read from package.json.
 *
 * It is reported to MCP clients in `serverInfo` and printed by `--version`. Keeping it in one
 * place matters: three hand-written copies had drifted to 0.1.0 while npm served 0.1.2, so a
 * client could not tell which build it was talking to.
 */
import { readFileSync } from "node:fs";

let cached: string | undefined;

export function version(): string {
  if (cached !== undefined) return cached;
  try {
    cached = (
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
        version: string;
      }
    ).version;
  } catch {
    cached = "0.0.0";
  }
  return cached;
}
