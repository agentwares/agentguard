/**
 * LangChain.js — wrap a `StructuredTool` / `DynamicStructuredTool` / anything with
 * `{ name, description?, _call(args, ...) }` or `{ name, invoke(args, ...) }`. The wrapper keeps the
 * tool's prototype (so `instanceof StructuredTool` still holds) and intercepts `_call`, which every
 * public entry point (`invoke`, `call`, `run`) ends up in. Blocked calls return the error JSON.
 */
import type { AgentGuard, ToolMeta } from "../guard.js";
import type { ToolAnnotationsLike } from "@agentwares/agentguard-core";

export interface LangChainToolLike {
  name: string;
  description?: string;
  _call?: (args: unknown, ...rest: unknown[]) => Promise<unknown> | unknown;
  invoke?: (args: unknown, ...rest: unknown[]) => Promise<unknown> | unknown;
}

export interface LangChainWrapOptions {
  annotations?: ToolAnnotationsLike;
  outputSchema?: Record<string, unknown>;
  onBlock?: "return" | "throw";
}

function stringify(value: unknown): unknown {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function wrapLangChainTool<T extends LangChainToolLike>(
  ag: AgentGuard,
  tool: T,
  opts: LangChainWrapOptions = {},
): T {
  const meta: ToolMeta = {
    name: tool.name,
    description: tool.description,
    annotations: opts.annotations,
    outputSchema: opts.outputSchema,
  };
  const guardCall = async (
    original: (...a: unknown[]) => unknown,
    args: unknown,
    rest: unknown[],
  ): Promise<unknown> => {
    const result = await ag.run(meta, args, () => original(args, ...rest));
    if (result.error && !result.ok) {
      if (opts.onBlock === "throw")
        throw Object.assign(new Error(`${result.error.code}: ${result.error.cause}`), result.error);
      return JSON.stringify(result.error);
    }
    return result.faked ? stringify(result.value) : result.value;
  };
  const wrapped = Object.create(tool) as T;
  if (typeof tool._call === "function") {
    const original = tool._call.bind(tool) as (...a: unknown[]) => unknown;
    Object.defineProperty(wrapped, "_call", {
      value: (args: unknown, ...rest: unknown[]) => guardCall(original, args, rest),
      writable: true,
      configurable: true,
    });
  } else if (typeof tool.invoke === "function") {
    const original = tool.invoke.bind(tool) as (...a: unknown[]) => unknown;
    Object.defineProperty(wrapped, "invoke", {
      value: (args: unknown, ...rest: unknown[]) => guardCall(original, args, rest),
      writable: true,
      configurable: true,
    });
  } else {
    throw new Error(`cannot wrap "${tool.name}": no _call or invoke`);
  }
  return wrapped;
}

export function wrapLangChainTools<T extends LangChainToolLike>(
  ag: AgentGuard,
  tools: T[],
  opts: LangChainWrapOptions & { annotations?: Record<string, ToolAnnotationsLike> } = {},
): T[] {
  return tools.map((t) =>
    wrapLangChainTool(ag, t, { ...opts, annotations: opts.annotations?.[t.name] }),
  );
}
