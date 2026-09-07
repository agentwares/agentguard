/**
 * Delivery channels: Resend email, Slack/Discord incoming webhooks, generic signed webhook.
 * Web-standard only (`fetch`, `crypto.subtle`) so the same code runs on Vercel Functions and
 * Cloudflare Workers. Nothing here throws on remote failure; every call resolves a SendResult.
 */
import { Resend } from "resend";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SendResult {
  ok: boolean;
  /** Provider-side id (Resend email id, Discord message id) when available. */
  id?: string;
  /** HTTP status of the provider response when one was received. */
  status?: number;
  /** Short, log-safe error description. Never contains secrets. */
  error?: string;
}

const USER_AGENT = "agentwares-notify/0.1";
const RESEND_API = "https://api.resend.com/emails";

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : "unknown error";
}

async function readBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function defaultFetch(): FetchLike | undefined {
  return typeof fetch === "function" ? (input, init) => fetch(input, init) : undefined;
}

// ---------------------------------------------------------------------------
// Email (Resend)
// ---------------------------------------------------------------------------

export interface ResendEmailPayload {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string | string[];
  headers?: Record<string, string>;
}

export interface ResendSendResponse {
  data: { id: string } | null;
  error: { message: string; name?: string; statusCode?: number | null } | null;
}

/** The slice of the Resend SDK we use; `new Resend(key)` satisfies it, so do test fakes. */
export interface ResendLike {
  emails: {
    send(payload: ResendEmailPayload): Promise<ResendSendResponse>;
  };
}

export interface SendEmailOptions extends ResendEmailPayload {
  /** Resend API key. Ignored when `resend` is given. */
  apiKey?: string;
  /** Injected client (tests, or a shared instance). */
  resend?: ResendLike;
  /**
   * Injected fetch. When given (and no `resend` client), the email is posted to the Resend
   * REST API through this fetch instead of the SDK, which only uses the global fetch.
   */
  fetch?: FetchLike;
}

/** Minimal Resend client over an injected fetch. Same endpoint and shapes the SDK uses. */
export function resendOverFetch(apiKey: string, fetchImpl: FetchLike): ResendLike {
  return {
    emails: {
      async send(payload) {
        const res = await fetchImpl(RESEND_API, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
          },
          body: JSON.stringify({
            from: payload.from,
            to: payload.to,
            subject: payload.subject,
            html: payload.html,
            text: payload.text,
            reply_to: payload.replyTo,
            headers: payload.headers,
          }),
        });
        const body = parseJson(await readBody(res));
        if (!res.ok) {
          return {
            data: null,
            error: {
              message: typeof body?.message === "string" ? body.message : res.statusText,
              name: typeof body?.name === "string" ? body.name : "application_error",
              statusCode: res.status,
            },
          };
        }
        return { data: { id: typeof body?.id === "string" ? body.id : "" }, error: null };
      },
    },
  };
}

function resolveResend(opts: SendEmailOptions): ResendLike | undefined {
  if (opts.resend) return opts.resend;
  if (!opts.apiKey) return undefined;
  if (opts.fetch) return resendOverFetch(opts.apiKey, opts.fetch);
  return new Resend(opts.apiKey);
}

