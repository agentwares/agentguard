/**
 * Programmatic surface of the `agentguard` CLI: run the proxy in-process, build the file-backed
 * guard, or reuse the fixtures. The policy engine itself is `@agentwares/agentguard-core`.
 */
export {
  ProxyRuntime,
  type CallContext,
  type DownstreamSession,
  type ExposedTool,
  type RuntimeOptions,
  type UpstreamStatus,
} from "./proxy/runtime.js";
export {
  createDownstreamServer,
  toCallToolResult,
  runIdFor,
  type DownstreamOptions,
} from "./proxy/server.js";
export {
  startHttpProxy,
  registrationPath,
  type HttpProxy,
  type HttpProxyOptions,
  type HttpRegistration,
} from "./proxy/http.js";
export {
  createFileGuard,
  loadPolicyFor,
  readRegistration,
  type FileGuard,
  type Io,
} from "./context.js";
export { createAlerter, approvalSlackMessage, haltSlackMessage } from "./notify.js";
export {
  candidateConfigs,
  detectClientConfigs,
  readServers,
  rewriteClientConfig,
  restoreClientConfig,
  serversToUpstreams,
  proxyEntry,
  type ClientConfigFile,
  type ServerEntry,
} from "./configs.js";
export { renderStarterPolicy } from "./commands/init.js";
export { probeUpstreams, type ProbedTool, type ProbeResult } from "./commands/tools.js";
export {
  runPermissionDiff,
  DEFAULT_PERMISSION_PATHS,
  type PermissionDiffResult,
} from "./commands/permission-diff.js";
export { createCrmMcpServer, crmTools, seedState, type CrmState } from "./fixtures/crm-server.js";
export { runDemoAgent, type DemoOptions, type DemoStep } from "./fixtures/demo-agent.js";
export { main, HELP } from "./cli.js";
