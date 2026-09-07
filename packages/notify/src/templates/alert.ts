import {
  button,
  callout,
  code,
  escapeHtml,
  formatDate,
  h1,
  h2,
  layout,
  link,
  muted,
  p,
  pHtml,
  pill,
  plural,
  pre,
  toText,
} from "../html.js";
import type { RenderedEmail } from "./types.js";

export interface AlertError {
  code: string;
  cause?: string;
  fix?: string;
}

export interface AlertDiff {
  /** Response/transcript from the last passing run. */
  before: string;
  /** Response/transcript from the failing run. */
  after: string;
}

export interface AlertTemplateInput {
  productName: string;
  targetName: string;
  checkName: string;
  statusUrl: string;
  openedAt: string | Date;
  error: AlertError;
  /** Excerpt of the failing transcript (rendered verbatim in a <pre>). */
  transcriptExcerpt?: string;
  /** Either a unified diff string or a before/after pair vs the last pass. */
  diff?: AlertDiff | string;
  consecutiveFailures: number;
  /**
   * Link that silences this check for 24h. Defaults to `${statusUrl}?silence=24h`
   * until the product wires a real route.
   */
  silenceUrl?: string;
}

/** Monitor failed: leads with what failed, then transcript, then diff vs last pass. */
export function alertTemplate(input: AlertTemplateInput): RenderedEmail {
  const { productName, targetName, checkName, statusUrl, error } = input;
  const silenceUrl =
    input.silenceUrl ?? `${statusUrl}${statusUrl.includes("?") ? "&" : "?"}silence=24h`;
  const failures = plural(input.consecutiveFailures, "consecutive failure");
  const since = formatDate(input.openedAt);

  const subject = `[${productName}] FAILING: ${targetName} · ${checkName}`;

  const errorLines = [
    `<div style="margin:0 0 6px 0;">${pill("FAILING", "red")}&nbsp; ${code(error.code)}</div>`,
    error.cause ? pHtml(`<strong>Cause:</strong> ${escapeHtml(error.cause)}`) : "",
    error.fix ? pHtml(`<strong>Fix:</strong> ${escapeHtml(error.fix)}`) : "",
  ].join("");

  let diffHtml = "";
  if (typeof input.diff === "string" && input.diff.trim()) {
    diffHtml = h2("Diff vs last pass") + pre(input.diff);
  } else if (input.diff && typeof input.diff === "object") {
    diffHtml =
      h2("Diff vs last pass") +
      muted("Last pass") +
      pre(input.diff.before, { maxChars: 2000 }) +
      muted("Now") +
      pre(input.diff.after, { maxChars: 2000 });
  }

  const bodyHtml =
    h1(`${checkName} is failing on ${targetName}`) +
    p(`${failures} since ${since}.`) +
    callout(errorLines, "red") +
    (input.transcriptExcerpt ? h2("Failing transcript") + pre(input.transcriptExcerpt) : "") +
    diffHtml +
    button(statusUrl, "Open status page") +
    pHtml(`${link(statusUrl, "Status page")} · ${link(silenceUrl, "Silence this check for 24h")}`);

  const html = layout({
    title: subject,
    preheader: `${error.code}${error.cause ? `: ${error.cause}` : ""} (${failures})`,
    bodyHtml,
    footerHtml: `${escapeHtml(productName)} opened this incident automatically. It closes on the first passing run.`,
  });

  return { subject, html, text: toText(html) };
}
