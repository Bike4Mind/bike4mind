import {
  ContextTelemetry,
  ContextTelemetryCaptureLevel,
  ModelTelemetry,
  CONTEXT_TELEMETRY_SCHEMA_VERSION,
  AnonymousSessionId,
  Operation,
  SystemPromptsTelemetry,
  FeaturesTelemetry,
  ContextWindowTelemetry,
  CostsTelemetry,
  TruncationTelemetry,
  ToolTelemetry,
  SubagentTelemetry,
  PerformanceTelemetry,
  AnomaliesTelemetry,
  RequestMetadata,
  CacheTelemetry,
  TokensBySource,
  ANOMALY_WEIGHTS,
  ANOMALY_THRESHOLDS,
  ModelBackend,
} from '@bike4mind/common';

import type { ToolErrorCategory } from '@bike4mind/common';

/**
 * Categorizes a tool error message into a standardized category
 */
export function categorizeToolError(errorMessage: string): ToolErrorCategory {
  const msg = errorMessage.toLowerCase();

  // Timeout errors
  if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('timed out')) {
    return 'timeout';
  }

  // Rate limit errors
  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests')) {
    return 'rate_limit';
  }

  // Auth errors
  if (
    msg.includes('auth') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('401') ||
    msg.includes('403')
  ) {
    return 'auth_error';
  }

  // Validation errors
  if (msg.includes('validation') || msg.includes('invalid') || msg.includes('required') || msg.includes('400')) {
    return 'validation_error';
  }

  // Network errors
  if (
    msg.includes('network') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('dns') ||
    msg.includes('connection')
  ) {
    return 'network_error';
  }

  // Default to internal error
  return 'internal_error';
}

/**
 * Maps ModelBackend to telemetry provider type
 */
export function mapBackendToProvider(backend: ModelBackend | string): ModelTelemetry['provider'] {
  switch (backend) {
    case ModelBackend.Anthropic:
    case 'anthropic':
      return 'anthropic';
    case ModelBackend.OpenAI:
    case 'openai':
      return 'openai';
    case ModelBackend.Bedrock:
    case 'bedrock':
      return 'bedrock';
    case ModelBackend.Gemini:
    case 'gemini':
      return 'google';
    case ModelBackend.XAI:
    case 'xai':
      return 'xai';
    case ModelBackend.Ollama:
    case 'ollama':
      return 'ollama';
    default:
      // Default to anthropic for unknown backends
      return 'anthropic';
  }
}

/**
 * TelemetryBuilder
 *
 * Collects telemetry data during the LLM completion process.
 * Call methods as data becomes available, then call build() at the end.
 *
 * Usage:
 *   const builder = new TelemetryBuilder(anonymousSessionId);
 *   builder.setModel({ ... });
 *   builder.setFallback({ ... });
 *   // ... more setters
 *   const telemetry = builder.build();
 */
export class TelemetryBuilder {
  private captureStartTime: number;
  private anonymousSessionId: AnonymousSessionId;
  private errors: string[] = [];
  private captureLevel: ContextTelemetryCaptureLevel = 'basic';

  // Model tracking
  private requestedModelId?: string;
  private actualModelId?: string;
  private provider?: ModelTelemetry['provider'];
  private fallbackUsed = false;
  private fallbackReason?: string;
  private usedThinking = false;
  private thinkingTokensUsed?: number;
  private usedTools = false;

  // Operation tracking
  private operationName: Operation['name'] = 'chat_completion';
  private finishReason?: Operation['finishReason'];

  // System prompts tracking
  private systemPrompts: SystemPromptsTelemetry = {
    prompts: [],
    totalTokens: 0,
    duplicateCount: 0,
  };

  // Features tracking
  private features: FeaturesTelemetry = { contributions: [] };

  // Context window tracking
  private contextWindow: Partial<ContextWindowTelemetry> = {};
  private tokensBySource: Partial<TokensBySource> = {};

  // Cache tracking
  private cache?: CacheTelemetry;

  // Costs tracking
  private costs: Partial<CostsTelemetry> = {};

  // Truncation tracking
  private truncation: Partial<TruncationTelemetry> = {};

  // Tools tracking
  private tools: ToolTelemetry[] = [];

  // Subagents tracking
  private subagents: SubagentTelemetry[] = [];

  // Performance tracking
  private performance: Partial<PerformanceTelemetry> = {};

