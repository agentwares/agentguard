export {
  escapeHtml,
  safeUrl,
  layout,
  toText,
  decodeEntities,
  formatDate,
  formatUsd,
  plural,
  h1,
  h2,
  p,
  pHtml,
  muted,
  link,
  button,
  pre,
  code,
  pill,
  callout,
  ul,
  table,
  hr,
  palette,
  fontStack,
  monoStack,
} from "./html.js";
export type { LayoutOptions, TableColumn, Tone } from "./html.js";

export * from "./templates/index.js";

export {
  sendEmail,
  sendSlack,
  sendDiscord,
  sendWebhook,
  resendOverFetch,
  truncate,
  hmacSha256Hex,
  verifyWebhookSignature,
  DISCORD_CONTENT_LIMIT,
  SIGNATURE_HEADER,
} from "./channels.js";
export type {
  FetchLike,
  SendResult,
  SendEmailOptions,
  ResendLike,
  ResendEmailPayload,
  ResendSendResponse,
  SlackMessage,
  DiscordMessage,
  DiscordEmbed,
  ChannelOptions,
  WebhookOptions,
} from "./channels.js";

export {
  createNotify,
  summarizeAlert,
  summarizeRecovered,
  summarizeDrift,
  summarizeDigest,
} from "./notify.js";
export type {
  Notify,
  NotifyChannels,
  NotifyEmailOptions,
  NotifyEvent,
  FanoutResult,
  CreateNotifyOptions,
} from "./notify.js";
