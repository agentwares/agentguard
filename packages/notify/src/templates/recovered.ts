import { button, escapeHtml, h1, layout, link, p, pHtml, pill, plural, toText } from "../html.js";
import type { RenderedEmail } from "./types.js";

export interface RecoveredTemplateInput {
  productName: string;
  targetName: string;
  checkName: string;
  statusUrl: string;
  downtimeMinutes: number;
}

/** Incident closed: first passing run after a failure. */
export function recoveredTemplate(input: RecoveredTemplateInput): RenderedEmail {
  const { productName, targetName, checkName, statusUrl } = input;
  const minutes = Math.max(0, Math.round(input.downtimeMinutes));
  const downtime =
    minutes >= 120 ? plural(Math.round(minutes / 60), "hour") : plural(minutes, "minute");
  const subject = `[${productName}] RECOVERED: ${targetName} · ${checkName}`;

  const bodyHtml =
    h1(`${checkName} is passing again on ${targetName}`) +
    pHtml(`${pill("RECOVERED", "green")}&nbsp; back after ${escapeHtml(downtime)} of failures.`) +
    p("The incident is closed. The status page keeps the timeline and the failing transcripts.") +
    button(statusUrl, "Open status page") +
    pHtml(link(statusUrl, statusUrl));

  const html = layout({
    title: subject,
    preheader: `Back after ${downtime}.`,
    bodyHtml,
    footerHtml: `${escapeHtml(productName)} closed this incident automatically.`,
  });

  return { subject, html, text: toText(html) };
}
