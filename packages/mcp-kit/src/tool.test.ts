import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { McpToolError, errorResult, readErrorBody, toolError } from "./errors.js";
import { createMcpServer, listToolManifest } from "./server.js";
import { assertToolName, createToolContext, defineTool, isValidToolName } from "./tool.js";

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected a text block");
  return first.text;
}

const add = defineTool({
  name: "test_add_numbers",
  description: "Add two numbers and return the sum as structured content.",
  input: z.object({ a: z.number(), b: z.number() }),
  output: z.object({ sum: z.number() }),
  handler: ({ a, b }) => ({ sum: a + b }),
});

describe("naming lint", () => {
  it("accepts <namespace>_<verb>_<object>", () => {
    expect(isValidToolName("agentcheck_create_target")).toBe(true);
    expect(() => assertToolName("agentcheck_create_target")).not.toThrow();
    expect(isValidToolName("re_deal_memo2")).toBe(false); // namespace shorter than 3
    expect(isValidToolName("shelf_deal_memo2")).toBe(true);
  });

  it.each([
    "create",
    "Agentcheck_x",
    "ab_c",
    "agentcheck__x",
    "_agentcheck_x",
    "agentcheck_x_",
    "agentcheck-x",
  ])("rejects %s", (name) => {
    expect(isValidToolName(name)).toBe(false);
    expect(() =>
      defineTool({
        name,
        description: "A description that is long enough to pass the lint.",
        input: z.object({}),
        handler: () => ({}),
      }),
    ).toThrow(/tool name must be namespaced: <namespace>_<verb>_<object>, got/);
  });

  it("rejects short descriptions", () => {
    expect(() =>
      defineTool({
        name: "test_short_desc",
        description: "too short",
        input: z.object({}),
        handler: () => ({}),
      }),
    ).toThrow(/description must be at least 20 characters/);
  });
});

describe("defineTool().invoke", () => {
  it("returns structuredContent plus a JSON text block", async () => {
    const result = await add.invoke({ a: 2, b: 3 }, createToolContext());
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ sum: 5 });
    expect(JSON.parse(textOf(result))).toEqual({ sum: 5 });
  });

  it("invalid input → INVALID_INPUT naming the offending fields", async () => {
    const result = await add.invoke({ a: "x" }, createToolContext({ requestId: "req-7" }));
    expect(result.isError).toBe(true);
    const body = readErrorBody(result);
    expect(body?.code).toBe("INVALID_INPUT");
    expect(body?.retryable).toBe(false);
    expect(body?.fix).toContain("a");
    expect(body?.fix).toContain("b");
    expect((body?.details as { fields: string[] }).fields).toEqual(["a", "b"]);
    expect(result._meta).toMatchObject({ httpStatus: 400, requestId: "req-7" });
    // the tool declares an output schema, so the error body travels as text only
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(textOf(result)).code).toBe("INVALID_INPUT");
  });

  it("handler throw → INTERNAL with the request id", async () => {
    const boom = defineTool({
      name: "test_throw_error",
      description: "Always throws a plain Error to exercise the INTERNAL mapping.",
      input: z.object({}),
      handler: () => {
        throw new Error("kaboom");
      },
    });
    const result = await boom.invoke({}, createToolContext({ requestId: "req-1" }));
    expect(result.isError).toBe(true);
    const body = readErrorBody(result);
    expect(body).toMatchObject({
      code: "INTERNAL",
      cause: "kaboom",
      fix: "retry; if it persists, report the request id",
      retryable: false,
    });
    expect(result.structuredContent).toEqual(body);
    expect(result._meta).toMatchObject({ httpStatus: 500, requestId: "req-1" });
  });

  it("toolError() keeps its code, default retryable and http status", async () => {
    const missing = defineTool({
      name: "test_not_found",
      description: "Throws a structured NOT_FOUND error for the given id.",
      input: z.object({ id: z.string() }),
      handler: ({ id }) => {
        throw toolError("NOT_FOUND", `no monitor ${id}`, "list monitors and use an existing id");
      },
    });
    const result = await missing.invoke({ id: "m1" }, createToolContext());
    expect(readErrorBody(result)).toEqual({
      code: "NOT_FOUND",
      cause: "no monitor m1",
      fix: "list monitors and use an existing id",
      retryable: false,
    });
    expect(result._meta?.httpStatus).toBe(404);
    expect(
      readErrorBody(
        errorResult(toolError({ code: "RATE_LIMITED", cause: "slow down", fix: "wait" })),
      )?.retryable,
    ).toBe(true);
    expect(new McpToolError({ code: "CUSTOM_THING", cause: "c", fix: "f" }).httpStatus).toBe(500);
  });

  it("output schema mismatch → INTERNAL (a tool bug, not a caller bug)", async () => {
    const bad = defineTool({
      name: "test_bad_output",
      description: "Returns a value that violates its own output schema.",
      input: z.object({}),
      output: z.object({ sum: z.number() }),
      handler: () => ({ sum: "five" }) as unknown as { sum: number },
    });
    const body = readErrorBody(await bad.invoke({}, createToolContext()));
    expect(body?.code).toBe("INTERNAL");
    expect(body?.cause).toContain("output schema");
  });

  it("passes ready-made CallToolResults through untouched", async () => {
    const image = defineTool({
      name: "test_image_block",
      description: "Returns an image content block built by the handler itself.",
      input: z.object({}),
      handler: () => ({ content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] }),
    });
    const result = await image.invoke({}, createToolContext());
    expect(result.content[0]?.type).toBe("image");
    expect(result.structuredContent).toBeUndefined();
  });

  it("strips unknown keys and applies defaults", async () => {
    const greet = defineTool({
      name: "test_greet_person",
      description: "Greets a person, defaulting the greeting when omitted.",
      input: z.object({ name: z.string(), greeting: z.string().default("hi") }),
      handler: (input) => input,
    });
    const result = await greet.invoke({ name: "ada", extra: 1 }, createToolContext());
    expect(result.structuredContent).toEqual({ name: "ada", greeting: "hi" });
  });
});

describe("createMcpServer / listToolManifest", () => {
  it("throws on duplicate tool names", () => {
    expect(() => createMcpServer({ name: "t", version: "0", tools: [add, add] })).toThrow(
      /duplicate tool name/,
    );
  });

  it("creates a server with the tools registered", () => {
    const server = createMcpServer({ name: "t", version: "0", tools: [add] });
    expect(server.isConnected()).toBe(false);
  });

  it("renders JSON Schema for input and output", () => {
    const [entry] = listToolManifest([add]);
    expect(entry?.name).toBe("test_add_numbers");
    expect(entry?.inputSchema.type).toBe("object");
    expect(entry?.inputSchema.required).toEqual(["a", "b"]);
    expect(entry?.inputSchema.properties).toHaveProperty("a");
    expect(entry?.outputSchema?.properties).toHaveProperty("sum");
  });
});
