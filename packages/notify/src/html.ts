/**
 * Tiny HTML email toolkit. No images, no external CSS, no tracking: inline styles only,
 * max-width 600px, system fonts, readable in light and dark mode. Everything that reaches
 * `layout()` as `bodyHtml` must already be escaped with `escapeHtml()`.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape a value for safe interpolation into HTML text or attribute context. */
export function escapeHtml(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

/** Escape a URL for use in an href. Non http(s)/mailto schemes render as "#". */
export function safeUrl(url: string): string {
  const trimmed = url.trim();
  if (!/^(https?:|mailto:)/i.test(trimmed)) return "#";
  return escapeHtml(trimmed);
}

// ---------------------------------------------------------------------------
// Palette + typography. Inline everywhere; a small <style> block adds dark-mode overrides
// for clients that honour it (Apple Mail, iOS Mail, Outlook for Mac, most webmails).
// ---------------------------------------------------------------------------

export const palette = {
  bg: "#f4f5f7",
  card: "#ffffff",
  text: "#111827",
  muted: "#6b7280",
  border: "#e5e7eb",
  link: "#2563eb",
  codeBg: "#f3f4f6",
  red: "#b91c1c",
  redBg: "#fef2f2",
  green: "#15803d",
  greenBg: "#f0fdf4",
  amber: "#b45309",
  amberBg: "#fffbeb",
  gray: "#374151",
  grayBg: "#f3f4f6",
} as const;

export const fontStack =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
export const monoStack =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

const baseText = `font-family:${fontStack};font-size:15px;line-height:1.55;color:${palette.text};`;

// ---------------------------------------------------------------------------
// Building blocks. Every helper escapes its *text* arguments; `*Html` arguments are trusted.
// ---------------------------------------------------------------------------

export function h1(text: string): string {
  return `<h1 style="${baseText}font-size:22px;line-height:1.3;font-weight:700;margin:0 0 12px 0;">${escapeHtml(text)}</h1>`;
}

export function h2(text: string): string {
  return `<h2 style="${baseText}font-size:16px;line-height:1.3;font-weight:700;margin:24px 0 8px 0;">${escapeHtml(text)}</h2>`;
}

export function p(text: string): string {
  return pHtml(escapeHtml(text));
}

export function pHtml(innerHtml: string): string {
  return `<p style="${baseText}margin:0 0 12px 0;">${innerHtml}</p>`;
}

export function muted(text: string): string {
  return `<p style="${baseText}font-size:13px;color:${palette.muted};margin:0 0 12px 0;">${escapeHtml(text)}</p>`;
}

export function link(href: string, text: string): string {
  return `<a href="${safeUrl(href)}" style="color:${palette.link};text-decoration:underline;">${escapeHtml(text)}</a>`;
}

export function button(href: string, label: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0;"><tr><td style="border-radius:6px;background:${palette.text};">` +
    `<a href="${safeUrl(href)}" style="display:inline-block;padding:10px 18px;font-family:${fontStack};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(label)}</a>` +
    `</td></tr></table>`
  );
}

/** Preformatted block (transcripts, diffs). Preserves whitespace, wraps long lines. */
export function pre(text: string, opts: { maxChars?: number } = {}): string {
  const max = opts.maxChars ?? 4000;
  const body =
    text.length > max ? `${text.slice(0, max)}\n... (${text.length - max} more chars)` : text;
  return `<pre style="font-family:${monoStack};font-size:13px;line-height:1.45;color:${palette.text};background:${palette.codeBg};border:1px solid ${palette.border};border-radius:6px;padding:12px;margin:0 0 12px 0;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;">${escapeHtml(body)}</pre>`;
}

export function code(text: string): string {
  return `<code style="font-family:${monoStack};font-size:13px;background:${palette.codeBg};border-radius:4px;padding:1px 5px;">${escapeHtml(text)}</code>`;
}

export type Tone = "red" | "green" | "amber" | "gray";

function toneColors(tone: Tone): { fg: string; bg: string } {
  switch (tone) {
    case "red":
      return { fg: palette.red, bg: palette.redBg };
    case "green":
      return { fg: palette.green, bg: palette.greenBg };
    case "amber":
      return { fg: palette.amber, bg: palette.amberBg };
    case "gray":
      return { fg: palette.gray, bg: palette.grayBg };
  }
}

