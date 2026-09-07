import { describe, expect, it } from "vitest";
import { createNotify, summarizeDigest, summarizeDrift } from "./notify.js";
import type { FetchLike, ResendLike } from "./channels.js";
import type { AlertTemplateInput, DriftTemplateInput } from "./templates/index.js";

const alertPayload: AlertTemplateInput = {
  productName: "agentcheck",
  targetName: "my-bot",
  checkName: "tools/list",
  statusUrl: "https://agentcheck.vercel.app/umer/my-bot",
  openedAt: "2026-09-01T12:00:00Z",
  error: { code: "TOOL_LIST_EMPTY", cause: "tools/list returned []" },
  transcriptExcerpt: "> tools/list\n< []",
  consecutiveFailures: 2,
};

const driftPayload: DriftTemplateInput = {
  productName: "agentcheck",
  provider: "Anthropic",
  model: "claude-sonnet-5",
  releasedAt: "2026-08-30",
  targetName: "my-bot",
  summary: "One regression.",
  changes: [
    { check: "a", before: "pass", after: "fail", verdict: "regressed" },
    { check: "b", before: "pass", after: "pass", verdict: "unchanged" },
  ],
  runUrl: "https://agentcheck.vercel.app/umer/my-bot/runs/1",
  shareUrl: "https://agentcheck.vercel.app/umer/my-bot/runs/1?share=1",
};

interface Call {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function harness() {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, body: typeof init?.body === "string" ? init.body : "", headers });
    if (url.startsWith("https://discord.com/")) {
      return new Response(JSON.stringify({ id: "dm_1" }), { status: 200 });
    }
    return new Response("ok", { status: 200 });
  };
  const emails: { to: string | string[]; subject: string; html: string; text?: string }[] = [];
  const resend: ResendLike = {
    emails: {
      async send(payload) {
        emails.push(payload);
        return { data: { id: "em_1" }, error: null };
      },
    },
  };
  return { calls, emails, fetch, resend };
}

const channels = {
  email: ["ops@example.com", "dev@example.com"],
  slack: "https://hooks.slack.com/services/T/B/x",
  discord: "https://discord.com/api/webhooks/1/abc",
  webhook: { url: "https://example.com/hook", secret: "whsec_1" },
};

