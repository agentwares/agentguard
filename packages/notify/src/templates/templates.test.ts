import { describe, expect, it } from "vitest";
import {
  alertTemplate,
  digestTemplate,
  driftTemplate,
  receiptTemplate,
  recoveredTemplate,
  sortDriftChanges,
  type AlertTemplateInput,
  type DigestTemplateInput,
  type DriftTemplateInput,
  type ReceiptTemplateInput,
  type RecoveredTemplateInput,
  type RenderedEmail,
} from "./index.js";

const XSS = `<script>alert("x")</script>`;
const STATUS = "https://agentcheck.vercel.app/umer/my-bot";

const alertInput: AlertTemplateInput = {
  productName: "agentcheck",
  targetName: "my-bot",
  checkName: "tools/list",
  statusUrl: STATUS,
  openedAt: "2026-09-01T12:00:00Z",
  error: {
    code: "TOOL_LIST_EMPTY",
    cause: "tools/list returned []",
    fix: "Register at least one tool",
  },
  transcriptExcerpt: `> tools/list\n< { "tools": [] }`,
  diff: { before: `{ "tools": ["search"] }`, after: `{ "tools": [] }` },
  consecutiveFailures: 2,
};

const recoveredInput: RecoveredTemplateInput = {
  productName: "agentcheck",
  targetName: "my-bot",
  checkName: "tools/list",
  statusUrl: STATUS,
  downtimeMinutes: 17,
};

const digestInput: DigestTemplateInput = {
  productName: "agentcheck",
  date: "2026-09-01",
  sections: [
    { title: "Replay", items: ["12/12 traces matched baseline"] },
    { title: "Adversarial", items: ["Prompt injection: pass", "Canary leakage: pass"] },
  ],
  costUsd: 0.37,
  decisionsNeeded: ["Promote trace #88 to a check?"],
  reportUrl: `${STATUS}/runs/42`,
};

const driftInput: DriftTemplateInput = {
  productName: "agentcheck",
  provider: "Anthropic",
  model: "claude-sonnet-5",
  releasedAt: "2026-08-30T00:00:00Z",
  targetName: "my-bot",
  summary: "Two rubric checks regressed; the refusal check improved.",
  changes: [
    { check: "greeting", before: "pass", after: "pass", verdict: "unchanged" },
    { check: "refund-policy", before: "0.92", after: "0.61", verdict: "regressed" },
    { check: "refusal", before: "0.70", after: "0.95", verdict: "improved" },
    { check: "json-shape", before: "pass", after: "fail", verdict: "regressed" },
  ],
  runUrl: `${STATUS}/runs/43`,
  shareUrl: `${STATUS}/runs/43?share=1`,
};

const receiptInput: ReceiptTemplateInput = {
  productName: "agentcheck",
  lines: [
    { description: "Starter plan (Sep 2026)", amountUsd: 29 },
    { description: "Extra targets x2", amountUsd: 16 },
  ],
  totalUsd: 45,
  portalUrl: "https://billing.stripe.com/p/session/abc",
  reference: "in_123",
};

