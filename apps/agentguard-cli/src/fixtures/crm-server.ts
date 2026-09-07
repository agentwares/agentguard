#!/usr/bin/env node
/**
 * Fake CRM MCP server used by the tests, the demo agent and the README walkthrough. In-memory
 * contacts; every mutation is recorded so tests can assert what really happened upstream.
 *
 *   node dist/fixtures/crm-server.js            # stdio
 *   node dist/fixtures/crm-server.js --http     # Streamable HTTP on 127.0.0.1:<port> (prints the URL)
 */
import {
  createHttpHandler,
  createMcpServer,
  defineTool,
  handleHealth,
  localhostHosts,
  serveNodeHttp,
  serveStdio,
  toolError,
  type ToolDef,
} from "@agentwares/mcp-kit";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface Contact {
  id: string;
  name: string;
  email: string;
  updated_at: string;
}

export interface CrmState {
  contacts: Map<string, Contact>;
  mutations: { tool: string; args: unknown }[];
  emails: { to: string; subject: string }[];
  charges: { customer_id: string; amount_usd: number }[];
}

export function seedState(): CrmState {
  const contacts = new Map<string, Contact>();
  for (const [id, name, email] of [
    ["c_1", "Ada Lovelace", "ada@example.com"],
    ["c_2", "Grace Hopper", "grace@example.com"],
    ["c_3", "Linus Torvalds", "linus@example.com"],
  ] as const) {
    contacts.set(id, { id, name, email, updated_at: "2026-01-01T00:00:00.000Z" });
  }
  return { contacts, mutations: [], emails: [], charges: [] };
}

let counter = 0;
const nextId = (prefix: string): string => `${prefix}_${(++counter).toString(36).padStart(4, "0")}`;

