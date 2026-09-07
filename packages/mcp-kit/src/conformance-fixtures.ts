/**
 * Fixture tools, resources and prompts with the names and shapes the official conformance
 * suite (`@modelcontextprotocol/conformance`) expects. Add them to any kit server to run
 * `conformance server --url …` against it. Not for production.
 */
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateMessageResultSchema,
  ElicitResultSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type ElicitRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { toolError } from "./errors.js";
import { defineTool, type ToolContext, type ToolDef } from "./tool.js";

/** 1×1 transparent PNG */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
/** 44-byte WAV header, zero samples */
const WAV_BASE64 = "UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

const STATIC_TEXT_URI = "test://static-text";
const STATIC_TEXT = "This is a static text resource for testing.";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Form-mode elicitation schema (the params type is a union with URL-mode elicitation). */
type RequestedSchema = Extract<
  ElicitRequest["params"],
  { requestedSchema: unknown }
>["requestedSchema"];

function embeddedResource(): {
  type: "resource";
  resource: { uri: string; mimeType: string; text: string };
} {
  return {
    type: "resource",
    resource: { uri: STATIC_TEXT_URI, mimeType: "text/plain", text: STATIC_TEXT },
  };
}

function requireExtra(ctx: ToolContext): NonNullable<ToolContext["extra"]> {
  if (!ctx.extra) {
    throw toolError("INTERNAL", "no client connection in this context", "call this tool over MCP");
  }
  return ctx.extra;
}

async function elicit(
  ctx: ToolContext,
  message: string,
  requestedSchema: RequestedSchema,
): Promise<string> {
  const result = await requireExtra(ctx).sendRequest(
    { method: "elicitation/create", params: { message, requestedSchema } },
    ElicitResultSchema,
  );
  return `Elicitation completed: action=${result.action}, content=${JSON.stringify(result.content ?? {})}`;
}

/** The tool fixtures the suite calls by name. */
export const conformanceTools: ToolDef[] = [
  defineTool({
    name: "test_simple_text",
    description: "Conformance fixture: returns a fixed simple text response.",
    input: z.object({}),
    handler: () => "This is a simple text response for testing.",
  }),
  defineTool({
    name: "test_error_handling",
    description: "Conformance fixture: always returns an error result (isError: true).",
    input: z.object({}),
    handler: () => {
      throw toolError({
        code: "UPSTREAM_ERROR",
        cause: "This tool intentionally returns an error for testing",
        fix: "nothing to fix; this fixture always fails",
        retryable: false,
      });
    },
  }),
  defineTool({
    name: "test_image_content",
    description: "Conformance fixture: returns a 1x1 PNG image content block.",
    input: z.object({}),
    handler: () => ({ content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }] }),
  }),
  defineTool({
    name: "test_audio_content",
    description: "Conformance fixture: returns an empty WAV audio content block.",
    input: z.object({}),
    handler: () => ({ content: [{ type: "audio", data: WAV_BASE64, mimeType: "audio/wav" }] }),
  }),
  defineTool({
    name: "test_embedded_resource",
    description: "Conformance fixture: returns an embedded text resource content block.",
    input: z.object({}),
    handler: () => ({ content: [embeddedResource()] }),
  }),
  defineTool({
    name: "test_multiple_content_types",
    description: "Conformance fixture: returns text, image and resource content blocks together.",
    input: z.object({}),
    handler: () => ({
      content: [
        { type: "text", text: "Mixed content response" },
        { type: "image", data: PNG_BASE64, mimeType: "image/png" },
        embeddedResource(),
      ],
    }),
  }),
  defineTool({
    name: "test_tool_with_logging",
    description: "Conformance fixture: emits three info log notifications while running.",
    input: z.object({}),
    handler: async (_input, ctx) => {
      await ctx.log?.("info", "Tool execution started");
      await sleep(50);
      await ctx.log?.("info", "Tool processing data");
      await sleep(50);
      await ctx.log?.("info", "Tool execution completed");
      return "Tool execution completed with logging";
    },
  }),
  defineTool({
    name: "test_tool_with_progress",
    description: "Conformance fixture: reports progress 0/100, 50/100, 100/100 while running.",
    input: z.object({}),
    handler: async (_input, ctx) => {
      await ctx.progress?.(0, 100, "starting");
      await sleep(50);
      await ctx.progress?.(50, 100, "halfway");
      await sleep(50);
      await ctx.progress?.(100, 100, "done");
      return "Tool execution completed with progress";
    },
  }),
  defineTool({
    name: "test_sampling",
    description: "Conformance fixture: asks the client to sample a completion and returns it.",
    input: z.object({ prompt: z.string().describe("Prompt to send to the client's model") }),
    handler: async ({ prompt }, ctx) => {
      const result = await requireExtra(ctx).sendRequest(
        {
          method: "sampling/createMessage",
          params: {
            messages: [{ role: "user", content: { type: "text", text: prompt } }],
            maxTokens: 100,
          },
        },
        CreateMessageResultSchema,
      );
      const content = Array.isArray(result.content) ? result.content[0] : result.content;
      const text = content && content.type === "text" ? content.text : JSON.stringify(content);
      return `Sampling completed (${result.model}): ${text}`;
    },
  }),
  defineTool({
    name: "test_elicitation",
    description: "Conformance fixture: asks the client for user input and reports the outcome.",
    input: z.object({ message: z.string().describe("Message shown to the user") }),
    handler: ({ message }, ctx) =>
      elicit(ctx, message, {
        type: "object",
        properties: {
          name: { type: "string", title: "Name", description: "Your name" },
          email: { type: "string", title: "Email", format: "email" },
        },
        required: ["name"],
      }),
  }),
  defineTool({
    name: "test_elicitation_sep1034_defaults",
    description: "Conformance fixture: elicitation schema with defaults for every primitive type.",
    input: z.object({}),
    handler: (_input, ctx) =>
      elicit(ctx, "Please confirm your details", {
        type: "object",
        properties: {
          name: { type: "string", title: "Name", default: "John Doe" },
          age: { type: "integer", title: "Age", default: 30 },
          score: { type: "number", title: "Score", default: 95.5 },
          status: {
            type: "string",
            title: "Status",
            enum: ["active", "inactive", "pending"],
            default: "active",
          },
          verified: { type: "boolean", title: "Verified", default: true },
        },
      }),
  }),
  defineTool({
    name: "test_elicitation_sep1330_enums",
    description:
      "Conformance fixture: elicitation schema with titled, untitled and multi-select enums.",
    input: z.object({}),
    handler: (_input, ctx) =>
      elicit(ctx, "Pick some options", {
        type: "object",
        properties: {
          untitledSingle: {
            type: "string",
            title: "Untitled single",
            enum: ["red", "green", "blue"],
          },
          titledSingle: {
            type: "string",
            title: "Titled single",
            oneOf: [
              { const: "red", title: "Red" },
              { const: "green", title: "Green" },
              { const: "blue", title: "Blue" },
            ],
          },
          legacyEnum: {
            type: "string",
            title: "Legacy titled",
            enum: ["red", "green", "blue"],
            enumNames: ["Red", "Green", "Blue"],
          },
          untitledMulti: {
            type: "array",
            title: "Untitled multi",
            items: { type: "string", enum: ["red", "green", "blue"] },
          },
          titledMulti: {
            type: "array",
            title: "Titled multi",
            items: {
              anyOf: [
                { const: "red", title: "Red" },
                { const: "green", title: "Green" },
                { const: "blue", title: "Blue" },
              ],
            },
          },
        },
      } as RequestedSchema),
  }),
  defineTool({
    name: "json_schema_2020_12_tool",
    description: "Conformance fixture: input schema with a $defs reference to an address object.",
    input: z.object({
      name: z.string(),
      address: z.object({ street: z.string(), city: z.string() }).meta({ id: "address" }),
    }),
    handler: (input) => input,
  }),
];

