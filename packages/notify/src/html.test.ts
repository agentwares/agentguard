import { describe, expect, it } from "vitest";
import { escapeHtml, formatDate, formatUsd, layout, safeUrl, toText } from "./html.js";

describe("escapeHtml", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;",
    );
  });
  it("renders nullish as empty and numbers as text", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(42)).toBe("42");
  });
});

describe("safeUrl", () => {
  it("keeps http(s) and mailto, rejects other schemes", () => {
    expect(safeUrl("https://example.com/a?b=1&c=2")).toBe("https://example.com/a?b=1&amp;c=2");
    expect(safeUrl("mailto:x@example.com")).toBe("mailto:x@example.com");
    expect(safeUrl("javascript:alert(1)")).toBe("#");
    expect(safeUrl("data:text/html,hi")).toBe("#");
  });
});

describe("layout", () => {
  it("produces a complete, image-free, 600px document with an escaped title", () => {
    const html = layout({
      title: `Hi <b>there</b>`,
      preheader: "Preview <text>",
      bodyHtml: "<p>body</p>",
      footerHtml: "footer",
    });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>Hi &lt;b&gt;there&lt;/b&gt;</title>");
    expect(html).toContain("max-width:600px");
    expect(html).toContain("color-scheme");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).not.toContain("<img");
    expect(html).toContain("<p>body</p>");
    expect(html).toContain("footer");
    expect(html).toContain("Preview &lt;text&gt;");
  });
});

describe("toText", () => {
  it("keeps links as text (url) and drops head/style/preheader", () => {
    const html = layout({
      title: "T",
      preheader: "HIDDEN PREHEADER",
      bodyHtml: `<p>See <a href="https://example.com/x?a=1&amp;b=2">the report</a> now.</p><p><a href="https://example.com/y">https://example.com/y</a></p>`,
    });
    const text = toText(html);
    expect(text).toContain("See the report (https://example.com/x?a=1&b=2) now.");
    expect(text).toContain("https://example.com/y");
    expect(text).not.toContain("https://example.com/y (https://example.com/y)");
    expect(text).not.toContain("HIDDEN PREHEADER");
    expect(text).not.toContain("prefers-color-scheme");
    expect(text).not.toContain("<");
  });

  it("preserves <pre> whitespace, bullets lists, decodes entities and separates cells", () => {
    const html =
      `<h1>Title</h1><ul><li>one</li><li>two &amp; three</li></ul>` +
      `<pre>line 1\n    indented   spaces\nline &lt;3&gt;</pre>` +
      `<table><tr><td>a</td><td>b</td></tr></table><p>tail&nbsp;end</p>`;
    const text = toText(html);
    expect(text).toContain("Title");
    expect(text).toContain("- one\n- two & three");
    expect(text).toContain("line 1\n    indented   spaces\nline <3>");
    expect(text).toContain("a\tb");
    expect(text).toContain("tail end");
    expect(text).not.toMatch(/\n{3,}/);
  });
});

describe("formatters", () => {
  it("formats USD with grouping and small amounts", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(-3)).toBe("-$3.00");
    expect(formatUsd(0.0042)).toBe("$0.0042");
  });
  it("formats dates in UTC and passes through garbage", () => {
    expect(formatDate("2026-09-01T12:34:56Z")).toBe("2026-09-01 12:34 UTC");
    expect(formatDate(new Date(Date.UTC(2026, 0, 2, 3, 4)))).toBe("2026-01-02 03:04 UTC");
    expect(formatDate("not a date")).toBe("not a date");
  });
});
