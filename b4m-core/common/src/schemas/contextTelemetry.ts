import { z } from 'zod';

/**
 * Context Telemetry Schema
 *
 * Privacy-first telemetry for LLM completion operational metadata.
 * Captures debugging data WITHOUT storing content or user identity.
 *
 * Data Classification: TRUE ANONYMIZATION
 * - No userId, no questId stored (only SHA256 hash)
 * - No content captured (prompts, responses)
 * - Hash cannot be reversed to identify users
 *
 * Retention: 90-day TTL via background cleanup job
 */

// Schema version for future migrations
// 1.2: added per-tool extracted-size + truncation fields (web_fetch, issue #452)
export const CONTEXT_TELEMETRY_SCHEMA_VERSION = '1.2' as const;

// Capture level type
export type ContextTelemetryCaptureLevel = 'basic' | 'enhanced';

// Anonymous Session ID Schema
export const AnonymousSessionIdSchema = z.object({
  /** SHA256(userId|orgId|dailySalt|date) - cannot be reversed */
  hash: z.string(),
  /** YYYY-MM-DD for salt lookup during deletion */
  dateKey: z.string(),
});

// OpenTelemetry span context for distributed tracing
export const SpanContextSchema = z.object({
  /** gen_ai.trace_id */
  traceId: z.string(),
  /** gen_ai.span_id */
  spanId: z.string(),
});

// Operation metadata (OTel gen_ai.operation.*)
export const OperationSchema = z.object({
  name: z.enum(['chat_completion', 'agent_invoke', 'tool_execute']),
  finishReason: z.enum(['stop', 'length', 'tool_use', 'content_filter', 'error']).optional(),
});

// Model telemetry
export const ModelTelemetrySchema = z.object({
  /** gen_ai.request.model */
  modelId: z.string(),
  provider: z.enum(['anthropic', 'openai', 'bedrock', 'google', 'xai', 'ollama']),
  fallbackUsed: z.boolean(),
  fallbackReason: z.string().optional(),
  originalModelId: z.string().optional(),
  usedThinking: z.boolean(),
  /** Extended thinking tokens */
  thinkingTokensUsed: z.number().optional(),
  usedTools: z.boolean(),
});

// System prompt detail
export const SystemPromptDetailSchema = z.object({
  source: z.enum(['hardcoded', 'admin', 'user', 'project', 'session', 'org']),
  /** e.g., "date_context", "tool_guidance" */
  name: z.string(),
  tokenCount: z.number(),
  wasIncluded: z.boolean(),
  exclusionReason: z.enum(['duplicate', 'disabled', 'token_limit']).optional(),
});

// System prompts telemetry
export const SystemPromptsTelemetrySchema = z.object({
  prompts: z.array(SystemPromptDetailSchema),
  totalTokens: z.number(),
  duplicateCount: z.number(),
});

// Feature contribution detail
export const FeatureContributionSchema = z.object({
  /** e.g., "mementos", "quest_master", "deep_research" */
  featureName: z.string(),
  messagesAdded: z.number(),
  tokenCount: z.number(),
  executionTimeMs: z.number(),
  success: z.boolean(),
  errorType: z.string().optional(),
});

// Features telemetry
export const FeaturesTelemetrySchema = z.object({
  contributions: z.array(FeatureContributionSchema),
});

// Token breakdown by source
export const TokensBySourceSchema = z.object({
  systemPrompts: z.number(),
  conversationHistory: z.number(),
  mementos: z.number(),
  fabFiles: z.number(),
  urlContent: z.number(),
  toolSchemas: z.number(),
  userPrompt: z.number(),
});

// Context window telemetry
export const ContextWindowTelemetrySchema = z.object({
  /** gen_ai.usage.input_tokens */
  inputTokens: z.number(),
  /** gen_ai.usage.output_tokens */
  outputTokens: z.number(),
  contextWindowLimit: z.number(),
  utilizationPercentage: z.number(),
  reservedOutputTokens: z.number(),
  overflowDetected: z.boolean(),
  overflowAmount: z.number().optional(),
  /** Token breakdown by source */
  tokensBySource: TokensBySourceSchema,
});