/** Small inline status pill. */
export function pill(text: string, tone: Tone): string {
  const c = toneColors(tone);
  return `<span style="display:inline-block;font-family:${fontStack};font-size:12px;font-weight:600;letter-spacing:0.02em;color:${c.fg};background:${c.bg};border:1px solid ${c.fg};border-radius:999px;padding:1px 8px;white-space:nowrap;">${escapeHtml(text)}</span>`;
}

/** Callout box (error details, decisions needed). `innerHtml` is trusted. */
export function callout(innerHtml: string, tone: Tone): string {
  const c = toneColors(tone);
  return `<div style="${baseText}background:${c.bg};border-left:4px solid ${c.fg};border-radius:4px;padding:12px 14px;margin:0 0 16px 0;">${innerHtml}</div>`;
}

export function ul(items: string[]): string {
  const lis = items
    .map((it) => `<li style="${baseText}margin:0 0 6px 0;">${escapeHtml(it)}</li>`)
    .join("");
  return `<ul style="margin:0 0 12px 0;padding-left:20px;">${lis}</ul>`;
}

export interface TableColumn {
  header: string;
  /** Right-align numeric columns. */
  align?: "left" | "right";
}

/** Compact table. Cell values are HTML (already escaped by the caller). */
export function table(columns: TableColumn[], rowsHtml: string[][]): string {
  const th = columns
    .map(
      (c) =>
        `<th align="${c.align ?? "left"}" style="${baseText}font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:${palette.muted};font-weight:600;padding:6px 8px;border-bottom:1px solid ${palette.border};">${escapeHtml(c.header)}</th>`,
    )
    .join("");
  const trs = rowsHtml
    .map(
      (cells) =>
        `<tr>${cells
          .map(
            (cell, i) =>
              `<td align="${columns[i]?.align ?? "left"}" valign="top" style="${baseText}font-size:14px;padding:8px;border-bottom:1px solid ${palette.border};">${cell}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:0 0 16px 0;"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

export function hr(): string {
  return `<hr style="border:0;border-top:1px solid ${palette.border};margin:20px 0;">`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface LayoutOptions {
  /** Used for <title>; shown by some clients as the tab/window name. */
  title: string;
  /** Inbox preview text. Hidden in the rendered body. */
  preheader?: string;
  /** Trusted, already-escaped body HTML. */
  bodyHtml: string;
  /** Trusted footer HTML (sender line, settings links). */
  footerHtml?: string;
}

/**
 * Complete HTML email document: single 600px column, inline styles, no images,
 * `color-scheme: light dark` plus a dark-mode override block so text stays readable.
 */
export function layout({ title, preheader, bodyHtml, footerHtml }: LayoutOptions): string {
  const preheaderHtml = preheader
    ? `<div data-preheader="1" style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${palette.bg};opacity:0;">${escapeHtml(preheader)}${"&#847;&zwnj;&nbsp;".repeat(30)}</div>`
    : "";
  const footer = footerHtml
    ? `<tr><td class="aw-footer" style="${baseText}font-size:12px;line-height:1.5;color:${palette.muted};padding:16px 8px 0 8px;">${footerHtml}</td></tr>`
    : "";
  return (
    `<!DOCTYPE html>` +
    `<html lang="en" xmlns="http://www.w3.org/1999/xhtml">` +
    `<head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="light dark">` +
    `<meta name="supported-color-schemes" content="light dark">` +
    `<title>${escapeHtml(title)}</title>` +
    `<style>` +
    `:root{color-scheme:light dark;supported-color-schemes:light dark;}` +
    `body{margin:0;padding:0;-webkit-text-size-adjust:100%;}` +
    `@media (prefers-color-scheme: dark){` +
    `body,.aw-bg{background:#0b0f19 !important;}` +
    `.aw-card{background:#111827 !important;border-color:#1f2937 !important;}` +
    `.aw-card,.aw-card h1,.aw-card h2,.aw-card p,.aw-card td,.aw-card li{color:#e5e7eb !important;}` +
    `.aw-card pre,.aw-card code{background:#0b0f19 !important;color:#e5e7eb !important;border-color:#1f2937 !important;}` +
    `.aw-card a{color:#93c5fd !important;}` +
    `.aw-card th{color:#9ca3af !important;border-color:#1f2937 !important;}` +
    `.aw-card td{border-color:#1f2937 !important;}` +
    `.aw-footer,.aw-footer p{color:#9ca3af !important;}` +
    `}` +
    `</style>` +
    `</head>` +
    `<body class="aw-bg" style="margin:0;padding:0;background:${palette.bg};">` +
    preheaderHtml +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="aw-bg" style="background:${palette.bg};">` +
    `<tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;width:100%;">` +
    `<tr><td class="aw-card" style="background:${palette.card};border:1px solid ${palette.border};border-radius:8px;padding:28px 28px 20px 28px;${baseText}">` +
    bodyHtml +
    `</td></tr>` +
    footer +
    `</table>` +
    `</td></tr></table>` +
    `</body></html>`
  );
}

// ---------------------------------------------------------------------------
// HTML -> plain text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  zwnj: "",
  zwj: "",
  hellip: "...",
  mdash: "—",
  ndash: "–",
  middot: "·",
  copy: "©",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === "#") {
      const cp =
        ent[1]?.toLowerCase() === "x" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(cp)) return m;
      if (cp === 847) return ""; // combining grapheme joiner used as preheader padding
      try {
        return String.fromCodePoint(cp);
      } catch {
        return m;
      }
    }
    const named = NAMED_ENTITIES[ent.toLowerCase()];
    return named === undefined ? m : named;
  });
}

