import { describe, expect, it } from "vitest";
import { SERVER_JSON_SCHEMA_URL, generateServerJson, registryPublishWorkflow } from "./registry.js";

describe("generateServerJson", () => {
  it("emits a remote streamable-http server", () => {
    const json = generateServerJson({
      name: "io.github.agentwares/deal-memo",
      description: "Turn a pitch deck into a deal memo with scored risks.",
      version: "0.1.0",
      repository: {
        url: "https://github.com/agentwares/agentwares",
        source: "github",
        subfolder: "shelf/deal-memo",
      },
      websiteUrl: "https://deal-memo.agentwares.dev",
      remoteUrl: "https://deal-memo.agentwares.dev/mcp",
      npmPackage: { identifier: "@agentwares/deal-memo-mcp", version: "0.1.0" },
    });
    expect(json.$schema).toBe(SERVER_JSON_SCHEMA_URL);
    expect(json.$schema).toMatch(
      /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/.+\/server\.schema\.json$/,
    );
    expect(json.name).toBe("io.github.agentwares/deal-memo");
    expect(json.version).toBe("0.1.0");
    expect(json.remotes?.[0]?.type).toBe("streamable-http");
    expect(json.remotes?.[0]?.url).toBe("https://deal-memo.agentwares.dev/mcp");
    expect(json.packages?.[0]).toMatchObject({
      registryType: "npm",
      registryBaseUrl: "https://registry.npmjs.org",
      identifier: "@agentwares/deal-memo-mcp",
      transport: { type: "stdio" },
    });
    expect(json.repository.subfolder).toBe("shelf/deal-memo");
  });

  it("validates name, description and transports", () => {
    const base = {
      description: "ok",
      version: "1.0.0",
      repository: { url: "https://github.com/a/b", source: "github" as const },
      remoteUrl: "https://a.b/mcp",
    };
    expect(() => generateServerJson({ ...base, name: "no-slash" })).toThrow(/reverse-DNS/);
    expect(() =>
      generateServerJson({ ...base, name: "io.github.a/b", description: "x".repeat(101) }),
    ).toThrow(/1-100/);
    expect(() =>
      generateServerJson({ ...base, name: "io.github.a/b", remoteUrl: undefined }),
    ).toThrow(/at least one/);
    expect(() =>
      generateServerJson({ ...base, name: "io.github.a/b", remoteUrl: "ftp://x" }),
    ).toThrow(/http/);
  });
});

describe("registryPublishWorkflow", () => {
  it("publishes on mcp-* tags with GitHub OIDC", () => {
    const yaml = registryPublishWorkflow({ serverJsonPath: "shelf/deal-memo/server.json" });
    expect(yaml).toContain('tags: ["mcp-*"]');
    expect(yaml).toContain("id-token: write");
    expect(yaml).toContain("mcp-publisher login github-oidc");
    expect(yaml).toContain('mcp-publisher" publish');
    expect(yaml).toContain("releases/latest/download/mcp-publisher_");
    expect(yaml).toContain('SERVER_JSON: "shelf/deal-memo/server.json"');
  });

  it("supports a custom tag pattern and pre-publish steps", () => {
    const yaml = registryPublishWorkflow({
      serverJsonPath: "server.json",
      tagPattern: "v*",
      beforePublish: [{ name: "Build", run: "pnpm install\npnpm build" }],
      publisherVersion: "v1.2.3",
    });
    expect(yaml).toContain('tags: ["v*"]');
    expect(yaml).toContain('- name: "Build"');
    expect(yaml).toContain("          pnpm build");
    expect(yaml).toContain("releases/download/v1.2.3/");
  });
});