// Cache metrics (leverages existing CacheUsageStats)
export const CacheTelemetrySchema = z.object({
  /** Anthropic cache_read_input_tokens */
  cacheReadTokens: z.number(),
  /** Anthropic cache_creation_input_tokens */
  cacheWriteTokens: z.number(),
  /** 0-100% */
  cacheHitRate: z.number(),
  costSavingsPercent: z.number().optional(),
});

// Cost tracking
export const CostsTelemetrySchema = z.object({
  inputCostUsd: z.number(),
  outputCostUsd: z.number(),
  totalCostUsd: z.number(),
  creditsUsed: z.number(),
});

// Truncation telemetry
export const TruncationTelemetrySchema = z.object({
  wasTruncated: z.boolean(),
  originalMessageCount: z.number(),
  finalMessageCount: z.number(),
  truncatedMessageCount: z.number(),
  truncationMethod: z.enum(['priority', 'token-budget', 'history-limit', 'context-overflow']).optional(),
  truncationPercentage: z.number(),
});

// Error categories for tools
export const ToolErrorCategorySchema = z.enum([
  'timeout',
  'rate_limit',
  'auth_error',
  'validation_error',
  'network_error',
  'internal_error',
]);

// Tool telemetry
export const ToolTelemetrySchema = z.object({
  toolName: z.string(),
  /** MCP vs native tool */
  isMcpTool: z.boolean(),
  /** For MCP tools */
  mcpServerName: z.string().optional(),
  invocationCount: z.number(),
  successCount: z.number(),
  failureCount: z.number(),
  totalDurationMs: z.number(),
  maxDurationMs: z.number(),
  /** Retry tracking */
  retryCount: z.number(),
  /** Max 200 chars */
  lastError: z.string().max(200).optional(),
  errorCategories: z.array(ToolErrorCategorySchema).optional(),
  /**
   * Content-size metrics for tools that extract text (currently web_fetch, issue #452).
   * Zero-PII integer counts, so kept at both basic and enhanced capture levels.
   */
  /** Invocations whose extracted content was truncated at the tool's size cap. */
  truncatedInvocationCount: z.number().optional(),
  /** Largest single extracted (post-cap) content length across invocations. */
  maxExtractedChars: z.number().optional(),
  /** Sum of extracted (post-cap) content length across invocations. */
  totalExtractedChars: z.number().optional(),
});

// Sub-agent telemetry
export const SubagentTelemetrySchema = z.object({
  agentName: z.string(),
  delegationCount: z.number(),
  successCount: z.number(),
  failureCount: z.number(),
  timeoutCount: z.number(),
  totalDurationMs: z.number(),
  totalTokensUsed: z.number(),
  thoroughness: z.enum(['quick', 'medium', 'very_thorough']).optional(),
});

// Latency percentiles
export const LatencyPercentilesSchema = z.object({
  p50Ms: z.number(),
  p95Ms: z.number(),
  p99Ms: z.number(),
});

// Performance telemetry
export const PerformanceTelemetrySchema = z.object({
  totalResponseTimeMs: z.number(),
  firstTokenTimeMs: z.number().optional(),
  contextRetrievalMs: z.number().optional(),
  modelInferenceMs: z.number().optional(),
  toolExecutionMs: z.number().optional(),
  /** Latency percentiles for trend analysis */
  latencyPercentiles: LatencyPercentilesSchema.optional(),
});

// Anomaly severity (aligns with PagerDuty/Datadog)
export const AnomalySeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);

// Primary anomaly type
export const PrimaryAnomalySchema = z.enum([
  'none',
  'context_overflow',
  'high_truncation',
  'tool_failure',
  'subagent_timeout',
  'slow_response',
  'multiple',
]);