const PRE_TOKEN = "@@AWPRE";

/**
 * Plain-text rendering of an HTML email: tags stripped, block structure kept as newlines,
 * links kept as `text (url)`, list items bulleted, <pre> whitespace preserved.
 */
export function toText(html: string): string {
  let s = html;
  // Drop non-content regions.
  s = s.replace(/<head[\s\S]*?<\/head>/gi, "");
  s = s.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<[a-z]+[^>]*\bdata-preheader\b[^>]*>[\s\S]*?<\/[a-z]+>/gi, "");

  // Pull <pre> blocks out so whitespace collapsing doesn't touch them.
  const pres: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    const txt = decodeEntities(inner.replace(/<[^>]+>/g, "")).replace(/\s+$/g, "");
    pres.push(txt);
    return `\n${PRE_TOKEN}${pres.length - 1}@@\n`;
  });

  // Links -> "text (url)".
  s = s.replace(
    /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, inner: string) => {
      const text = decodeEntities(inner.replace(/<[^>]+>/g, ""))
        .replace(/\s+/g, " ")
        .trim();
      const url = decodeEntities(href).trim();
      if (!url || url === "#") return text;
      if (!text || text === url) return url;
      return `${text} (${url})`;
    },
  );

  // Structure.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<hr\b[^>]*>/gi, "\n---\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<\/(td|th)>/gi, "\t");
  s = s.replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|blockquote|section)>/gi, "\n");
  s = s.replace(/<(h[1-6]|p|div|table|ul|ol|blockquote|section)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);

  // Whitespace: collapse runs of spaces, trim lines, cap blank lines at one.
  s = s
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \u00a0]+/g, " ")
        .replace(/ ?\t ?/g, "\t")
        .trim(),
    )
    .join("\n")
    .replace(/\t+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Restore <pre> blocks.
  s = s.replace(new RegExp(`${PRE_TOKEN}(\\d+)@@`, "g"), (_m, i: string) => pres[Number(i)] ?? "");
  return s;
}

// ---------------------------------------------------------------------------
// Formatting helpers shared by templates
// ---------------------------------------------------------------------------

export function formatDate(value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return typeof value === "string" ? value : "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function formatUsd(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const fixed = abs > 0 && abs < 0.01 ? abs.toFixed(4) : abs.toFixed(2);
  const [int = "0", frac] = fixed.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${grouped}${frac ? `.${frac}` : ""}`;
}

export function plural(n: number, singular: string, pluralWord = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralWord}`;
}
