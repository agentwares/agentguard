/**
 * `createNotify()` binds the channels to one configuration and adds fan-out helpers that
 * render a template once and deliver it everywhere the caller configured. Email gets the
 * full HTML; Slack/Discord get a one-line summary with the link; webhooks get the payload.
 */
import { Resend } from "resend";
import {
  sendDiscord,
  sendEmail,
  sendSlack,
  sendWebhook,
  type DiscordMessage,
  type FetchLike,
  type ResendLike,
  type SendEmailOptions,
  type SendResult,
  type SlackMessage,
  type WebhookOptions,
} from "./channels.js";
import {
  alertTemplate,
  digestTemplate,
  driftTemplate,
  recoveredTemplate,
  sortDriftChanges,
  type AlertTemplateInput,
  type DigestTemplateInput,
  type DriftTemplateInput,
  type RecoveredTemplateInput,
  type RenderedEmail,
} from "./templates/index.js";
import { plural } from "./html.js";

export interface NotifyChannels {
  /** Recipient addresses. */
  email?: string[];
  /** Slack incoming-webhook URL. */
  slack?: string;
  /** Discord webhook URL. */
  discord?: string;
  /** Generic JSON webhook, HMAC-signed when `secret` is set. */
  webhook?: { url: string; secret?: string };
}

export interface FanoutResult {
  email?: SendResult;
  slack?: SendResult;
  discord?: SendResult;
  webhook?: SendResult;
}

export type NotifyEvent = "alert" | "recovered" | "drift" | "digest";

export interface CreateNotifyOptions {
  /** Resend API key. Omit to get structured `RESEND_API_KEY not configured` failures. */
  resendApiKey?: string;
  /** From address, e.g. `agentcheck <onboarding@resend.dev>`. */
  from: string;
  replyTo?: string;
  /** Injected fetch for Slack/Discord/webhooks (and Resend REST when no client is given). */
  fetch?: FetchLike;
  /** Injected Resend client (tests). Takes precedence over `resendApiKey`. */
  resend?: ResendLike;
}

export type NotifyEmailOptions = Omit<SendEmailOptions, "from" | "apiKey" | "resend" | "fetch"> & {
  from?: string;
};

export interface Notify {
  email(opts: NotifyEmailOptions): Promise<SendResult>;
  slack(webhookUrl: string, message: SlackMessage): Promise<SendResult>;
  discord(webhookUrl: string, message: DiscordMessage): Promise<SendResult>;
  webhook(url: string, payload: unknown, opts?: Omit<WebhookOptions, "fetch">): Promise<SendResult>;
  alert(channels: NotifyChannels, payload: AlertTemplateInput): Promise<FanoutResult>;
  recovered(channels: NotifyChannels, payload: RecoveredTemplateInput): Promise<FanoutResult>;
  drift(channels: NotifyChannels, payload: DriftTemplateInput): Promise<FanoutResult>;
  digest(channels: NotifyChannels, payload: DigestTemplateInput): Promise<FanoutResult>;
}

interface Summary {
  /** One line, no markup. */
  text: string;
  /** Primary link for the message. */
  url: string;
  label: string;
}

export function summarizeAlert(p: AlertTemplateInput): Summary {
  const cause = p.error.cause ? `: ${p.error.cause}` : "";
  return {
    text: `FAILING: ${p.targetName} · ${p.checkName} — ${p.error.code}${cause} (${plural(p.consecutiveFailures, "consecutive failure")})`,
    url: p.statusUrl,
    label: "Open status page",
  };
}

export function summarizeRecovered(p: RecoveredTemplateInput): Summary {
  return {
    text: `RECOVERED: ${p.targetName} · ${p.checkName} — back after ${plural(Math.max(0, Math.round(p.downtimeMinutes)), "minute")}`,
    url: p.statusUrl,
    label: "Open status page",
  };
}

export function summarizeDrift(p: DriftTemplateInput): Summary {
  const counts = { regressed: 0, improved: 0, unchanged: 0 };
  for (const c of sortDriftChanges(p.changes)) counts[c.verdict] += 1;
  return {
    text: `${p.model} shipped: ${counts.regressed} regressed, ${counts.improved} improved, ${counts.unchanged} unchanged in ${p.targetName}`,
    url: p.runUrl,
    label: "See the full run",
  };
}