  // Request metadata
  private requestMetadata: Partial<RequestMetadata> = {};

  constructor(anonymousSessionId: AnonymousSessionId) {
    this.captureStartTime = Date.now();
    this.anonymousSessionId = anonymousSessionId;
  }

  setCaptureLevel(level: ContextTelemetryCaptureLevel): this {
    this.captureLevel = level;
    return this;
  }

  /**
   * Record an error during telemetry capture (non-blocking)
   */
  recordError(error: string): this {
    this.errors.push(error);
    return this;
  }

  // Model & Fallback

  setRequestedModel(modelId: string, provider: ModelTelemetry['provider']): this {
    this.requestedModelId = modelId;
    this.provider = provider;
    this.actualModelId = modelId; // Initially same as requested
    return this;
  }

  setActualModel(modelId: string): this {
    this.actualModelId = modelId;
    return this;
  }

  setFallback(used: boolean, reason?: string): this {
    this.fallbackUsed = used;
    this.fallbackReason = reason;
    return this;
  }

  setThinking(used: boolean, tokensUsed?: number): this {
    this.usedThinking = used;
    this.thinkingTokensUsed = tokensUsed;
    return this;
  }

  setUsedTools(used: boolean): this {
    this.usedTools = used;
    return this;
  }

  // Operation

  setOperation(name: Operation['name']): this {
    this.operationName = name;
    return this;
  }

  setFinishReason(reason: Operation['finishReason']): this {
    this.finishReason = reason;
    return this;
  }

  // System Prompts

  setSystemPrompts(prompts: SystemPromptsTelemetry): this {
    this.systemPrompts = prompts;
    return this;
  }

  // Features

  setFeatures(features: FeaturesTelemetry): this {
    this.features = features;
    return this;
  }

  addFeatureContribution(contribution: FeaturesTelemetry['contributions'][0]): this {
    this.features.contributions.push(contribution);
    return this;
  }

  // Context Window

  setContextWindow(data: Partial<ContextWindowTelemetry>): this {
    this.contextWindow = { ...this.contextWindow, ...data };
    return this;
  }

  setTokensBySource(data: Partial<TokensBySource>): this {
    this.tokensBySource = { ...this.tokensBySource, ...data };
    return this;
  }

  // Cache

  setCache(data: CacheTelemetry): this {
    this.cache = data;
    return this;
  }

  // Costs

  setCosts(data: Partial<CostsTelemetry>): this {
    this.costs = { ...this.costs, ...data };
    return this;
  }

  // Truncation

  setTruncation(data: Partial<TruncationTelemetry>): this {
    this.truncation = { ...this.truncation, ...data };
    return this;
  }

  // Tools

  addTool(tool: ToolTelemetry): this {
    this.tools.push(tool);
    return this;
  }

  setTools(tools: ToolTelemetry[]): this {
    this.tools = tools;
    return this;
  }

  // Subagents

  addSubagent(subagent: SubagentTelemetry): this {
    this.subagents.push(subagent);
    return this;
  }

  setSubagents(subagents: SubagentTelemetry[]): this {
    this.subagents = subagents;
    return this;
  }

  // Performance

  setPerformance(data: Partial<PerformanceTelemetry>): this {
    this.performance = { ...this.performance, ...data };
    return this;
  }

  // Request Metadata

  setRequestMetadata(data: Partial<RequestMetadata>): this {
    this.requestMetadata = { ...this.requestMetadata, ...data };
    return this;
  }

  // Build