/** Replace every string leaf with one that carries a script tag. */
function poison<T>(value: T): T {
  if (typeof value === "string") return `${value} ${XSS}` as T;
  if (Array.isArray(value)) return value.map((v: unknown) => poison(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = poison(v);
    return out as T;
  }
  return value;
}

const all: { name: string; render: (poisoned: boolean) => RenderedEmail }[] = [
  { name: "alert", render: (x) => alertTemplate(x ? poison(alertInput) : alertInput) },
  {
    name: "recovered",
    render: (x) => recoveredTemplate(x ? poison(recoveredInput) : recoveredInput),
  },
  { name: "digest", render: (x) => digestTemplate(x ? poison(digestInput) : digestInput) },
  { name: "drift", render: (x) => driftTemplate(x ? poison(driftInput) : driftInput) },
  { name: "receipt", render: (x) => receiptTemplate(x ? poison(receiptInput) : receiptInput) },
];

describe("every template", () => {
  for (const t of all) {
    it(`${t.name}: escapes user strings, has no images, non-empty text`, () => {
      const out = t.render(true);
      expect(out.html).not.toContain("<script");
      expect(out.html).toContain("&lt;script&gt;");
      expect(out.html).not.toContain("<img");
      expect(out.html).toContain("<!DOCTYPE html>");
      expect(out.text.trim().length).toBeGreaterThan(50);
      expect(out.subject.length).toBeGreaterThan(0);
      // Plain text is not HTML: the literal tag is fine there, markup is not.
      expect(out.text).not.toContain("<p ");
      expect(out.text).not.toContain("style=");
    });
    it(`${t.name}: clean input renders without escape artifacts`, () => {
      const out = t.render(false);
      expect(out.html).not.toContain("&amp;lt;");
      expect(out.text).not.toContain("&lt;");
      expect(out.text).not.toContain("&amp;");
    });
  }
});

describe("alertTemplate", () => {
  it("subject is [product] FAILING: target · check", () => {
    expect(alertTemplate(alertInput).subject).toBe("[agentcheck] FAILING: my-bot · tools/list");
  });
  it("leads with what failed, then transcript, then diff, then status + silence links", () => {
    const { html, text } = alertTemplate(alertInput);
    const body = html.slice(html.indexOf("<h1"));
    const iHead = body.indexOf("tools/list is failing on my-bot");
    const iErr = body.indexOf("TOOL_LIST_EMPTY");
    const iTranscript = body.indexOf("Failing transcript");
    const iDiff = body.indexOf("Diff vs last pass");
    const iStatus = body.indexOf("Open status page");
    const iSilence = body.indexOf("silence=24h");
    expect(iHead).toBeGreaterThan(-1);
    expect(iErr).toBeGreaterThan(iHead);
    expect(iTranscript).toBeGreaterThan(iErr);
    expect(iDiff).toBeGreaterThan(iTranscript);
    expect(iStatus).toBeGreaterThan(iDiff);
    expect(iSilence).toBeGreaterThan(iStatus);
    expect(html).toContain("2 consecutive failures since 2026-09-01 12:00 UTC");
    expect(html).toContain("Register at least one tool");
    expect(html).toContain("<pre");
    expect(text).toContain(`> tools/list\n< { "tools": [] }`);
    expect(text).toContain(`Status page (${STATUS})`);
  });
  it("accepts a unified diff string and a custom silence URL", () => {
    const { html } = alertTemplate({
      ...alertInput,
      diff: "- old\n+ new",
      silenceUrl: "https://x.test/silence",
    });
    expect(html).toContain("- old\n+ new");
    expect(html).toContain('href="https://x.test/silence"');
    expect(html).not.toContain("silence=24h");
  });
});

describe("recoveredTemplate", () => {
  it("names the check and downtime", () => {
    const out = recoveredTemplate(recoveredInput);
    expect(out.subject).toBe("[agentcheck] RECOVERED: my-bot · tools/list");
    expect(out.html).toContain("back after 17 minutes");
    expect(recoveredTemplate({ ...recoveredInput, downtimeMinutes: 180 }).html).toContain(
      "3 hours",
    );
  });
});

describe("digestTemplate", () => {
  it("puts decisions needed before the sections and shows cost", () => {
    const { html, subject } = digestTemplate(digestInput);
    expect(subject).toBe("[agentcheck] Nightly report 2026-09-01: 1 decision needed");
    const iDecisions = html.indexOf("Decisions needed");
    const iReplay = html.indexOf("Replay");
    expect(iDecisions).toBeGreaterThan(-1);
    expect(iReplay).toBeGreaterThan(iDecisions);
    expect(html).toContain("Promote trace #88 to a check?");
    expect(html).toContain("$0.37");
    expect(html).toContain(`${STATUS}/runs/42`);
  });
  it("omits the decisions block when none are needed", () => {
    const { html, subject } = digestTemplate({ ...digestInput, decisionsNeeded: [] });
    expect(subject).toBe("[agentcheck] Nightly report 2026-09-01");
    expect(html).not.toContain("Decisions needed");
  });
});

describe("driftTemplate", () => {
  it("headline names the model and target; regressed rows come first", () => {
    const { html, subject, text } = driftTemplate(driftInput);
    expect(subject).toBe("[agentcheck] claude-sonnet-5 shipped: 2 regressions in my-bot");
    expect(html).toContain("claude-sonnet-5 shipped. Here&#39;s what changed in my-bot.");
    const tbody = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    const order = ["refund-policy", "json-shape", "refusal", "greeting"].map((c) =>
      tbody.indexOf(c),
    );
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("Forward this");
    expect(html).toContain(`${STATUS}/runs/43?share=1`);
    expect(html).toContain("2 regressed");
    expect(text).toContain("Forward this.");
    expect(text).toContain(`${STATUS}/runs/43?share=1`);
  });
  it("sortDriftChanges is stable within a verdict and does not mutate", () => {
    const sorted = sortDriftChanges(driftInput.changes);
    expect(sorted.map((c) => c.check)).toEqual([
      "refund-policy",
      "json-shape",
      "refusal",
      "greeting",
    ]);
    expect(driftInput.changes[0]?.check).toBe("greeting");
  });
  it("says no regressions when there are none", () => {
    const out = driftTemplate({
      ...driftInput,
      changes: driftInput.changes.filter((c) => c.verdict !== "regressed"),
    });
    expect(out.subject).toContain("no regressions");
  });
});

describe("receiptTemplate", () => {
  it("lists lines, total and the portal link", () => {
    const { html, subject, text } = receiptTemplate(receiptInput);
    expect(subject).toBe("[agentcheck] Receipt in_123: $45.00");
    expect(html).toContain("Starter plan (Sep 2026)");
    expect(html).toContain("$29.00");
    expect(html).toContain("$16.00");
    expect(html).toContain("<strong>$45.00</strong>");
    expect(text).toContain("Manage billing (https://billing.stripe.com/p/session/abc)");
  });
});
