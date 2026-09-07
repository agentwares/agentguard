/**
 * @agentwares/agentguard-core — the policy engine behind `agentguard` (MCP proxy) and
 * `@agentwares/agentguard-sdk` (middleware). Web-standard; Node stores live in `./node`.
 */
export {
  GUARD_ERROR_CODES,
  GuardError,
  guardError,
  isGuardError,
  toErrorBody,
  type GuardErrorBody,
  type GuardErrorCode,
  type GuardErrorInit,
} from "./errors.js";
export { firstMatch, globToRegExp, matchesAny, matchesGlob } from "./glob.js";
export {
  normalizeArgs,
  redactSecrets,
  sha256Hex,
  stableStringify,
  type NormalizeOptions,
} from "./normalize.js";
export {
  DEFAULT_COUNTERS,
  PolicySchema,
  defaultPolicy,
  effectiveCaps,
  loadPolicyFromYaml,
  parsePolicy,
  substituteEnv,
  upstreamHeaders,
  type AgentScope,
  type Caps,
  type LoadPolicyOptions,
  type Mode,
  type ModelPrice,
  type Policy,
  type PolicyInput,
  type SpendTool,
  type Upstream,
} from "./policy.js";
export {
  classifyByName,
  classifyTool,
  countsFor,
  effectiveClass,
  tokenizeToolName,
  type Classification,
  type HeuristicResult,
  type MutationVerb,
  type ToolAnnotationsLike,
  type ToolClass,
  type ToolLike,
} from "./classify.js";
export {
  LoopDetector,
  describePattern,
  detectLoop,
  loopKey,
  type LoopConfig,
  type LoopVerdict,
} from "./loop.js";
export { CapsEngine, type CapCheck, type CapsScope, type CounterDelta } from "./caps.js";
export {
  DEFAULT_MODEL_PRICES,
  estimateLlmCost,
  estimateSpendFromArgs,
  extractSpendFromResult,
  getPath,
  NO_LIST_PRICE_REASON,
  noListPriceReason,
  priceForModel,
  spendRuleFor,
  type LlmUsage,
} from "./spend.js";
export {
  mutationTarget,
  synthesizeResult,
  type MutationRecord,
  type SynthesizeOptions,
} from "./dryrun.js";
export {
  ChainWriter,
  GENESIS_HASH,
  MemoryAuditSink,
  hashEntry,
  parseAuditJsonl,
  verifyChain,
  type AuditEntry,
  type AuditEntryInput,
  type AuditOutcome,
  type AuditSink,
  type VerifyResult,
} from "./audit.js";
export {
  CompositeKillSwitch,
  EnvKillSwitch,
  MemoryKillSwitch,
  type KillState,
  type KillSwitch,
} from "./kill.js";
export {
  MemoryApprovalStore,
  isExpired,
  newApprovalId,
  type ApprovalRecord,
  type ApprovalStatus,
  type ApprovalStore,
} from "./approvals.js";
export {
  KEY_PREFIX,
  generateAgentKey,
  hashAgentKey,
  keyFromHeaders,
  resolveAgent,
} from "./scope.js";
export { MemoryStateStore, dayKey, type StateStore } from "./state.js";
export {
  Guard,
  type Decision,
  type Execute,
  type GuardCall,
  type GuardEvent,
  type GuardOptions,
  type GuardResult,
} from "./guard.js";
export {
  buildReport,
  latestRunId,
  listRuns,
  renderMutationDiff,
  renderReportMarkdown,
  type Halt,
  type Report,
  type RunSummary,
} from "./report.js";
export {
  diffAgentguardPolicy,
  diffClaudeSettings,
  diffMcpConfig,
  diffPermissionFile,
  renderPermissionDiffMarkdown,
  type Finding,
  type Severity,
} from "./permission-diff.js";