  /**
   * Computes anomaly flags and score based on collected data
   */
  private computeAnomalies(): AnomaliesTelemetry {
    const flags = {
      contextOverflow: this.contextWindow.overflowDetected ?? false,
      highUtilization: (this.contextWindow.utilizationPercentage ?? 0) >= ANOMALY_THRESHOLDS.highUtilization,
      criticalUtilization: (this.contextWindow.utilizationPercentage ?? 0) >= ANOMALY_THRESHOLDS.criticalUtilization,
      highTruncation: (this.truncation.truncationPercentage ?? 0) >= ANOMALY_THRESHOLDS.highTruncation,
      criticalTruncation: (this.truncation.truncationPercentage ?? 0) >= ANOMALY_THRESHOLDS.criticalTruncation,
      toolFailureSpike: this.tools.reduce((sum, t) => sum + t.failureCount, 0) >= ANOMALY_THRESHOLDS.toolFailureSpike,
      toolTimeout: this.tools.some(t => t.maxDurationMs > ANOMALY_THRESHOLDS.toolTimeout),
      subagentTimeout: this.subagents.some(s => s.totalDurationMs > ANOMALY_THRESHOLDS.subagentTimeout),
      slowFirstToken: (this.performance.firstTokenTimeMs ?? 0) > ANOMALY_THRESHOLDS.slowFirstToken,
      slowTotalResponse: (this.performance.totalResponseTimeMs ?? 0) > ANOMALY_THRESHOLDS.slowTotalResponse,
    };

    // Calculate anomaly score
    let score = 0;
    if (flags.contextOverflow) score += ANOMALY_WEIGHTS.contextOverflow;
    if (flags.criticalUtilization) score += ANOMALY_WEIGHTS.criticalUtilization;
    else if (flags.highUtilization) score += ANOMALY_WEIGHTS.highUtilization;
    if (flags.criticalTruncation) score += ANOMALY_WEIGHTS.criticalTruncation;
    else if (flags.highTruncation) score += ANOMALY_WEIGHTS.highTruncation;
    if (flags.subagentTimeout) score += ANOMALY_WEIGHTS.subagentTimeout;
    if (flags.toolFailureSpike) score += ANOMALY_WEIGHTS.toolFailureSpike;
    if (flags.toolTimeout) score += ANOMALY_WEIGHTS.toolTimeout;
    if (flags.slowTotalResponse) score += ANOMALY_WEIGHTS.slowTotalResponse;
    if (flags.slowFirstToken) score += ANOMALY_WEIGHTS.slowFirstToken;

    // Cap at 100
    score = Math.min(score, 100);

    // Determine severity
    let severity: AnomaliesTelemetry['severity'];
    if (score >= 50) severity = 'critical';
    else if (score >= 30) severity = 'high';
    else if (score >= 20) severity = 'medium';
    else severity = 'low';

    // Determine primary anomaly
    let primaryAnomaly: AnomaliesTelemetry['primaryAnomaly'] = 'none';
    const activeFlags = Object.entries(flags).filter(([, v]) => v);
    if (activeFlags.length > 1) {
      primaryAnomaly = 'multiple';
    } else if (flags.contextOverflow) {
      primaryAnomaly = 'context_overflow';
    } else if (flags.criticalTruncation || flags.highTruncation) {
      primaryAnomaly = 'high_truncation';
    } else if (flags.toolFailureSpike || flags.toolTimeout) {
      primaryAnomaly = 'tool_failure';
    } else if (flags.subagentTimeout) {
      primaryAnomaly = 'subagent_timeout';
    } else if (flags.slowTotalResponse || flags.slowFirstToken) {
      primaryAnomaly = 'slow_response';
    }

    // Generate dedup key based on pattern
    const dedupParts = [primaryAnomaly, this.actualModelId];
    if (flags.toolFailureSpike && this.tools.length > 0) {
      const failedTool = this.tools.find(t => t.failureCount > 0);
      if (failedTool) dedupParts.push(failedTool.toolName);
    }
    const dedupKey = dedupParts.filter(Boolean).join('_');

    return {
      ...flags,
      anomalyScore: score,
      severity,
      dedupKey,
      primaryAnomaly,
    };
  }