export function crmTools(state: CrmState): ToolDef[] {
  const contactSchema = z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    updated_at: z.string(),
  });
  return [
    defineTool({
      name: "crm_list_contacts",
      description:
        "List every contact in the CRM. Read-only; returns id, name, email and updated_at.",
      input: z.object({ limit: z.number().int().min(1).max(500).default(100) }),
      output: z.object({ contacts: z.array(contactSchema), total: z.number() }),
      annotations: { readOnlyHint: true },
      handler: ({ limit }) => ({
        contacts: [...state.contacts.values()].slice(0, limit),
        total: state.contacts.size,
      }),
    }),
    defineTool({
      name: "crm_get_contact",
      description: "Fetch one contact by id. Read-only; NOT_FOUND when the id does not exist.",
      input: z.object({ id: z.string() }),
      output: contactSchema,
      annotations: { readOnlyHint: true },
      handler: ({ id }) => {
        const c = state.contacts.get(id);
        if (!c)
          throw toolError(
            "NOT_FOUND",
            `no contact ${id}`,
            "call crm_list_contacts and use an existing id",
          );
        return c;
      },
    }),
    defineTool({
      name: "crm_search",
      description:
        "Search contacts by name or email substring. Returns matching contacts (no annotations on purpose).",
      input: z.object({ query: z.string() }),
      handler: ({ query }) => ({
        contacts: [...state.contacts.values()].filter((c) =>
          `${c.name} ${c.email}`.toLowerCase().includes(query.toLowerCase()),
        ),
      }),
    }),
    defineTool({
      name: "crm_create_contact",
      description: "Create a contact. Returns the new id and created_at timestamp.",
      input: z.object({ name: z.string(), email: z.string() }),
      output: z.object({ id: z.string(), created_at: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: ({ name, email }) => {
        const id = nextId("c");
        const now = new Date().toISOString();
        state.contacts.set(id, { id, name, email, updated_at: now });
        state.mutations.push({ tool: "crm_create_contact", args: { name, email } });
        return { id, created_at: now };
      },
    }),
    defineTool({
      name: "crm_update_contact",
      description:
        "Update fields on a contact. Returns the id and updated_at; NOT_FOUND for unknown ids.",
      input: z.object({
        id: z.string(),
        fields: z.object({ name: z.string().optional(), email: z.string().optional() }),
      }),
      output: z.object({ id: z.string(), updated_at: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      handler: ({ id, fields }) => {
        const c = state.contacts.get(id);
        if (!c)
          throw toolError(
            "NOT_FOUND",
            `no contact ${id}`,
            "call crm_list_contacts and use an existing id",
          );
        Object.assign(c, fields, { updated_at: new Date().toISOString() });
        state.mutations.push({ tool: "crm_update_contact", args: { id, fields } });
        return { id, updated_at: c.updated_at };
      },
    }),
    defineTool({
      name: "crm_delete_contact",
      description: "Permanently delete a contact. Irreversible. Returns { deleted, id }.",
      input: z.object({ id: z.string() }),
      output: z.object({ deleted: z.boolean(), id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true },
      handler: ({ id }) => {
        const existed = state.contacts.delete(id);
        state.mutations.push({ tool: "crm_delete_contact", args: { id } });
        return { deleted: existed, id };
      },
    }),
    defineTool({
      name: "crm_send_email",
      description:
        "Send an email to a contact through the CRM. Returns the message id and sent_at.",
      input: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
      output: z.object({ message_id: z.string(), sent_at: z.string() }),
      handler: ({ to, subject }) => {
        state.emails.push({ to, subject });
        state.mutations.push({ tool: "crm_send_email", args: { to, subject } });
        return { message_id: nextId("msg"), sent_at: new Date().toISOString() };
      },
    }),
    defineTool({
      name: "crm_charge_card",
      description:
        "Charge a customer's card on file (amount in cents). Returns the charge id and amount_usd.",
      input: z.object({
        customer_id: z.string(),
        amount_cents: z.number().int().positive(),
        currency: z.string().default("usd"),
      }),
      output: z.object({ charge_id: z.string(), amount_usd: z.number() }),
      handler: ({ customer_id, amount_cents }) => {
        const amount_usd = amount_cents / 100;
        state.charges.push({ customer_id, amount_usd });
        state.mutations.push({ tool: "crm_charge_card", args: { customer_id, amount_usd } });
        return { charge_id: nextId("ch"), amount_usd };
      },
    }),
    defineTool({
      name: "crm_frobnicate",
      description:
        "A tool with no annotations and no recognizable verb — exists to test `unknown` handling.",
      input: z.object({}),
      handler: () => {
        state.mutations.push({ tool: "crm_frobnicate", args: {} });
        return { frobnicated: true };
      },
    }),
    defineTool({
      name: "crm_fail",
      description: "Always returns a structured UPSTREAM_ERROR result, for error-path tests.",
      input: z.object({}),
      annotations: { readOnlyHint: true },
      handler: () => {
        throw toolError("UPSTREAM_ERROR", "the CRM is having a bad day", "retry in a minute", {
          retryable: true,
        });
      },
    }),
  ];
}

export function createCrmMcpServer(state: CrmState = seedState()): McpServer {
  return createMcpServer({
    name: "fake-crm",
    version: "0.1.0",
    instructions: "A fake CRM for agentguard tests. Nothing here is real.",
    tools: crmTools(state),
  });
}

const isMain = process.argv[1] !== undefined && /crm-server\.[cm]?[jt]s$/.test(process.argv[1]);
if (isMain) {
  const state = seedState();
  if (process.argv.includes("--http")) {
    const portArg = process.argv.find((a) => a.startsWith("--port="));
    const port = portArg ? Number(portArg.slice("--port=".length)) : 0;
    const handler = createHttpHandler(() => createCrmMcpServer(state), {
      sessions: true,
      jsonResponse: false,
      allowedHosts: port ? localhostHosts(port) : undefined,
    });
    const server = await serveNodeHttp({
      handler,
      port,
      health: () =>
        handleHealth({ name: "fake-crm", version: "0.1.0", tools: crmTools(state).length }),
    });
    console.log(`fake-crm listening at ${server.url}`);
  } else {
    // The proxy stops us with SIGTERM; exit on it so Node does not warn about the unsettled
    // top-level await into the parent's stderr at the end of the demo.
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
    await serveStdio(createCrmMcpServer(state));
  }
}
