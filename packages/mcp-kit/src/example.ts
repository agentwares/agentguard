/**
 * A tiny example server: two free tools and one paid tool. Used by the README, the HTTP
 * round-trip test and the conformance script.
 */
import { z } from "zod";
import { withPayment } from "./payment.js";
import { defineTool, type ToolDef } from "./tool.js";

export const exampleServerInfo = {
  name: "mcp-kit-example",
  version: "0.1.0",
  instructions:
    "Example server built with @agentwares/mcp-kit. Call example_echo to check the connection, example_add to see typed structured output, and example_paid_lookup (sample=true first) to see how paid tools respond.",
};

export const exampleEcho = defineTool({
  name: "example_echo",
  title: "Echo",
  description:
    "Echo a message back unchanged. Use it to check the connection and to see the result shape mcp-kit tools return (JSON text plus structuredContent).",
  input: z.object({ message: z.string().describe("Text to echo back") }),
  output: z.object({ message: z.string() }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: ({ message }) => ({ message }),
});

export const exampleAdd = defineTool({
  name: "example_add",
  title: "Add",
  description:
    "Add two numbers and return their sum as { sum }. Demonstrates typed input and output schemas; send non-numbers to see an INVALID_INPUT error result.",
  input: z.object({
    a: z.number().describe("First addend"),
    b: z.number().describe("Second addend"),
  }),
  output: z.object({ sum: z.number() }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: ({ a, b }) => ({ sum: a + b }),
});

export const examplePaidLookup = withPayment(
  defineTool({
    name: "example_paid_lookup",
    title: "Paid lookup",
    description:
      "Look up a record by query and return { query, result, sample } (fake data). Demonstrates a paid tool: without an entitlement the call returns a PAYMENT_REQUIRED result with x402 and MPP payment options.",
    input: z.object({ query: z.string().min(1).describe("What to look up") }),
    output: z.object({ query: z.string(), result: z.string(), sample: z.boolean() }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: ({ query }, ctx) => ({
      query,
      result: ctx.sample ? `SAMPLE: example record for "${query}"` : `record for "${query}"`,
      sample: ctx.sample === true,
    }),
  }),
  { priceUsd: 0.05, description: "One record lookup" },
);

export const exampleTools: ToolDef[] = [exampleEcho, exampleAdd, examplePaidLookup];
