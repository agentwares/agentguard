import { describe, expect, it } from "vitest";
import {
  DISCORD_CONTENT_LIMIT,
  hmacSha256Hex,
  resendOverFetch,
  sendDiscord,
  sendEmail,
  sendSlack,
  sendWebhook,
  SIGNATURE_HEADER,
  truncate,
  verifyWebhookSignature,
  type FetchLike,
  type ResendLike,
} from "./channels.js";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function fakeFetch(
  respond: (c: Captured) => Response = () => new Response("ok", { status: 200 }),
): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const c: Captured = {
      url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(c);
    return respond(c);
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("sendEmail", () => {
  const msg = {
    from: "a <onboarding@resend.dev>",
    to: "b@example.com",
    subject: "s",
    html: "<p>h</p>",
    text: "h",
  };

  it("returns a structured failure without a key or client, and never throws", async () => {
    await expect(sendEmail(msg)).resolves.toEqual({
      ok: false,
      error: "RESEND_API_KEY not configured",
    });
  });

  it("uses an injected client and returns the id", async () => {
    const sent: unknown[] = [];
    const resend: ResendLike = {
      emails: {
        async send(payload) {
          sent.push(payload);
          return { data: { id: "em_1" }, error: null };
        },
      },
    };
    const r = await sendEmail({ ...msg, resend });
    expect(r).toEqual({ ok: true, id: "em_1", status: 200 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ["b@example.com"], subject: "s" });
  });

  it("maps Resend error responses to ok:false", async () => {
    const resend: ResendLike = {
      emails: {
        async send() {
          return {
            data: null,
            error: { message: "quota", name: "daily_quota_exceeded", statusCode: 429 },
          };
        },
      },
    };
    const r = await sendEmail({ ...msg, resend });
    expect(r).toEqual({ ok: false, status: 429, error: "daily_quota_exceeded: quota" });
  });

  it("catches thrown client errors", async () => {
    const resend: ResendLike = {
      emails: {
        async send() {
          throw new Error("socket hang up");
        },
      },
    };
    await expect(sendEmail({ ...msg, resend })).resolves.toEqual({
      ok: false,
      error: "socket hang up",
    });
  });

  it("rejects empty recipients", async () => {
    const resend: ResendLike = {
      emails: { send: async () => ({ data: { id: "x" }, error: null }) },
    };
    await expect(sendEmail({ ...msg, to: [], resend })).resolves.toEqual({
      ok: false,
      error: "no recipient",
    });
  });

  it("posts to the Resend REST API when a fetch is injected", async () => {
    const f = fakeFetch(() => json({ id: "em_2" }));
    const r = await sendEmail({
      ...msg,
      apiKey: "re_test_key",
      fetch: f.fetch,
      replyTo: "r@example.com",
    });
    expect(r).toEqual({ ok: true, id: "em_2", status: 200 });
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.resend.com/emails");
    expect(call.headers["authorization"]).toBe("Bearer re_test_key");
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body).toMatchObject({ to: ["b@example.com"], subject: "s", reply_to: "r@example.com" });
  });

  it("REST path surfaces provider errors and network failures", async () => {
    const bad = fakeFetch(() =>
      json({ name: "validation_error", message: "bad from", statusCode: 422 }, 422),
    );
    expect(await sendEmail({ ...msg, apiKey: "re_x", fetch: bad.fetch })).toEqual({
      ok: false,
      status: 422,
      error: "validation_error: bad from",
    });
    const down: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await sendEmail({ ...msg, apiKey: "re_x", fetch: down })).toEqual({
      ok: false,
      error: "fetch failed",
    });
    const client = resendOverFetch("re_x", bad.fetch);
    expect((await client.emails.send(msg)).error?.statusCode).toBe(422);
  });
});