describe("createNotify fan-out", () => {
  it("alert hits each configured channel exactly once and reports per-channel results", async () => {
    const h = harness();
    const notify = createNotify({
      from: "agentcheck <onboarding@resend.dev>",
      fetch: h.fetch,
      resend: h.resend,
    });
    const result = await notify.alert(channels, alertPayload);

    expect(result.email).toEqual({ ok: true, id: "em_1", status: 200 });
    expect(result.slack).toEqual({ ok: true, status: 200 });
    expect(result.discord).toEqual({ ok: true, status: 200, id: "dm_1" });
    expect(result.webhook).toEqual({ ok: true, status: 200 });

    expect(h.emails).toHaveLength(1);
    expect(h.emails[0]!.to).toEqual(channels.email);
    expect(h.emails[0]!.subject).toBe("[agentcheck] FAILING: my-bot · tools/list");
    expect(h.emails[0]!.html).toContain("<!DOCTYPE html>");
    expect(h.emails[0]!.text).toContain("tools/list");

    const byHost = (host: string) => h.calls.filter((c) => c.url.startsWith(host));
    expect(byHost("https://hooks.slack.com/")).toHaveLength(1);
    expect(byHost("https://discord.com/")).toHaveLength(1);
    expect(byHost("https://example.com/hook")).toHaveLength(1);
    expect(h.calls).toHaveLength(3);

    const slack = JSON.parse(byHost("https://hooks.slack.com/")[0]!.body) as { text: string };
    expect(slack.text).toContain("[agentcheck] FAILING: my-bot · tools/list");
    expect(slack.text).toContain("<https://agentcheck.vercel.app/umer/my-bot|Open status page>");
    expect(slack.text).not.toContain("<!DOCTYPE");

    const discord = JSON.parse(byHost("https://discord.com/")[0]!.body) as { content: string };
    expect(discord.content).toContain("TOOL_LIST_EMPTY");
    expect(discord.content).toContain("<https://agentcheck.vercel.app/umer/my-bot>");
    expect(discord.content.length).toBeLessThanOrEqual(2000);

    const hook = byHost("https://example.com/hook")[0]!;
    expect(hook.headers["x-agentwares-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    const body = JSON.parse(hook.body) as {
      event: string;
      data: AlertTemplateInput;
      subject: string;
    };
    expect(body.event).toBe("alert");
    expect(body.subject).toBe("[agentcheck] FAILING: my-bot · tools/list");
    expect(body.data.error.code).toBe("TOOL_LIST_EMPTY");
  });

  it("only touches configured channels", async () => {
    const h = harness();
    const notify = createNotify({
      from: "x <onboarding@resend.dev>",
      fetch: h.fetch,
      resend: h.resend,
    });
    const result = await notify.recovered(
      { slack: channels.slack },
      {
        productName: "agentcheck",
        targetName: "t",
        checkName: "c",
        statusUrl: "https://s.test",
        downtimeMinutes: 5,
      },
    );
    expect(Object.keys(result)).toEqual(["slack"]);
    expect(h.calls).toHaveLength(1);
    expect(h.emails).toHaveLength(0);
    expect(
      await notify.digest(
        {},
        { productName: "p", date: "d", sections: [], reportUrl: "https://r.test" },
      ),
    ).toEqual({});
  });

  it("drift and digest send short summaries with the link", async () => {
    const h = harness();
    const notify = createNotify({
      from: "x <onboarding@resend.dev>",
      fetch: h.fetch,
      resend: h.resend,
    });
    const drift = await notify.drift(
      { discord: channels.discord, email: ["a@example.com"] },
      driftPayload,
    );
    expect(drift.discord?.ok).toBe(true);
    expect(drift.email?.ok).toBe(true);
    const content = (JSON.parse(h.calls[0]!.body) as { content: string }).content;
    expect(content).toContain(
      "claude-sonnet-5 shipped: 1 regressed, 0 improved, 1 unchanged in my-bot",
    );
    expect(content).toContain(driftPayload.runUrl);
    expect(h.emails[0]!.html).toContain("Forward this");

    const digest = await notify.digest(
      { webhook: { url: "https://example.com/hook" } },
      {
        productName: "agentcheck",
        date: "2026-09-01",
        sections: [{ title: "Replay", items: ["ok", "ok"] }],
        decisionsNeeded: ["pick one"],
        reportUrl: "https://r.test/1",
      },
    );
    expect(digest.webhook).toEqual({ ok: true, status: 200 });
    const last = h.calls[h.calls.length - 1]!;
    expect(last.headers["x-agentwares-signature"]).toBeUndefined();
    expect((JSON.parse(last.body) as { summary: string }).summary).toBe(
      "Nightly report 2026-09-01: 1 decision needed; 2 items across 1 section",
    );
  });

  it("missing Resend key yields a structured failure on email and inside fan-out, no throw", async () => {
    const h = harness();
    const notify = createNotify({ from: "x <onboarding@resend.dev>", fetch: h.fetch });
    await expect(
      notify.email({ to: "a@example.com", subject: "s", html: "<p>x</p>" }),
    ).resolves.toEqual({ ok: false, error: "RESEND_API_KEY not configured" });
    const result = await notify.alert(
      { email: ["a@example.com"], slack: channels.slack },
      alertPayload,
    );
    expect(result.email).toEqual({ ok: false, error: "RESEND_API_KEY not configured" });
    expect(result.slack?.ok).toBe(true);
    expect(h.calls).toHaveLength(1);
  });

  it("uses the injected fetch for Resend when a key is given without a client", async () => {
    const h = harness();
    const notify = createNotify({
      resendApiKey: "re_test",
      from: "x <onboarding@resend.dev>",
      fetch: h.fetch,
    });
    const r = await notify.email({ to: "a@example.com", subject: "s", html: "<p>x</p>" });
    expect(r.ok).toBe(true);
    expect(h.calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(h.calls[0]!.headers["authorization"]).toBe("Bearer re_test");
  });

  it("a channel failure does not affect the others", async () => {
    const h = harness();
    const flaky: FetchLike = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://hooks.slack.com/")) throw new Error("slack down");
      return h.fetch(input, init);
    };
    const notify = createNotify({
      from: "x <onboarding@resend.dev>",
      fetch: flaky,
      resend: h.resend,
    });
    const result = await notify.alert(channels, alertPayload);
    expect(result.slack).toEqual({ ok: false, error: "slack down" });
    expect(result.email?.ok).toBe(true);
    expect(result.discord?.ok).toBe(true);
    expect(result.webhook?.ok).toBe(true);
  });
});

describe("summaries", () => {
  it("are single-purpose one-liners", () => {
    expect(summarizeDrift(driftPayload).text).toBe(
      "claude-sonnet-5 shipped: 1 regressed, 0 improved, 1 unchanged in my-bot",
    );
    expect(
      summarizeDigest({
        productName: "p",
        date: "2026-09-01",
        sections: [],
        reportUrl: "https://r",
      }).text,
    ).toBe("Nightly report 2026-09-01: 0 items across 0 sections");
  });
});
