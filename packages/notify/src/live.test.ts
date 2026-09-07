/**
 * Opt-in live test: LIVE_TESTS=1 pnpm test
 * Sends one alert email through the real Resend SDK to Resend's delivered@resend.dev sink.
 * Requires RESEND_API_KEY (loaded from the repo-root .env.local by vitest.setup.ts). Never
 * prints the key.
 */
import { describe, expect, it } from "vitest";
import { createNotify } from "./notify.js";
import { alertTemplate } from "./templates/index.js";

const LIVE = process.env["LIVE_TESTS"] === "1";

describe.skipIf(!LIVE)("live: Resend", () => {
  it("sends the alert template to delivered@resend.dev", async () => {
    const apiKey = process.env["RESEND_API_KEY"];
    expect(apiKey, "RESEND_API_KEY must be set for LIVE_TESTS=1").toBeTruthy();
    const notify = createNotify({
      ...(apiKey !== undefined ? { resendApiKey: apiKey } : {}),
      from: process.env["RESEND_FROM"] ?? "agentcheck <onboarding@resend.dev>",
    });
    const rendered = alertTemplate({
      productName: "agentcheck",
      targetName: "live-test-target",
      checkName: "tools/list",
      statusUrl: "https://agentcheck.vercel.app/demo",
      openedAt: new Date(),
      error: { code: "LIVE_TEST", cause: "This is a live delivery test.", fix: "Nothing to do." },
      transcriptExcerpt: "> tools/list\n< []",
      diff: { before: '["search"]', after: "[]" },
      consecutiveFailures: 2,
    });
    const result = await notify.email({ to: "delivered@resend.dev", ...rendered });
    expect(result.ok, result.error).toBe(true);
    expect(result.id).toBeTruthy();
  });
});