/** Register the resource and prompt fixtures on a kit server (call before connecting). */
export function registerConformanceFixtures(server: McpServer): void {
  server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });

  server.registerResource(
    "static-text",
    STATIC_TEXT_URI,
    { title: "Static text", description: "A static text resource", mimeType: "text/plain" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: STATIC_TEXT }] }),
  );
  server.registerResource(
    "static-binary",
    "test://static-binary",
    { title: "Static binary", description: "A static binary resource", mimeType: "image/png" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "image/png", blob: PNG_BASE64 }] }),
  );
  server.registerResource(
    "watched-resource",
    "test://watched-resource",
    {
      title: "Watched resource",
      description: "Supports subscribe/unsubscribe",
      mimeType: "text/plain",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: "watched" }] }),
  );
  server.registerResource(
    "template-data",
    new ResourceTemplate("test://template/{id}/data", { list: undefined }),
    { title: "Template data", description: "Data for an id", mimeType: "text/plain" },
    async (uri, variables) => ({
      contents: [
        { uri: uri.href, mimeType: "text/plain", text: `Data for id ${String(variables.id)}` },
      ],
    }),
  );
  server.server.setRequestHandler(SubscribeRequestSchema, async () => ({}));
  server.server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));

  server.registerPrompt(
    "test_simple_prompt",
    { description: "A simple prompt without arguments" },
    () => ({
      messages: [
        { role: "user", content: { type: "text", text: "This is a simple prompt for testing." } },
      ],
    }),
  );
  server.registerPrompt(
    "test_prompt_with_arguments",
    {
      description: "A prompt with two arguments",
      argsSchema: {
        arg1: completable(z.string().describe("First argument"), (value) =>
          ["test", "testValue1", "testing"].filter((v) => v.startsWith(value)),
        ),
        arg2: z.string().describe("Second argument"),
      },
    },
    ({ arg1, arg2 }) => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: `Prompt with arg1=${arg1} and arg2=${arg2}` },
        },
      ],
    }),
  );
  server.registerPrompt(
    "test_prompt_with_embedded_resource",
    {
      description: "A prompt that embeds a resource",
      argsSchema: { resourceUri: z.string().describe("URI of the resource to embed") },
    },
    ({ resourceUri }) => ({
      messages: [
        { role: "user", content: { type: "text", text: "Here is the resource:" } },
        {
          role: "user",
          content: {
            type: "resource",
            resource: { uri: resourceUri, mimeType: "text/plain", text: STATIC_TEXT },
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    "test_prompt_with_image",
    { description: "A prompt that includes an image" },
    () => ({
      messages: [
        { role: "user", content: { type: "text", text: "Describe this image:" } },
        { role: "user", content: { type: "image", data: PNG_BASE64, mimeType: "image/png" } },
      ],
    }),
  );
}
