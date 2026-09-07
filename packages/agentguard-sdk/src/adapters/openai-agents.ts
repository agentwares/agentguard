/**
 * OpenAI Agents SDK (`@openai/agents`) — wrap the object `tool({...})` returns. Duck-typed on
 * `{ name, description?, parameters?, invoke(runContext, input) }` so this package has no
 * dependency on the SDK. Blocked calls return the structured error as the tool's string result
 * (the model reads `fix`), so the run keeps going instead of crashing.
 */
import type { AgentGuard, ToolMeta } from "../guard.js";
import type { ToolAnnotationsLike } from "@agentwares/agentguard-core";

export interface OpenAIAgentsToolLike {
  name: string;
  description?: string;
  parameters?: unknown;
  invoke: (runContext: unknown, input: string, ...rest: unknown[]) => Promise<unknown> | unknown;
}

export interface OpenAIAgentsWrapOptions {
  annotations?: ToolAnnotationsLike;
  outputSchema?: Record<string, unknown>;
  /** `return` (default): blocked calls return the error JSON as the tool output; `throw`: throw `GuardError` */
  onBlock?: "return" | "throw";
}

function parseInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return { input };
  }
}

export function wrapOpenAIAgentsTool<T extends OpenAIAgentsToolLike>(
  ag: AgentGuard,
  tool: T,
  opts: OpenAIAgentsWrapOptions = {},
): T {
  const meta: ToolMeta = {
    name: tool.name,
    description: tool.description,
    annotations: opts.annotations,
    outputSchema: opts.outputSchema,
  };
  const original = tool.invoke.bind(tool);
  const invoke = async (
    runContext: unknown,
    input: string,
    ...rest: unknown[]
  ): Promise<unknown> => {
    const result = await ag.run(meta, parseInput(input), () =>
      original(runContext, input, ...rest),
    );
    if (result.error && !result.ok) {
      if (opts.onBlock === "throw")
        throw Object.assign(new Error(`${result.error.code}: ${result.error.cause}`), result.error);
      return JSON.stringify(result.error);
    }
    if (result.faked)
      return typeof result.value === "string" ? result.value : JSON.stringify(result.value);
    return result.value;
  };
  return { ...tool, invoke } as T;
}

export function wrapOpenAIAgentsTools<T extends OpenAIAgentsToolLike>(
  ag: AgentGuard,
  tools: T[],
  opts: OpenAIAgentsWrapOptions & { annotations?: Record<string, ToolAnnotationsLike> } = {},
): T[] {
  return tools.map((t) =>
    wrapOpenAIAgentsTool(ag, t, { ...opts, annotations: opts.annotations?.[t.name] }),
  );
}