  /**
   * Build the final ContextTelemetry object
   */
  build(): ContextTelemetry {
    const captureOverheadMs = Date.now() - this.captureStartTime;

    // Build complete tokensBySource with defaults
    const tokensBySource: TokensBySource = {
      systemPrompts: this.tokensBySource.systemPrompts ?? 0,
      conversationHistory: this.tokensBySource.conversationHistory ?? 0,
      mementos: this.tokensBySource.mementos ?? 0,
      fabFiles: this.tokensBySource.fabFiles ?? 0,
      urlContent: this.tokensBySource.urlContent ?? 0,
      toolSchemas: this.tokensBySource.toolSchemas ?? 0,
      userPrompt: this.tokensBySource.userPrompt ?? 0,
    };

    // Build complete contextWindow with defaults
    const contextWindow: ContextWindowTelemetry = {
      inputTokens: this.contextWindow.inputTokens ?? 0,
      outputTokens: this.contextWindow.outputTokens ?? 0,
      contextWindowLimit: this.contextWindow.contextWindowLimit ?? 0,
      utilizationPercentage: this.contextWindow.utilizationPercentage ?? 0,
      reservedOutputTokens: this.contextWindow.reservedOutputTokens ?? 0,
      overflowDetected: this.contextWindow.overflowDetected ?? false,
      overflowAmount: this.contextWindow.overflowAmount,
      tokensBySource,
    };

    // Build complete costs with defaults
    const costs: CostsTelemetry = {
      inputCostUsd: this.costs.inputCostUsd ?? 0,
      outputCostUsd: this.costs.outputCostUsd ?? 0,
      totalCostUsd: this.costs.totalCostUsd ?? 0,
      creditsUsed: this.costs.creditsUsed ?? 0,
    };

    // Build complete truncation with defaults
    const truncation: TruncationTelemetry = {
      wasTruncated: this.truncation.wasTruncated ?? false,
      originalMessageCount: this.truncation.originalMessageCount ?? 0,
      finalMessageCount: this.truncation.finalMessageCount ?? 0,
      truncatedMessageCount: this.truncation.truncatedMessageCount ?? 0,
      truncationMethod: this.truncation.truncationMethod,
      truncationPercentage: this.truncation.truncationPercentage ?? 0,
    };

    // Build complete performance with defaults
    const performance: PerformanceTelemetry = {
      totalResponseTimeMs: this.performance.totalResponseTimeMs ?? 0,
      firstTokenTimeMs: this.performance.firstTokenTimeMs,
      contextRetrievalMs: this.performance.contextRetrievalMs,
      modelInferenceMs: this.performance.modelInferenceMs,
      toolExecutionMs: this.performance.toolExecutionMs,
      latencyPercentiles: this.performance.latencyPercentiles,
    };

    // Build complete requestMetadata with defaults
    const requestMetadata: RequestMetadata = {
      queryComplexity: this.requestMetadata.queryComplexity ?? 'contextual',
      historyMessageCount: this.requestMetadata.historyMessageCount ?? 0,
      attachedFileCount: this.requestMetadata.attachedFileCount ?? 0,
      mementoCount: this.requestMetadata.mementoCount ?? 0,
      enabledFeatures: this.requestMetadata.enabledFeatures ?? [],
    };

    // Build model telemetry
    const model: ModelTelemetry = {
      modelId: this.actualModelId ?? this.requestedModelId ?? 'unknown',
      provider: this.provider ?? 'anthropic',
      fallbackUsed: this.fallbackUsed,
      fallbackReason: this.fallbackReason,
      originalModelId: this.fallbackUsed ? this.requestedModelId : undefined,
      usedThinking: this.usedThinking,
      thinkingTokensUsed: this.thinkingTokensUsed,
      usedTools: this.usedTools,
    };

    // Compute anomalies
    const anomalies = this.computeAnomalies();

    const result: ContextTelemetry = {
      schemaVersion: CONTEXT_TELEMETRY_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      captureOverheadMs,
      captureLevel: this.captureLevel,
      anonymousSessionId: this.anonymousSessionId,
      operation: {
        name: this.operationName,
        finishReason: this.finishReason,
      },
      model,
      systemPrompts: this.systemPrompts,
      features: this.features,
      contextWindow,
      cache: this.cache,
      costs,
      truncation,
      tools: this.tools.length > 0 ? this.tools : undefined,
      subagents: this.subagents.length > 0 ? this.subagents : undefined,
      performance,
      anomalies,
      requestMetadata,
      captureErrors: this.errors.length > 0 ? this.errors : undefined,
    };

    // Strip enhanced-only fields when capture level is basic.
    // Basic keeps operational diagnostics (truncation, tools, cache, subagents, tokensBySource)
    // but strips fields that could fingerprint user behavior (systemPrompts, features, requestMetadata).
    // Tool lastError strings are also stripped at basic level; only categorized error enums are kept.
    if (this.captureLevel === 'basic') {
      delete result.systemPrompts;
      delete result.features;
      delete result.requestMetadata;
      delete result.captureErrors;
      // Sanitize tools: keep operational metrics, strip raw error strings (GDPR data minimization)
      if (result.tools) {
        result.tools = result.tools.map(({ lastError: _raw, ...tool }) => tool);
      }
    }

    return result;
  }
}
