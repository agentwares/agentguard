import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CreateMessageRequestSchema,
  CreateMessageResultSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readErrorBody } from "./errors.js";
import { exampleServerInfo, exampleTools } from "./example.js";
import { createHttpHandler, handleHealth } from "./http.js";
import { serveNodeHttp, type NodeHttpServer } from "./node-http.js";
import { defineTool } from "./tool.js";

describe("stateful sessions", () => {
  const askModel = defineTool({
    name: "test_ask_model",
    description: "Asks the connected client to sample a completion (needs a session).",
    input: z.object({ prompt: z.string() }),
    output: z.object({ text: z.string() }),
    handler: async ({ prompt }, ctx) => {
      if (!ctx.extra) throw new Error("no client context");
      const result = await ctx.extra.sendRequest(
        {
          method: "sampling/createMessage",
          params: {
            messages: [{ role: "user", content: { type: "text", text: prompt } }],
            maxTokens: 10,
          },
        },
        CreateMessageResultSchema,
      );
      const content = Array.isArray(result.content) ? result.content[0] : result.content;
      return { text: content?.type === "text" ? content.text : "" };
    },
  });
  let server: NodeHttpServer;

  beforeAll(async () => {
    server = await serveNodeHttp({
      port: 0,
      handler: createHttpHandler({
        name: "stateful",
        version: "0",
        tools: [askModel],
        sessions: true,
      }),
    });
  });
  afterAll(async () => {
    await server.close();
  });

  it("keeps a session and routes server→client sampling requests", async () => {
    const client = new Client(
      { name: "sampler", version: "0" },
      { capabilities: { sampling: {} } },
    );
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      const first = request.params.messages[0]?.content;
      const text = first && !Array.isArray(first) && first.type === "text" ? first.text : "";
      return {
        role: "assistant",
        model: "fake-model",
        content: { type: "text", text: `echo:${text}` },
      };
    });
    const transport = new StreamableHTTPClientTransport(new URL(server.url));
    await client.connect(transport);
    expect(transport.sessionId).toBeTruthy();

    const result = (await client.callTool({
      name: "test_ask_model",
      arguments: { prompt: "hi" },
    })) as CallToolResult;
    expect(result.structuredContent).toEqual({ text: "echo:hi" });
    await client.close();
  });

  it("answers 404 for an unknown session and 405 for GET without one", async () => {
    const unknown = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "nope",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { code: string }).code).toBe("NOT_FOUND");
    expect((await fetch(server.url)).status).toBe(405);
  });
});

for (const jsonResponse of [true, false]) {
  describe(`HTTP round-trip (jsonResponse=${jsonResponse})`, () => {
    let server: NodeHttpServer;
    let client: Client;

    beforeAll(async () => {
      server = await serveNodeHttp({
        port: 0,
        handler: createHttpHandler({
          ...exampleServerInfo,
          tools: exampleTools,
          jsonResponse,
          cors: true,
        }),
        health: () => handleHealth({ ...exampleServerInfo, tools: exampleTools }),
      });
      client = new Client({ name: "mcp-kit-test", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    });

    afterAll(async () => {
      await client.close();
      await server.close();
    });

    it("listTools returns the 3 example tools with JSON-schema inputSchema", async () => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "example_add",
        "example_echo",
        "example_paid_lookup",
      ]);
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.description?.length ?? 0).toBeGreaterThanOrEqual(20);
      }
      const add = tools.find((t) => t.name === "example_add");
      expect(add?.inputSchema.properties).toHaveProperty("a");
      expect(add?.inputSchema.required).toEqual(["a", "b"]);
      expect(add?.outputSchema?.properties).toHaveProperty("sum");
      expect(add?.annotations?.readOnlyHint).toBe(true);
      const paid = tools.find((t) => t.name === "example_paid_lookup");
      expect(paid?.inputSchema.properties).toHaveProperty("sample");
    });

    it("callTool example_add {a:2,b:3} → structuredContent { sum: 5 }", async () => {
      const result = (await client.callTool({
        name: "example_add",
        arguments: { a: 2, b: 3 },
      })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ sum: 5 });
    });

    it("invalid arguments come back in-band as INVALID_INPUT", async () => {
      const result = (await client.callTool({
        name: "example_add",
        arguments: { a: "two", b: 3 },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      const body = readErrorBody(result);
      expect(body?.code).toBe("INVALID_INPUT");
      expect(body?.fix).toContain("a");
    });

    it("paid tool → PAYMENT_REQUIRED; sample=true → free result", async () => {
      const denied = (await client.callTool({
        name: "example_paid_lookup",
        arguments: { query: "acme" },
      })) as CallToolResult;
      expect(denied.isError).toBe(true);
      const body = readErrorBody(denied);
      expect(body?.code).toBe("PAYMENT_REQUIRED");
      expect(body?.comingSoon).toBe(true);
      expect(denied._meta?.httpStatus).toBe(402);

      const sample = (await client.callTool({
        name: "example_paid_lookup",
        arguments: { query: "acme", sample: true },
      })) as CallToolResult;
      expect(sample.isError).toBeFalsy();
      expect(sample.structuredContent).toMatchObject({ query: "acme", sample: true });
    });

    it("unknown tool → JSON-RPC error", async () => {
      await expect(client.callTool({ name: "example_missing", arguments: {} })).rejects.toThrow(
        /not found/,
      );
    });

    it("GET without a session → 405 JSON", async () => {
      const res = await fetch(server.url);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toContain("POST");
      expect(((await res.json()) as { code: string }).code).toBe("METHOD_NOT_ALLOWED");
    });

    it("OPTIONS preflight carries CORS headers", async () => {
      const res = await fetch(server.url, { method: "OPTIONS" });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("health endpoint", async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(await res.json()).toEqual({
        ok: true,
        name: exampleServerInfo.name,
        version: exampleServerInfo.version,
        tools: 3,
      });
    });

    it("answers a raw JSON-RPC POST without prior initialize (stateless)", async () => {
      const res = await fetch(server.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(200);
      if (jsonResponse) {
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = (await res.json()) as { result: { tools: unknown[] } };
        expect(body.result.tools).toHaveLength(3);
      } else {
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        expect(await res.text()).toContain('"tools"');
      }
    });
  });
}
