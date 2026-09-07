import {
  button,
  escapeHtml,
  formatUsd,
  h1,
  layout,
  link,
  muted,
  p,
  pHtml,
  table,
  toText,
} from "../html.js";
import type { RenderedEmail } from "./types.js";

export interface ReceiptLine {
  description: string;
  amountUsd: number;
}

export interface ReceiptTemplateInput {
  productName: string;
  lines: ReceiptLine[];
  totalUsd: number;
  /** Stripe Customer Portal (or equivalent) URL for invoices and plan changes. */
  portalUrl: string;
  /** Optional invoice/receipt identifier shown in the subject and body. */
  reference?: string;
}

/** Payment receipt: line items, total, link to the billing portal. */
export function receiptTemplate(input: ReceiptTemplateInput): RenderedEmail {
  const { productName, portalUrl } = input;
  const total = formatUsd(input.totalUsd);
  const subject = `[${productName}] Receipt${input.reference ? ` ${input.reference}` : ""}: ${total}`;

  const rows = input.lines.map((l) => [
    escapeHtml(l.description),
    escapeHtml(formatUsd(l.amountUsd)),
  ]);
  rows.push([`<strong>Total</strong>`, `<strong>${escapeHtml(total)}</strong>`]);

  const bodyHtml =
    h1(`Thanks. Here is your receipt.`) +
    (input.reference ? muted(`Reference ${input.reference}`) : "") +
    table([{ header: "Item" }, { header: "Amount", align: "right" }], rows) +
    p("Invoices, plan changes and cancellation are self-serve in the billing portal.") +
    button(portalUrl, "Manage billing") +
    pHtml(link(portalUrl, portalUrl));

  const html = layout({
    title: subject,
    preheader: `${total} paid to ${productName}.`,
    bodyHtml,
    footerHtml: `Sent by ${escapeHtml(productName)}. Reply to this email if something looks wrong.`,
  });

  return { subject, html, text: toText(html) };
}