describe("sendSlack", () => {
  it("posts the message as JSON", async () => {
    const f = fakeFetch();
    const r = await sendSlack(
      "https://hooks.slack.com/services/T/B/x",
      { text: "hi", blocks: [{ type: "divider" }] },
      { fetch: f.fetch },
    );
    expect(r).toEqual({ ok: true, status: 200 });
    expect(f.calls[0]!.method).toBe("POST");
    expect(f.calls[0]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(f.calls[0]!.body)).toEqual({ text: "hi", blocks: [{ type: "divider" }] });
  });
  it("reports non-2xx and network errors without throwing", async () => {
    const f = fakeFetch(() => new Response("invalid_payload", { status: 400 }));
    expect(
      await sendSlack("https://hooks.slack.com/x", { text: "hi" }, { fetch: f.fetch }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "invalid_payload",
    });
    const down: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    expect(await sendSlack("https://hooks.slack.com/x", { text: "hi" }, { fetch: down })).toEqual({
      ok: false,
      error: "ECONNRESET",
    });
  });
});

describe("sendDiscord", () => {
  it("truncates content to 2000 chars and returns the message id", async () => {
    const f = fakeFetch(() => json({ id: "1234567890" }));
    const long = "x".repeat(2500);
    const r = await sendDiscord(
      "https://discord.com/api/webhooks/1/abc",
      { content: long },
      { fetch: f.fetch },
    );
    expect(r).toEqual({ ok: true, status: 200, id: "1234567890" });
    expect(f.calls[0]!.url).toBe("https://discord.com/api/webhooks/1/abc?wait=true");
    const body = JSON.parse(f.calls[0]!.body) as { content: string };
    expect(body.content.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    expect(body.content.endsWith("…")).toBe(true);
  });
  it("does not split surrogate pairs when truncating", () => {
    const emoji = "😀".repeat(1500); // 3000 UTF-16 units
    const out = truncate(emoji, DISCORD_CONTENT_LIMIT);
    expect(out.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, -1).match(/[\uD800-\uDBFF]$/)).toBeNull();
    expect(truncate("short", 2000)).toBe("short");
  });
  it("handles invalid URLs and failures", async () => {
    expect(await sendDiscord("not a url", { content: "x" }, { fetch: fakeFetch().fetch })).toEqual({
      ok: false,
      error: "invalid webhook url",
    });
    const f = fakeFetch(() => new Response("Unknown Webhook", { status: 404 }));
    expect(
      await sendDiscord(
        "https://discord.com/api/webhooks/1/abc",
        { content: "x" },
        { fetch: f.fetch },
      ),
    ).toEqual({
      ok: false,
      status: 404,
      error: "Unknown Webhook",
    });
  });
});

describe("sendWebhook", () => {
  it("signs the exact body with HMAC-SHA256 and the signature verifies", async () => {
    const f = fakeFetch(() => json({ received: true }));
    const payload = { event: "alert", n: 1, nested: { a: [1, 2, 3] } };
    const r = await sendWebhook("https://example.com/hook", payload, {
      secret: "whsec_test",
      headers: { "X-Custom": "1" },
      fetch: f.fetch,
    });
    expect(r).toEqual({ ok: true, status: 200 });
    const call = f.calls[0]!;
    expect(call.headers["x-custom"]).toBe("1");
    expect(call.headers["content-type"]).toBe("application/json");
    const sig = call.headers[SIGNATURE_HEADER.toLowerCase()]!;
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);

    // Recompute independently.
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("whsec_test"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(call.body));
    const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(sig).toBe(`sha256=${hex}`);
    expect(JSON.parse(call.body)).toEqual(payload);

    expect(await verifyWebhookSignature(call.body, "whsec_test", sig)).toBe(true);
    expect(await verifyWebhookSignature(call.body, "wrong", sig)).toBe(false);
    expect(await verifyWebhookSignature(`${call.body} `, "whsec_test", sig)).toBe(false);
    expect(await verifyWebhookSignature(call.body, "whsec_test", null)).toBe(false);
    expect(await hmacSha256Hex("whsec_test", call.body)).toBe(hex);
  });
  it("omits the signature header without a secret and reports failures", async () => {
    const f = fakeFetch(() => new Response("nope", { status: 500 }));
    const r = await sendWebhook("https://example.com/hook", { a: 1 }, { fetch: f.fetch });
    expect(r).toEqual({ ok: false, status: 500, error: "nope" });
    expect(f.calls[0]!.headers[SIGNATURE_HEADER.toLowerCase()]).toBeUndefined();
    const down: FetchLike = async () => {
      throw new Error("dns");
    };
    expect(await sendWebhook("https://example.com/hook", {}, { fetch: down })).toEqual({
      ok: false,
      error: "dns",
    });
  });
});