// Anomalies telemetry
export const AnomaliesTelemetrySchema = z.object({
  contextOverflow: z.boolean(),
  /** >= 90% */
  highUtilization: z.boolean(),
  /** >= 95% */
  criticalUtilization: z.boolean(),
  /** >= 50% */
  highTruncation: z.boolean(),
  /** >= 75% */
  criticalTruncation: z.boolean(),
  /** >= 3 failures */
  toolFailureSpike: z.boolean(),
  /** > 30s */
  toolTimeout: z.boolean(),
  /** > 5min */
  subagentTimeout: z.boolean(),
  /** > 10s */
  slowFirstToken: z.boolean(),
  /** > 60s */
  slowTotalResponse: z.boolean(),
  /** 0-100 */
  anomalyScore: z.number().min(0).max(100),
  /** Severity mapping */
  severity: AnomalySeveritySchema,
  /** Pattern-based dedup key, e.g., "tool_failure_claude-3-5-sonnet_delegate-to-agent" */
  dedupKey: z.string(),
  primaryAnomaly: PrimaryAnomalySchema,
});

// Request metadata
export const RequestMetadataSchema = z.object({
  queryComplexity: z.enum(['simple', 'contextual', 'complex']),
  historyMessageCount: z.number(),
  attachedFileCount: z.number(),
  mementoCount: z.number(),
  enabledFeatures: z.array(z.string()),
});

// Context window schema with optional tokensBySource (included in basic+enhanced, optional for backwards compat with v1.0)
export const ContextWindowTelemetryWithOptionalSourceSchema = z.object({
  /** gen_ai.usage.input_tokens */
  inputTokens: z.number(),
  /** gen_ai.usage.output_tokens */
  outputTokens: z.number(),
  contextWindowLimit: z.number(),
  utilizationPercentage: z.number(),
  reservedOutputTokens: z.number(),
  overflowDetected: z.boolean(),
  overflowAmount: z.number().optional(),
  /** Token breakdown by source (enhanced only) */
  tokensBySource: TokensBySourceSchema.optional(),
});

// Main Context Telemetry Schema
export const ContextTelemetrySchema = z.object({
  schemaVersion: z.enum(['1.0', '1.1', '1.2']),
  /** ISO 8601 */
  timestamp: z.string(),
  /** Self-monitoring: time to capture telemetry */
  captureOverheadMs: z.number(),

  /** Capture level: basic or enhanced */
  captureLevel: z.enum(['basic', 'enhanced']).optional(),

  // Privacy: TRUE ANONYMIZATION (no PII link)
  anonymousSessionId: AnonymousSessionIdSchema,

  // OpenTelemetry span context for distributed tracing
  spanContext: SpanContextSchema.optional(),

  // Operation metadata
  operation: OperationSchema,

  // Model info
  model: ModelTelemetrySchema,

  // System prompts (enhanced only - can fingerprint feature usage)
  systemPrompts: SystemPromptsTelemetrySchema.optional(),

  // Feature contributions (enhanced only - can fingerprint user behavior)
  features: FeaturesTelemetrySchema.optional(),

  // Context window metrics including tokensBySource (basic + enhanced - zero PII, integer counts only)
  contextWindow: ContextWindowTelemetryWithOptionalSourceSchema,

  // Cache metrics (basic + enhanced)
  cache: CacheTelemetrySchema.optional(),

  // Cost tracking
  costs: CostsTelemetrySchema,

  // Truncation tracking (basic + enhanced)
  truncation: TruncationTelemetrySchema.optional(),

  // Tool execution metrics (basic: operational metrics without lastError; enhanced: full)
  tools: z.array(ToolTelemetrySchema).optional(),

  // Sub-agent metrics (basic + enhanced)
  subagents: z.array(SubagentTelemetrySchema).optional(),

  // Performance metrics
  performance: PerformanceTelemetrySchema,

  // Anomaly detection
  anomalies: AnomaliesTelemetrySchema,

  // Request metadata (enhanced only - enabledFeatures can fingerprint users)
  requestMetadata: RequestMetadataSchema.optional(),

  // Capture errors (for partial telemetry)
  captureErrors: z.array(z.string()).optional(),
});

