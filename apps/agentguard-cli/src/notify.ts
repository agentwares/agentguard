/**
 * Alerts: Slack / generic webhook on halts and approvals, through `@agentwares/notify`.
 * No email in the OSS CLI (no Resend key), no phone-home.
 */
import { sendSlack, sendWebhook } from "@agentwares/notify";
import type { ApprovalRecord, GuardEvent, Policy } from "@agentwares/agentguard-core";

export interface AlerterOptions {
  policy: Policy;
  approvalUrl?: (record: ApprovalRecord) => string | undefined;
  log?: (line: string) => void;
  fetch?: typeof fetch;
}

export function approvalSlackMessage(
  event: GuardEvent,
  url: string | undefined,
): { text: string; blocks: unknown[] } {
  const a = event.approval!;
  const argsText = JSON.stringify(a.args ?? {}, null, 2).slice(0, 1500);
  const text = `[agentguard] approval needed: ${a.tool} (run ${a.run_id}) — run \`agentguard approve ${a.id}\`${url ? ` or open ${url}` : ""}`;
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `Approval needed: ${a.tool}` } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*run* \`${a.run_id}\`${a.agent ? ` · *agent* \`${a.agent}\`` : ""}${a.upstream ? ` · *upstream* \`${a.upstream}\`` : ""}\n\`\`\`${argsText}\`\`\``,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Approve: \`agentguard approve ${a.id}\` · Deny: \`agentguard deny ${a.id}\` · expires ${a.expires_at}`,
        },
      ],
    },
  ];
  if (url) {
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Approve" }, style: "primary", url },
        {
          type: "button",
          text: { type: "plain_text", text: "Deny" },
          style: "danger",
          url: url.replace("/approve/", "/deny/"),
        },
      ],
    });
  }
  return { text, blocks };
}

export function haltSlackMessage(event: GuardEvent): { text: string; blocks: unknown[] } {
  const cause = event.error?.cause ?? "";
  const text = `[agentguard] ${event.type}: ${event.tool} (run ${event.runId}) — ${cause}`;
  return {
    text,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${event.type}* on \`${event.tool}\` (run \`${event.runId}\`)\n${cause}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `\`agentguard report --run ${event.runId}\` for the full picture${event.type === "KILLED" ? "" : " · `agentguard kill` to stop everything"}`,
          },
        ],
      },
    ],
  };
}

/** Returns a `Guard.onEvent` handler. Never throws; failures are logged. */
export function createAlerter(opts: AlerterOptions): (event: GuardEvent) => Promise<void> {
  const { policy } = opts;
  const log = opts.log ?? (() => undefined);
  const channel = { fetch: opts.fetch };
  return async (event) => {
    if (event.type === "APPROVAL_DECIDED") return;
    if (!policy.alerts.on.includes(event.type)) return;
    const slack =
      event.type === "APPROVAL_REQUIRED"
        ? policy.approval.notify.slack || policy.alerts.slack
        : policy.alerts.slack;
    const webhook =
      event.type === "APPROVAL_REQUIRED"
        ? policy.approval.notify.webhook || policy.alerts.webhook
        : policy.alerts.webhook;
    const url = event.approval ? opts.approvalUrl?.(event.approval) : undefined;
    const message =
      event.type === "APPROVAL_REQUIRED" && event.approval
        ? approvalSlackMessage(event, url)
        : haltSlackMessage(event);
    const jobs: Promise<unknown>[] = [];
    if (slack) {
      jobs.push(
        sendSlack(slack, message, channel).then((r) => {
          if (!r.ok) log(`slack alert failed: ${r.error ?? r.status}`);
        }),
      );
    }
    if (webhook) {
      jobs.push(
        sendWebhook(
          webhook,
          {
            event: event.type,
            product: "agentguard",
            subject: message.text,
            summary: event.error?.cause ?? "",
            occurredAt: event.at,
            data: {
              runId: event.runId,
              tool: event.tool,
              error: event.error,
              approval: event.approval,
              approveUrl: url,
            },
          },
          channel,
        ).then((r) => {
          if (!r.ok) log(`webhook alert failed: ${r.error ?? r.status}`);
        }),
      );
    }
    await Promise.all(jobs);
  };
}
