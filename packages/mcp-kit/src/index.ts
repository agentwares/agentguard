/**
 * @agentwares/mcp-kit — expose any package as an MCP server: `defineTool` with a naming lint,
 * one codebase served over stdio and Streamable HTTP, `{ code, cause, fix, retryable }` errors,
 * `withPayment` (402 with x402 + MPP), `server.json` + publish workflow, `llms.txt` and
 * `pricing.json` helpers.
 */
export {
  DEFAULT_HTTP_STATUS,
  DEFAULT_RETRYABLE,
  ERROR_CODES,
  INTERNAL_FIX,
  McpToolError,
  errorResult,
  isErrorResult,
  normalizeError,
  readErrorBody,
  toolError,
  type ErrorCode,
  type ErrorResultOptions,
  type StandardErrorCode,
  type ToolErrorBody,
  type ToolErrorInit,
} from "./errors.js";
export {
  MIN_DESCRIPTION_LENGTH,
  MIN_NAMESPACE_LENGTH,
  TOOL_NAME_PATTERN,
  assertToolName,
  createToolContext,
  defineTool,
  invalidInputError,
  isCallToolResult,
  isValidToolName,
  toCallToolResult,
  type DefineToolOptions,
  type LogLevel,
  type ToolAnnotations,
  type ToolContext,
  type ToolDef,
  type ToolInput,
  type ToolOutput,
} from "./tool.js";
export {
  contextFromExtra,
  createMcpServer,
  listToolManifest,
  toJsonSchema,
  type McpServerOptions,
  type ToolManifestEntry,
} from "./server.js";
export {
  createHttpHandler,
  handleHealth,
  localhostHosts,
  type CorsOptions,
  type HealthInfo,
  type HttpHandler,
  type HttpHandlerOptions,
  type HttpTransportOptions,
  type SessionOptions,
} from "./http.js";
export { serveStdio } from "./stdio.js";
export { serveNodeHttp, type NodeHttpOptions, type NodeHttpServer } from "./node-http.js";
export {
  StubVerifier,
  buildPaymentRequired,
  paymentRequiredError,
  paymentRequiredHttpResponse,
  withPayment,
  type AuthorizeResult,
  type PaymentRequiredBody,
  type PaymentVerifier,
  type WithPaymentOptions,
} from "./payment.js";
export {
  SERVER_JSON_SCHEMA_URL,
  SERVER_NAME_PATTERN,
  generateServerJson,
  registryPublishWorkflow,
  type GenerateServerJsonOptions,
  type RegistryPublishWorkflowOptions,
  type ServerJson,
  type ServerJsonKeyValueInput,
  type ServerJsonNpmPackage,
  type ServerJsonPackage,
  type ServerJsonRemote,
  type ServerJsonRepository,
} from "./registry.js";
export {
  pricingJson,
  renderLlmsTxt,
  type LlmsTxtLink,
  type LlmsTxtSection,
  type PricingJson,
  type PricingJsonOptions,
  type PricingMeter,
  type PricingTier,
  type RenderLlmsTxtOptions,
} from "./docs.js";
export {
  exampleAdd,
  exampleEcho,
  examplePaidLookup,
  exampleServerInfo,
  exampleTools,
} from "./example.js";
export { conformanceTools, registerConformanceFixtures } from "./conformance-fixtures.js";
export type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