export function summarizeDigest(p: DigestTemplateInput): Summary {
  const decisions = (p.decisionsNeeded ?? []).length;
  const items = p.sections.reduce((n, s) => n + s.items.length, 0);
  const head = decisions ? `${plural(decisions, "decision")} needed; ` : "";
  return {
    text: `Nightly report ${p.date}: ${head}${plural(items, "item")} across ${plural(p.sections.length, "section")}`,
    url: p.reportUrl,
    label: "Open full report",
  };
}

function slackText(product: string, s: Summary): string {
  return `[${product}] ${s.text}\n<${s.url}|${s.label}>`;
}

function discordContent(product: string, s: Summary): string {
  return `[${product}] ${s.text}\n<${s.url}>`;
}

export function createNotify(options: CreateNotifyOptions): Notify {
  const { from, replyTo } = options;
  const fetchImpl = options.fetch;
  const resendClient: ResendLike | undefined =
    options.resend ??
    (options.resendApiKey && !fetchImpl ? new Resend(options.resendApiKey) : undefined);

  const email: Notify["email"] = (opts) =>
    sendEmail({
      ...opts,
      from: opts.from ?? from,
      ...(replyTo !== undefined && opts.replyTo === undefined ? { replyTo } : {}),
      ...(options.resendApiKey !== undefined ? { apiKey: options.resendApiKey } : {}),
      ...(resendClient !== undefined ? { resend: resendClient } : {}),
      ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
    });

  const channelOpts = fetchImpl !== undefined ? { fetch: fetchImpl } : {};
  const slack: Notify["slack"] = (url, message) => sendSlack(url, message, channelOpts);
  const discord: Notify["discord"] = (url, message) => sendDiscord(url, message, channelOpts);
  const webhook: Notify["webhook"] = (url, payload, opts = {}) =>
    sendWebhook(url, payload, { ...opts, ...channelOpts });

  async function fanout(
    channels: NotifyChannels,
    event: NotifyEvent,
    payload: unknown,
    rendered: RenderedEmail,
    summary: Summary,
    productName: string,
  ): Promise<FanoutResult> {
    const jobs: Promise<[keyof FanoutResult, SendResult]>[] = [];
    if (channels.email && channels.email.length > 0) {
      jobs.push(
        email({
          to: channels.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        }).then((r) => ["email", r]),
      );
    }
    if (channels.slack) {
      jobs.push(
        slack(channels.slack, { text: slackText(productName, summary) }).then((r) => ["slack", r]),
      );
    }
    if (channels.discord) {
      jobs.push(
        discord(channels.discord, { content: discordContent(productName, summary) }).then((r) => [
          "discord",
          r,
        ]),
      );
    }
    if (channels.webhook) {
      const { url, secret } = channels.webhook;
      const body = {
        event,
        product: productName,
        subject: rendered.subject,
        summary: summary.text,
        url: summary.url,
        occurredAt: new Date().toISOString(),
        data: payload,
      };
      jobs.push(
        webhook(url, body, secret !== undefined ? { secret } : {}).then((r) => ["webhook", r]),
      );
    }
    const settled = await Promise.all(jobs);
    const out: FanoutResult = {};
    for (const [key, result] of settled) out[key] = result;
    return out;
  }

  return {
    email,
    slack,
    discord,
    webhook,
    alert: (channels, payload) =>
      fanout(
        channels,
        "alert",
        payload,
        alertTemplate(payload),
        summarizeAlert(payload),
        payload.productName,
      ),
    recovered: (channels, payload) =>
      fanout(
        channels,
        "recovered",
        payload,
        recoveredTemplate(payload),
        summarizeRecovered(payload),
        payload.productName,
      ),
    drift: (channels, payload) =>
      fanout(
        channels,
        "drift",
        payload,
        driftTemplate(payload),
        summarizeDrift(payload),
        payload.productName,
      ),
    digest: (channels, payload) =>
      fanout(
        channels,
        "digest",
        payload,
        digestTemplate(payload),
        summarizeDigest(payload),
        payload.productName,
      ),
  };
}