/** Send one transactional email through Resend. Never throws. */
export async function sendEmail(opts: SendEmailOptions): Promise<SendResult> {
  const client = resolveResend(opts);
  if (!client) return { ok: false, error: "RESEND_API_KEY not configured" };
  const to = Array.isArray(opts.to) ? opts.to : [opts.to];
  if (to.length === 0 || to.some((t) => !t.trim())) return { ok: false, error: "no recipient" };
  try {
    const payload: ResendEmailPayload = {
      from: opts.from,
      to,
      subject: opts.subject,
      html: opts.html,
    };
    if (opts.text !== undefined) payload.text = opts.text;
    if (opts.replyTo !== undefined) payload.replyTo = opts.replyTo;
    if (opts.headers !== undefined) payload.headers = opts.headers;
    const res = await client.emails.send(payload);
    if (res.error) {
      const status = res.error.statusCode ?? undefined;
      return {
        ok: false,
        ...(status !== undefined ? { status } : {}),
        error: `${res.error.name ?? "resend_error"}: ${res.error.message}`,
      };
    }
    return { ok: true, id: res.data?.id ?? "", status: 200 };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

// ---------------------------------------------------------------------------
// Slack incoming webhook
// ---------------------------------------------------------------------------

export interface SlackMessage {
  text: string;
  /** Block Kit blocks; passed through untouched. */
  blocks?: unknown[];
}

export interface ChannelOptions {
  fetch?: FetchLike;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  fetchImpl: FetchLike | undefined,
): Promise<{ res: Response; text: string } | { error: string }> {
  if (!fetchImpl) return { error: "fetch is not available" };
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { res, text: await readBody(res) };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

/** Post to a Slack incoming webhook. Never throws. */
export async function sendSlack(
  webhookUrl: string,
  message: SlackMessage,
  opts: ChannelOptions = {},
): Promise<SendResult> {
  const r = await postJson(webhookUrl, message, {}, opts.fetch ?? defaultFetch());
  if ("error" in r) return { ok: false, error: r.error };
  return r.res.ok
    ? { ok: true, status: r.res.status }
    : { ok: false, status: r.res.status, error: r.text || r.res.statusText || "slack error" };
}

// ---------------------------------------------------------------------------
// Discord webhook
// ---------------------------------------------------------------------------

export const DISCORD_CONTENT_LIMIT = 2000;

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordMessage {
  content: string;
  embeds?: DiscordEmbed[];
  username?: string;
}

/** Truncate to `max` UTF-16 units without splitting a surrogate pair; appends an ellipsis. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max - 1));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Post to a Discord webhook. Content is truncated to 2000 chars. Never throws. */
export async function sendDiscord(
  webhookUrl: string,
  message: DiscordMessage,
  opts: ChannelOptions = {},
): Promise<SendResult> {
  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    return { ok: false, error: "invalid webhook url" };
  }
  url.searchParams.set("wait", "true"); // return the created message so we get an id
  const body: DiscordMessage = {
    ...message,
    content: truncate(message.content, DISCORD_CONTENT_LIMIT),
  };
  const r = await postJson(url.toString(), body, {}, opts.fetch ?? defaultFetch());
  if ("error" in r) return { ok: false, error: r.error };
  if (!r.res.ok) {
    return {
      ok: false,
      status: r.res.status,
      error: r.text || r.res.statusText || "discord error",
    };
  }
  const json = parseJson(r.text);
  const id = typeof json?.id === "string" ? json.id : undefined;
  return { ok: true, status: r.res.status, ...(id !== undefined ? { id } : {}) };
}

// ---------------------------------------------------------------------------
// Generic signed webhook
// ---------------------------------------------------------------------------

export const SIGNATURE_HEADER = "X-Agentwares-Signature";

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256 of `body` keyed by `secret`, hex encoded. */
export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
}

/** Verify an `X-Agentwares-Signature: sha256=<hex>` header against the raw body. */
export async function verifyWebhookSignature(
  body: string,
  secret: string,
  header: string | null | undefined,
): Promise<boolean> {
  if (!header) return false;
  const expected = `sha256=${await hmacSha256Hex(secret, body)}`;
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

export interface WebhookOptions extends ChannelOptions {
  /** When set, the request carries `X-Agentwares-Signature: sha256=<hmac hex of the body>`. */
  secret?: string;
  headers?: Record<string, string>;
}

/** POST a JSON payload to any URL, optionally HMAC-signed. Never throws. */
export async function sendWebhook(
  url: string,
  payload: unknown,
  opts: WebhookOptions = {},
): Promise<SendResult> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.secret) headers[SIGNATURE_HEADER] = `sha256=${await hmacSha256Hex(opts.secret, body)}`;
  const r = await postJson(url, body, headers, opts.fetch ?? defaultFetch());
  if ("error" in r) return { ok: false, error: r.error };
  return r.res.ok
    ? { ok: true, status: r.res.status }
    : { ok: false, status: r.res.status, error: r.text || r.res.statusText || "webhook error" };
}