// Type exports
export type AnonymousSessionId = z.infer<typeof AnonymousSessionIdSchema>;
export type SpanContext = z.infer<typeof SpanContextSchema>;
export type Operation = z.infer<typeof OperationSchema>;
export type ModelTelemetry = z.infer<typeof ModelTelemetrySchema>;
export type SystemPromptDetail = z.infer<typeof SystemPromptDetailSchema>;
export type SystemPromptsTelemetry = z.infer<typeof SystemPromptsTelemetrySchema>;
export type FeatureContribution = z.infer<typeof FeatureContributionSchema>;
export type FeaturesTelemetry = z.infer<typeof FeaturesTelemetrySchema>;
export type TokensBySource = z.infer<typeof TokensBySourceSchema>;
export type ContextWindowTelemetry = z.infer<typeof ContextWindowTelemetrySchema>;
export type CacheTelemetry = z.infer<typeof CacheTelemetrySchema>;
export type CostsTelemetry = z.infer<typeof CostsTelemetrySchema>;
export type TruncationTelemetry = z.infer<typeof TruncationTelemetrySchema>;
export type ToolErrorCategory = z.infer<typeof ToolErrorCategorySchema>;
export type ToolTelemetry = z.infer<typeof ToolTelemetrySchema>;
export type SubagentTelemetry = z.infer<typeof SubagentTelemetrySchema>;
export type LatencyPercentiles = z.infer<typeof LatencyPercentilesSchema>;
export type PerformanceTelemetry = z.infer<typeof PerformanceTelemetrySchema>;
export type AnomalySeverity = z.infer<typeof AnomalySeveritySchema>;
export type PrimaryAnomaly = z.infer<typeof PrimaryAnomalySchema>;
export type AnomaliesTelemetry = z.infer<typeof AnomaliesTelemetrySchema>;
export type RequestMetadata = z.infer<typeof RequestMetadataSchema>;
export type ContextTelemetry = z.infer<typeof ContextTelemetrySchema>;

// Anomaly weight constants for scoring
export const ANOMALY_WEIGHTS = {
  contextOverflow: 30,
  criticalUtilization: 25,
  criticalTruncation: 20,
  subagentTimeout: 20,
  toolFailureSpike: 15,
  highTruncation: 10,
  highUtilization: 10,
  toolTimeout: 10,
  slowTotalResponse: 10,
  slowFirstToken: 5,
} as const;

// Anomaly thresholds
export const ANOMALY_THRESHOLDS = {
  highUtilization: 90, // >= 90%
  criticalUtilization: 95, // >= 95%
  highTruncation: 50, // >= 50%
  criticalTruncation: 75, // >= 75%
  toolFailureSpike: 3, // >= 3 failures
  toolTimeout: 30000, // > 30s
  subagentTimeout: 300000, // > 5min
  slowFirstToken: 10000, // > 10s
  slowTotalResponse: 60000, // > 60s
} as const;

// Alert thresholds
export const ALERT_THRESHOLDS = {
  /** Minimum score to trigger any alert */
  warning: 30,
  /** Score threshold for @here mentions */
  critical: 50,
} as const;

// Historical baselines computed from MongoDB aggregation at analysis time
export const HistoricalBaselinesSchema = z.object({
  avgResponseTimeMs: z.number(),
  p95ResponseTimeMs: z.number(),
  avgUtilization: z.number(),
  utilizationRange: z.object({
    low: z.number(),
    high: z.number(),
  }),
  sampleCount: z.number(),
  windowDays: z.number(),
});
export type HistoricalBaselines = z.infer<typeof HistoricalBaselinesSchema>;

// Recommended action enum for analysis output
export const RecommendedActionSchema = z.enum(['no_action', 'monitor', 'investigate_soon', 'immediate_action']);
export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;

/**
 * Map anomaly score to a recommended action.
 * Thresholds: <20->no_action, 20-49->monitor, 50-69->investigate_soon, 70+->immediate_action
 */
export function getRecommendedAction(anomalyScore: number): RecommendedAction {
  if (anomalyScore >= 70) return 'immediate_action';
  if (anomalyScore >= 50) return 'investigate_soon';
  if (anomalyScore >= 20) return 'monitor';
  return 'no_action';
}
