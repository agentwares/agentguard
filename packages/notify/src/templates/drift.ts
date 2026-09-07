import {
  button,
  callout,
  escapeHtml,
  formatDate,
  h1,
  h2,
  hr,
  layout,
  link,
  muted,
  p,
  pHtml,
  pill,
  plural,
  table,
  toText,
} from "../html.js";
import type { RenderedEmail } from "./types.js";

export type DriftVerdict = "regressed" | "improved" | "unchanged";

export interface DriftChange {
  check: string;
  before: string;
  after: string;
  verdict: DriftVerdict;
}

export interface DriftTemplateInput {
  productName: string;
  provider: string;
  model: string;
  releasedAt: string | Date;
  targetName: string;
  /** One or two sentences: what the re-run found. */
  summary: string;
  changes: DriftChange[];
  runUrl: string;
  /** Public, forwardable results page. */
  shareUrl: string;
}

const VERDICT_ORDER: Record<DriftVerdict, number> = { regressed: 0, improved: 1, unchanged: 2 };

function verdictPill(v: DriftVerdict): string {
  switch (v) {
    case "regressed":
      return pill("REGRESSED", "red");
    case "improved":
      return pill("IMPROVED", "green");
    case "unchanged":
      return pill("UNCHANGED", "gray");
  }
}

/** Sort a copy: regressed first, then improved, then unchanged; stable within a verdict. */
export function sortDriftChanges(changes: readonly DriftChange[]): DriftChange[] {
  return changes
    .map((c, i) => ({ c, i }))
    .sort((a, b) => VERDICT_ORDER[a.c.verdict] - VERDICT_ORDER[b.c.verdict] || a.i - b.i)
    .map(({ c }) => c);
}

/**
 * "Model X shipped. Here's what changed in your agent." The forwardable one: compact table,
 * regressions on top, a share link, and no account-specific noise.
 */
export function driftTemplate(input: DriftTemplateInput): RenderedEmail {
  const { productName, provider, model, targetName, runUrl, shareUrl } = input;
  const sorted = sortDriftChanges(input.changes);
  const counts = { regressed: 0, improved: 0, unchanged: 0 };
  for (const c of sorted) counts[c.verdict] += 1;

  const headline = `${model} shipped. Here's what changed in ${targetName}.`;
  const subject = counts.regressed
    ? `[${productName}] ${model} shipped: ${plural(counts.regressed, "regression")} in ${targetName}`
    : `[${productName}] ${model} shipped: no regressions in ${targetName}`;

  const countsLine =
    `${pill(`${counts.regressed} regressed`, counts.regressed ? "red" : "gray")} ` +
    `${pill(`${counts.improved} improved`, counts.improved ? "green" : "gray")} ` +
    `${pill(`${counts.unchanged} unchanged`, "gray")}`;

  const tableHtml = sorted.length
    ? table(
        [{ header: "Check" }, { header: "Before" }, { header: "After" }, { header: "Verdict" }],
        sorted.map((c) => [
          `<strong>${escapeHtml(c.check)}</strong>`,
          escapeHtml(c.before),
          escapeHtml(c.after),
          verdictPill(c.verdict),
        ]),
      )
    : p("No checks were re-run for this release.");

  const bodyHtml =
    h1(headline) +
    muted(
      `${provider} released ${model} on ${formatDate(input.releasedAt)}. We re-ran the suite for ${targetName} against it.`,
    ) +
    p(input.summary) +
    pHtml(countsLine) +
    h2("What changed") +
    tableHtml +
    button(runUrl, "See the full run") +
    hr() +
    callout(
      `<strong>Forward this.</strong> Know a team running on ${escapeHtml(model)}? This report is public and safe to share: ${link(shareUrl, shareUrl)}`,
      "gray",
    ) +
    muted(`Re-run automatically by ${productName} when a provider ships a new model or alias.`);

  const html = layout({
    title: subject,
    preheader: counts.regressed
      ? `${plural(counts.regressed, "regression")}, ${counts.improved} improved, ${counts.unchanged} unchanged.`
      : `No regressions. ${counts.improved} improved, ${counts.unchanged} unchanged.`,
    bodyHtml,
    footerHtml: `${escapeHtml(productName)} model-drift re-run. Public results: ${link(shareUrl, "share link")}.`,
  });

  return { subject, html, text: toText(html) };
}
