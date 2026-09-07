/**
 * @agentwares/agentguard-sdk — agentguard for tool calls that bypass MCP.
 *
 *   const ag = await createGuard({ policy: "agentguard.yaml" });
 *   const tools = wrapOpenAIAgentsTools(ag, [deleteContact, sendEmail]);
 *   const openai = new OpenAI({ fetch: createGuardedFetch(ag) });   // hard spend limit on tokens
 */
export {
  AgentGuard,
  createGuard,
  newRunId,
  type AnyFn,
  type CreateGuardOptions,
  type ToolMeta,
  type WrapOptions,
} from "./guard.js";
export {
  createGuardedFetch,
  detectProvider,
  normalizeUsage,
  usageFromJson,
  usageFromSse,
  type FetchLike,
  type GuardedFetchOptions,
  type Provider,
} from "./fetch.js";
export {
  wrapOpenAIAgentsTool,
  wrapOpenAIAgentsTools,
  type OpenAIAgentsToolLike,
  type OpenAIAgentsWrapOptions,
} from "./adapters/openai-agents.js";
export {
  wrapLangChainTool,
  wrapLangChainTools,
  type LangChainToolLike,
  type LangChainWrapOptions,
} from "./adapters/langchain.js";
export {
  GuardError,
  type GuardErrorBody,
  type GuardEvent,
  type GuardResult,
  type Policy,
  type PolicyInput,
  type Report,
} from "@agentwares/agentguard-core";
