/**
 * Machine-readable docs every product ships: `llms.txt` and `pricing.json`.
 */
import { listToolManifest } from "./server.js";
import type { ToolDef } from "./tool.js";

export interface LlmsTxtLink {
  title: string;
  url: string;
  note?: string;
}

export interface LlmsTxtSection {
  title: string;
  links: LlmsTxtLink[];
}

export interface RenderLlmsTxtOptions {
  /** product name — becomes the H1 */
  name: string;
  /** one-line summary — becomes the blockquote */
  summary: string;
  /** optional paragraphs after the summary */
  description?: string;
  /** primary links (docs, MCP endpoint, pricing.json, openapi) */
  links: LlmsTxtLink[];
  /** extra sections, e.g. "Optional" */
  sections?: LlmsTxtSection[];
  /** when given, an "MCP tools" section lists name, description and input fields */
  tools?: readonly ToolDef[];
}

function renderLink(link: LlmsTxtLink): string {
  return `- [${link.title}](${link.url})${link.note ? `: ${link.note}` : ""}`;
}

/** Render an llms.txt document (https://llmstxt.org): H1, blockquote summary, link sections. */
export function renderLlmsTxt(opts: RenderLlmsTxtOptions): string {
  const lines: string[] = [`# ${opts.name.trim()}`, "", `> ${opts.summary.trim()}`, ""];
  if (opts.description) lines.push(opts.description.trim(), "");
  lines.push("## Links", "", ...opts.links.map(renderLink), "");
  for (const section of opts.sections ?? []) {
    lines.push(`## ${section.title}`, "", ...section.links.map(renderLink), "");
  }
  if (opts.tools && opts.tools.length > 0) {
    lines.push("## MCP tools", "");
    for (const entry of listToolManifest(opts.tools)) {
      const properties = entry.inputSchema.properties;
      const required = new Set(
        Array.isArray(entry.inputSchema.required) ? (entry.inputSchema.required as string[]) : [],
      );
      const fields =
        properties && typeof properties === "object"
          ? Object.keys(properties as Record<string, unknown>).map((key) =>
              required.has(key) ? key : `${key}?`,
            )
          : [];
      lines.push(
        `- \`${entry.name}\`${fields.length ? ` (${fields.join(", ")})` : ""}: ${entry.description.trim()}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

export interface PricingTier {
  /** stable id used in checkout, e.g. `starter` */
  id: string;
  name: string;
  /** 0 for free tiers */
  priceUsdMonthly: number;
  /** quotas, e.g. `{ monitors: 5, checks_per_day: 288 }` */
  limits: Record<string, number | string | boolean | null>;
  features: string[];
  checkoutUrl?: string;
}

export interface PricingMeter {
  /** Stripe billing meter event name, e.g. `agentcheck_docs_eval_run` */
  eventName: string;
  unitPriceUsd: number;
  /** what one unit is, e.g. `run` */
  unit: string;
  description?: string;
}

export interface PricingJsonOptions {
  product: string;
  currency: "usd";
  tiers: PricingTier[];
  meters?: PricingMeter[];
  checkoutUrl?: string;
  portalUrl?: string;
  updatedAt: string | Date;
}

export interface PricingJson {
  schema: "agentwares.pricing/v1";
  product: string;
  currency: "usd";
  tiers: PricingTier[];
  meters: PricingMeter[];
  checkoutUrl?: string;
  portalUrl?: string;
  /** ISO 8601 */
  updatedAt: string;
}

/** Build the `pricing.json` object served next to every pricing page. */
export function pricingJson(opts: PricingJsonOptions): PricingJson {
  if (opts.tiers.length === 0) throw new Error("pricing.json needs at least one tier");
  const ids = new Set<string>();
  for (const tier of opts.tiers) {
    if (ids.has(tier.id)) throw new Error(`pricing.json: duplicate tier id ${tier.id}`);
    ids.add(tier.id);
    if (!Number.isFinite(tier.priceUsdMonthly) || tier.priceUsdMonthly < 0) {
      throw new Error(`pricing.json: tier ${tier.id} has an invalid priceUsdMonthly`);
    }
  }
  const updatedAt = new Date(opts.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) throw new Error("pricing.json: updatedAt is not a date");

  const json: PricingJson = {
    schema: "agentwares.pricing/v1",
    product: opts.product,
    currency: opts.currency,
    tiers: opts.tiers,
    meters: opts.meters ?? [],
    updatedAt: updatedAt.toISOString(),
  };
  if (opts.checkoutUrl !== undefined) json.checkoutUrl = opts.checkoutUrl;
  if (opts.portalUrl !== undefined) json.portalUrl = opts.portalUrl;
  return json;
}
