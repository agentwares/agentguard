/**
 * Hard spend limits for LLM calls: a `fetch` that recognizes OpenAI, Anthropic and Gemini
 * requests, refuses them once the run/day budget is gone, and charges the actual token cost of
 * every response (streamed or not) to the same counters the tool caps use.
 */
import { estimateLlmCost, noListPriceReason, type LlmUsage } from "@agentwares/agentguard-core";
import type { AgentGuard } from "./guard.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GuardedFetchOptions {
  /** underlying fetch (default `globalThis.fetch`) */
  fetch?: FetchLike;
  /** run id override (default: the guard's current run) */
  runId?: () => string;
  /** hosts to treat as LLM providers beyond the built-ins (e.g. a proxy) → provider */
  providers?: Record<string, Provider>;
  /** called with every priced call */
  onSpend?: (info: {
    provider: Provider;
    model: string;
    usage: LlmUsage;
    usd: number | undefined;
  }) => void;
}

export type Provider = "openai" | "anthropic" | "gemini";

const HOSTS: Record<string, Provider> = {
  "api.openai.com": "openai",
  "api.anthropic.com": "anthropic",
  "generativelanguage.googleapis.com": "gemini",
};

export function detectProvider(
  url: URL,
  extra: Record<string, Provider> = {},
): Provider | undefined {
  return extra[url.host] ?? HOSTS[url.host];
}

/** Normalize the usage object of any provider into input/output/cached tokens. */
export function normalizeUsage(provider: Provider, raw: unknown): LlmUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === "number" ? v : 0);
  if (provider === "openai") {
    const details = (u.prompt_tokens_details ?? u.input_tokens_details) as
      Record<string, unknown> | undefined;
    if (u.prompt_tokens !== undefined || u.input_tokens !== undefined) {
      return {
        input_tokens: n(u.prompt_tokens ?? u.input_tokens),
        output_tokens: n(u.completion_tokens ?? u.output_tokens),
        cached_input_tokens: n(details?.cached_tokens),
      };
    }
    return undefined;
  }
  if (provider === "anthropic") {
    if (u.input_tokens === undefined && u.output_tokens === undefined) return undefined;
    return {
      input_tokens:
        n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens),
      output_tokens: n(u.output_tokens),
      cached_input_tokens: n(u.cache_read_input_tokens),
    };
  }
  if (u.promptTokenCount === undefined && u.candidatesTokenCount === undefined) return undefined;
  return {
    input_tokens: n(u.promptTokenCount),
    output_tokens: n(u.candidatesTokenCount) + n(u.thoughtsTokenCount),
    cached_input_tokens: n(u.cachedContentTokenCount),
  };
}

function modelFrom(
  provider: Provider,
  url: URL,
  body: Record<string, unknown> | undefined,
  responseJson?: Record<string, unknown>,
): string {
  if (typeof responseJson?.model === "string") return responseJson.model;
  if (typeof body?.model === "string") return body.model;
  if (provider === "gemini") {
    const m = /\/models\/([^:/]+)/.exec(url.pathname);
    if (m) return m[1]!;
  }
  return "unknown";
}

/** Extract usage from a non-streamed JSON body. */
export function usageFromJson(
  provider: Provider,
  json: Record<string, unknown>,
): LlmUsage | undefined {
  return normalizeUsage(
    provider,
    json.usage ??
      (json.response as Record<string, unknown> | undefined)?.usage ??
      json.usageMetadata,
  );
}

/** Extract usage from a complete SSE transcript (all `data:` payloads). */
export function usageFromSse(provider: Provider, text: string): LlmUsage | undefined {
  let usage: LlmUsage | undefined;
  let anthropicInput: LlmUsage | undefined;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (provider === "anthropic") {
      if (json.type === "message_start")
        anthropicInput = normalizeUsage(
          provider,
          (json.message as Record<string, unknown> | undefined)?.usage,
        );
      if (json.type === "message_delta") {
        const delta = normalizeUsage(provider, json.usage);
        if (delta)
          usage = {
            ...anthropicInput,
            ...delta,
            input_tokens: (delta.input_tokens || anthropicInput?.input_tokens) ?? 0,
          };
      }
      continue;
    }
    const found = usageFromJson(provider, json);
    if (found) usage = found;
  }
  return usage;
}

function blockedResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      error: { type: body.code, message: `${body.code}: ${body.cause} — ${body.fix}` },
      ...body,
    }),
    { status, headers: { "Content-Type": "application/json", "X-Agentguard": String(body.code) } },
  );
}

/**
 * Wrap `fetch` for an OpenAI / Anthropic / Gemini SDK client (`new OpenAI({ fetch })`,
 * `new Anthropic({ fetch })`). Non-provider URLs pass straight through.
 */
export function createGuardedFetch(ag: AgentGuard, opts: GuardedFetchOptions = {}): FetchLike {
  const base = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const runId = opts.runId ?? (() => ag.runId);
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request ? request.url : input instanceof URL ? input.href : String(input));
    const provider = detectProvider(url, opts.providers);
    if (!provider) return base(input, init);

    let bodyText: string | undefined;
    if (typeof init?.body === "string") bodyText = init.body;
    else if (request && request.method !== "GET") bodyText = await request.clone().text();
    let body: Record<string, unknown> | undefined;
    try {
      body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : undefined;
    } catch {
      body = undefined;
    }
    const model = modelFrom(provider, url, body);

    const killed = await ag.guard.killState();
    if (killed.killed) {
      return blockedResponse(403, {
        code: "KILLED",
        cause: `agentguard kill switch is on (${killed.reason ?? ""})`,
        fix: "a human must run `agentguard resume`",
        retryable: false,
      });
    }
    const check = await ag.guard.canSpend(runId(), 0, ag.agent);
    const remaining = Math.min(
      check.remaining.spend_usd?.per_run ?? Infinity,
      check.remaining.spend_usd?.per_day ?? Infinity,
    );
    if (remaining <= 0) {
      const scope = (check.remaining.spend_usd?.per_run ?? Infinity) <= 0 ? "this run" : "today";
      return blockedResponse(402, {
        code: "CAP_EXCEEDED",
        cause: `spend_usd cap for ${scope} is used up`,
        fix: "stop and report to the user; a human can raise caps in agentguard.yaml",
        retryable: false,
        details: { remaining: check.remaining, runId: runId() },
      });
    }

    // OpenAI chat streams only report usage when asked to.
    let forwardedInit = init;
    if (
      provider === "openai" &&
      body?.stream === true &&
      url.pathname.endsWith("/chat/completions") &&
      !body.stream_options
    ) {
      body.stream_options = { include_usage: true };
      forwardedInit = { ...init, body: JSON.stringify(body) };
    }
    const response = await base(
      request && forwardedInit === init ? request : url,
      request && forwardedInit === init
        ? undefined
        : {
            ...forwardedInit,
            method: forwardedInit?.method ?? request?.method,
            headers: forwardedInit?.headers ?? request?.headers,
          },
    );
    if (!response.ok || !response.body) return response;

    const charge = async (usage: LlmUsage | undefined, resolvedModel: string): Promise<void> => {
      if (!usage) return;
      const usd = estimateLlmCost(ag.policy, resolvedModel, usage);
      opts.onSpend?.({ provider, model: resolvedModel, usage, usd });
      // No list price for this model: record the call at $0 rather than dropping it, so the run
      // shows a model the budget is not covering instead of silently under-counting.
      await ag.spend(usd ?? 0, `llm:${resolvedModel}`, {
        force: true,
        runId: runId(),
        details: { provider, model: resolvedModel, usage },
        reason: usd === undefined ? noListPriceReason(resolvedModel) : undefined,
      });
    };

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      let transcript = "";
      const decoder = new TextDecoder();
      const tapped = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            transcript += decoder.decode(chunk, { stream: true });
            controller.enqueue(chunk);
          },
          async flush() {
            transcript += decoder.decode();
            await charge(usageFromSse(provider, transcript), model);
          },
        }),
      );
      return new Response(tapped, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    const text = await response.text();
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      await charge(usageFromJson(provider, json), modelFrom(provider, url, body, json));
    } catch {
      // not JSON
    }
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
