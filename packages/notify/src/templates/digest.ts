import {
  button,
  callout,
  escapeHtml,
  formatUsd,
  h1,
  h2,
  layout,
  link,
  muted,
  p,
  pHtml,
  toText,
  ul,
} from "../html.js";
import type { RenderedEmail } from "./types.js";

export interface DigestSection {
  title: string;
  items: string[];
}

export interface DigestTemplateInput {
  productName: string;
  /** Report date, e.g. "2026-09-01" (rendered verbatim). */
  date: string;
  sections: DigestSection[];
  /** Judge/LLM spend for the night, shown to the account owner. */
  costUsd?: number;
  /** Anything that needs a human choice; rendered first when present. */
  decisionsNeeded?: string[];
  reportUrl: string;
}

/** Nightly report: decisions needed first, then each section as a bulleted list. */
export function digestTemplate(input: DigestTemplateInput): RenderedEmail {
  const { productName, date, reportUrl } = input;
  const decisions = (input.decisionsNeeded ?? []).filter((d) => d.trim().length > 0);
  const sections = input.sections.filter((s) => s.items.length > 0);
  const subject = decisions.length
    ? `[${productName}] Nightly report ${date}: ${decisions.length} decision${decisions.length === 1 ? "" : "s"} needed`
    : `[${productName}] Nightly report ${date}`;

  const decisionsHtml = decisions.length
    ? callout(`<strong>Decisions needed</strong>${ul(decisions)}`, "amber")
    : "";

  const sectionsHtml = sections.length
    ? sections.map((s) => h2(s.title) + ul(s.items)).join("")
    : p("Nothing changed overnight. All checks passed.");

  const costHtml =
    input.costUsd !== undefined ? muted(`Overnight judge spend: ${formatUsd(input.costUsd)}.`) : "";

  const bodyHtml =
    h1(`Nightly report for ${date}`) +
    decisionsHtml +
    sectionsHtml +
    costHtml +
    button(reportUrl, "Open full report") +
    pHtml(link(reportUrl, reportUrl));

  const preheader = decisions.length
    ? `${decisions.length} decision${decisions.length === 1 ? "" : "s"} needed. ${decisions[0] ?? ""}`
    : (sections[0]?.items[0] ?? "All checks passed overnight.");

  const html = layout({
    title: subject,
    preheader,
    bodyHtml,
    footerHtml: `Sent by ${escapeHtml(productName)} after the nightly suite finished.`,
  });

  return { subject, html, text: toText(html) };
}
