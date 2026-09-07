/**
 * Official MCP registry: `server.json` generator and the GitHub Actions workflow that publishes
 * it on tag via `mcp-publisher` with GitHub OIDC (no secrets).
 *
 * Field names follow the 2025-12-11 server.json schema
 * (https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json).
 */

export const SERVER_JSON_SCHEMA_URL =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

/** `^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$` — reverse-DNS namespace, one slash, server name. */
export const SERVER_NAME_PATTERN = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
const MAX_DESCRIPTION_LENGTH = 100;

export interface ServerJsonRepository {
  url: string;
  source: "github";
  /** path inside a monorepo, e.g. `shelf/deal-memo` */
  subfolder?: string;
}

export interface ServerJsonKeyValueInput {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
  format?: "string" | "number" | "boolean" | "filepath";
}

export interface ServerJsonNpmPackage {
  /** npm package name, e.g. `@agentwares/deal-memo-mcp` */
  identifier: string;
  version: string;
  /** default `npx` */
  runtimeHint?: string;
  environmentVariables?: ServerJsonKeyValueInput[];
}

export interface GenerateServerJsonOptions {
  /** reverse-DNS, e.g. `io.github.agentwares/deal-memo` (OIDC publishing needs `io.github.<owner>/`) */
  name: string;
  /** ≤ 100 chars, capabilities not implementation */
  description: string;
  version: string;
  title?: string;
  repository: ServerJsonRepository;
  websiteUrl?: string;
  /** stdio package published to npm (package.json must carry `mcpName: <name>`) */
  npmPackage?: ServerJsonNpmPackage;
  /** hosted Streamable HTTP endpoint, e.g. `https://deal-memo.agentwares.dev/mcp` */
  remoteUrl?: string;
  /** headers the client must send to the remote (e.g. an API key input) */
  remoteHeaders?: ServerJsonKeyValueInput[];
}

export interface ServerJsonPackage {
  registryType: "npm";
  registryBaseUrl: string;
  identifier: string;
  version: string;
  runtimeHint?: string;
  transport: { type: "stdio" };
  environmentVariables?: ServerJsonKeyValueInput[];
}

export interface ServerJsonRemote {
  type: "streamable-http";
  url: string;
  headers?: ServerJsonKeyValueInput[];
}

export interface ServerJson {
  $schema: string;
  name: string;
  description: string;
  title?: string;
  version: string;
  websiteUrl?: string;
  repository: ServerJsonRepository;
  packages?: ServerJsonPackage[];
  remotes?: ServerJsonRemote[];
}

/** Build a `server.json` object for the official MCP registry. Validates the fields it can. */
export function generateServerJson(opts: GenerateServerJsonOptions): ServerJson {
  if (!SERVER_NAME_PATTERN.test(opts.name)) {
    throw new Error(
      `server.json name must be reverse-DNS with exactly one slash (e.g. io.github.acme/my-server), got ${JSON.stringify(opts.name)}`,
    );
  }
  const description = opts.description.trim();
  if (description.length === 0 || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(
      `server.json description must be 1-${MAX_DESCRIPTION_LENGTH} characters, got ${description.length}`,
    );
  }
  if (!opts.version.trim()) throw new Error("server.json version is required");
  if (!opts.npmPackage && !opts.remoteUrl) {
    throw new Error(
      "server.json needs at least one of npmPackage (stdio) or remoteUrl (streamable-http)",
    );
  }
  if (opts.remoteUrl !== undefined && !/^https?:\/\/\S+$/.test(opts.remoteUrl)) {
    throw new Error(`remoteUrl must be an http(s) URL, got ${JSON.stringify(opts.remoteUrl)}`);
  }

  const json: ServerJson = {
    $schema: SERVER_JSON_SCHEMA_URL,
    name: opts.name,
    description,
    version: opts.version,
    repository: { ...opts.repository },
  };
  if (opts.title !== undefined) json.title = opts.title;
  if (opts.websiteUrl !== undefined) json.websiteUrl = opts.websiteUrl;
  if (opts.npmPackage) {
    const pkg: ServerJsonPackage = {
      registryType: "npm",
      registryBaseUrl: "https://registry.npmjs.org",
      identifier: opts.npmPackage.identifier,
      version: opts.npmPackage.version,
      runtimeHint: opts.npmPackage.runtimeHint ?? "npx",
      transport: { type: "stdio" },
    };
    if (opts.npmPackage.environmentVariables?.length) {
      pkg.environmentVariables = opts.npmPackage.environmentVariables;
    }
    json.packages = [pkg];
  }
  if (opts.remoteUrl !== undefined) {
    const remote: ServerJsonRemote = { type: "streamable-http", url: opts.remoteUrl };
    if (opts.remoteHeaders?.length) remote.headers = opts.remoteHeaders;
    json.remotes = [remote];
  }
  return json;
}

export interface RegistryPublishWorkflowOptions {
  /** repo-relative path, e.g. `shelf/deal-memo/server.json` */
  serverJsonPath: string;
  /** tag glob that triggers publishing (default `mcp-*`) */
  tagPattern?: string;
  /** workflow display name */
  workflowName?: string;
  /** commands to run before publishing (e.g. build + npm publish); each becomes a step */
  beforePublish?: { name: string; run: string }[];
  /** pin the mcp-publisher release (default: latest) */
  publisherVersion?: string;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * GitHub Actions workflow (YAML) that publishes `server.json` to the official MCP registry
 * on tags matching `tagPattern`, authenticating with GitHub OIDC (`permissions.id-token: write`).
 * Steps follow the registry's github-actions guide: install mcp-publisher from GitHub releases,
 * `mcp-publisher login github-oidc`, `mcp-publisher publish`.
 */
export function registryPublishWorkflow(opts: RegistryPublishWorkflowOptions): string {
  const tagPattern = opts.tagPattern ?? "mcp-*";
  const name = opts.workflowName ?? "Publish to MCP Registry";
  const releasePath = opts.publisherVersion
    ? `download/${opts.publisherVersion}`
    : "latest/download";
  const before = (opts.beforePublish ?? [])
    .map(
      (step) =>
        `      - name: ${yamlString(step.name)}\n        run: |\n${step.run
          .split("\n")
          .map((line) => `          ${line}`)
          .join("\n")}\n\n`,
    )
    .join("");

  return `name: ${yamlString(name)}

on:
  push:
    tags: [${yamlString(tagPattern)}]

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    env:
      SERVER_JSON: ${yamlString(opts.serverJsonPath)}

    steps:
      - name: Checkout code
        uses: actions/checkout@v5

${before}      - name: Install mcp-publisher
        run: |
          curl -L "https://github.com/modelcontextprotocol/registry/releases/${releasePath}/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher

      - name: Authenticate to MCP Registry (GitHub OIDC)
        run: ./mcp-publisher login github-oidc

      - name: Publish server.json to MCP Registry
        run: |
          dir="$(dirname "$SERVER_JSON")"
          if [ "$(basename "$SERVER_JSON")" != "server.json" ]; then cp "$SERVER_JSON" "$dir/server.json"; fi
          cd "$dir" && "$GITHUB_WORKSPACE/mcp-publisher" publish
`;
}
