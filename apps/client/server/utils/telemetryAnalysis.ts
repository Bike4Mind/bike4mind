import { Quest, adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { z } from 'zod';
import {
  RecommendedActionSchema,
  getRecommendedAction,
  type ContextTelemetry,
  type HistoricalBaselines,
} from '@bike4mind/common';
import { getSettingsByNames } from '@bike4mind/utils';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { apiKeyService } from '@bike4mind/services';
import {
  formatFingerprintComment,
  formatSemanticFingerprintComment,
  formatPrimaryAnomaly,
} from '@server/services/telemetryFingerprint';
import { escapeMarkdown } from '@server/utils/markdownEscape';
import { type IssueForDedup } from '@server/services/issueDedup';
import { type Priority } from '@server/services/issueLabels';

// ─── Schemas & Types ────────────────────────────────────────────────────────

export const LLMAnalysisSchema = z.object({
  summary: z.string(),
  findings: z.array(z.string()),
  recommendations: z.array(z.string()),
  severity: z.string().optional(), // LLM may omit or return non-standard values; always overridden by system-calculated severity
  estimatedImpact: z.string(),
  rootCause: z.string().optional(),
  correlations: z.array(z.string()).optional(),
  recommendedAction: RecommendedActionSchema.optional(),
});

export type LLMAnalysis = z.infer<typeof LLMAnalysisSchema>;

export interface SloConfig {
  sloResponseTimeP95Ms: number;
  sloFirstTokenTimeMs: number;
  sloErrorRatePercent: number;
  sloContextUtilizationPercent: number;
}

export const DEFAULT_SLOS: SloConfig = {
  sloResponseTimeP95Ms: 60000,
  sloFirstTokenTimeMs: 5000,
  sloErrorRatePercent: 2,
  sloContextUtilizationPercent: 85,
};

export interface LLMConfig {
  modelId: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

// ─── Historical Baselines ───────────────────────────────────────────────────

/**
 * Compute historical baselines for same model/provider via MongoDB aggregation.
 * Returns null if insufficient data (< 30 samples).
 *
 * Uses two-pass pipeline to avoid unbounded $push:
 * 1. Sort + limit to bound memory (max 10k docs)
 * 2. $group for averages/stddev, $sort + slice for P95
 */
export async function computeHistoricalBaselines(
  modelId: string,
  provider: string,
  windowDays: number
): Promise<HistoricalBaselines | null> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - windowDays);
  const MAX_SAMPLES = 10000;

  const baselineMatch = {
    $match: {
      'promptMeta.contextTelemetry.model.modelId': modelId,
      'promptMeta.contextTelemetry.model.provider': provider,
      timestamp: { $gte: cutoffDate },
    },
  };

  // First pass: compute count, averages, stddev (no $push)
  const statsPipeline = [
    baselineMatch,
    {
      $group: {
        _id: null,
        avgResponseTimeMs: { $avg: '$promptMeta.contextTelemetry.performance.totalResponseTimeMs' },
        avgUtilization: { $avg: '$promptMeta.contextTelemetry.contextWindow.utilizationPercentage' },
        stdDevUtilization: { $stdDevPop: '$promptMeta.contextTelemetry.contextWindow.utilizationPercentage' },
        sampleCount: { $sum: 1 },
      },
    },
  ];

  const statsResults = await Quest.aggregate(statsPipeline);

  if (!statsResults.length || statsResults[0].sampleCount < 30) {
    return null;
  }

  const { avgResponseTimeMs, avgUtilization, stdDevUtilization, sampleCount } = statsResults[0];

  // Second pass: sorted + bounded for P95 (no unbounded $push)
  const p95Pipeline = [
    baselineMatch,
    { $sort: { 'promptMeta.contextTelemetry.performance.totalResponseTimeMs': 1 as const } },
    { $limit: MAX_SAMPLES },
    {
      $group: {
        _id: null,
        sortedResponseTimes: { $push: '$promptMeta.contextTelemetry.performance.totalResponseTimeMs' },
      },
    },
  ];

  const p95Results = await Quest.aggregate(p95Pipeline);
  const sortedTimes: number[] = p95Results[0]?.sortedResponseTimes ?? [];
  const p95Index = Math.ceil(sortedTimes.length * 0.95) - 1;
  const p95ResponseTimeMs = sortedTimes[Math.min(Math.max(p95Index, 0), sortedTimes.length - 1)] ?? avgResponseTimeMs;

  return {
    avgResponseTimeMs: Math.round(avgResponseTimeMs),
    p95ResponseTimeMs: Math.round(p95ResponseTimeMs),
    avgUtilization: Math.round(avgUtilization * 10) / 10,
    utilizationRange: {
      low: Math.max(0, Math.round((avgUtilization - stdDevUtilization) * 10) / 10),
      high: Math.min(100, Math.round((avgUtilization + stdDevUtilization) * 10) / 10),
    },
    sampleCount,
    windowDays,
  };
}

// ─── Rule-Based Analysis ────────────────────────────────────────────────────

/**
 * Generate rule-based analysis of telemetry anomalies (fallback when no LLM configured)
 */
export function generateRuleBasedAnalysis(
  telemetry: ContextTelemetry,
  slos: SloConfig = DEFAULT_SLOS,
  baselines: HistoricalBaselines | null = null
): LLMAnalysis {
  const findings: string[] = [];
  const recommendations: string[] = [];
  const { anomalies, contextWindow, performance, model, tools, subagents } = telemetry;

  // Analyze context window issues
  if (anomalies.contextOverflow) {
    findings.push(
      `Context overflow detected: ${contextWindow.overflowAmount?.toLocaleString() ?? 'unknown'} tokens exceeded the ${contextWindow.contextWindowLimit.toLocaleString()} token limit`
    );
    recommendations.push('Consider implementing more aggressive message truncation or summarization');
    recommendations.push('Review attached files for large or unnecessary content');
  }

  if (anomalies.criticalUtilization) {
    findings.push(
      `Critical context utilization at ${contextWindow.utilizationPercentage.toFixed(1)}% - very close to overflow`
    );
    recommendations.push('Implement proactive context management before reaching critical levels');
  } else if (anomalies.highUtilization) {
    findings.push(`High context utilization at ${contextWindow.utilizationPercentage.toFixed(1)}%`);
    recommendations.push('Monitor context growth patterns and consider early truncation');
  }

  // Analyze token breakdown (enhanced-only field)
  const { tokensBySource } = contextWindow;
  const totalTokens = contextWindow.inputTokens;

  if (tokensBySource && tokensBySource.conversationHistory / totalTokens > 0.5) {
    findings.push(
      `Conversation history consuming ${((tokensBySource.conversationHistory / totalTokens) * 100).toFixed(0)}% of context`
    );
    recommendations.push('Consider implementing conversation summarization for long sessions');
  }

  if (tokensBySource && tokensBySource.fabFiles / totalTokens > 0.3) {
    findings.push(`Attached files consuming ${((tokensBySource.fabFiles / totalTokens) * 100).toFixed(0)}% of context`);
    recommendations.push('Review file attachment strategy - consider selective content extraction');
  }

  // Analyze performance issues (SLO-aware)
  if (anomalies.slowTotalResponse) {
    const responseTimeSec = (performance.totalResponseTimeMs / 1000).toFixed(1);
    const sloSec = (slos.sloResponseTimeP95Ms / 1000).toFixed(0);
    const exceedsSlo = performance.totalResponseTimeMs > slos.sloResponseTimeP95Ms;
    findings.push(
      `Slow total response time: ${responseTimeSec}s${exceedsSlo ? ` (exceeds ${sloSec}s SLO)` : ` (within ${sloSec}s SLO but >60s threshold)`}`
    );
    recommendations.push('Investigate potential bottlenecks in tool execution or context retrieval');
  }

  if (anomalies.slowFirstToken) {
    const ttftSec = ((performance.firstTokenTimeMs ?? 0) / 1000).toFixed(1);
    const sloSec = (slos.sloFirstTokenTimeMs / 1000).toFixed(1);
    findings.push(`Slow time to first token: ${ttftSec}s (SLO target: ${sloSec}s)`);
    recommendations.push('Check for issues with model availability or API rate limiting');
  }

  // SLO-aware utilization check (don't flag if within SLO)
  if (!anomalies.highUtilization && contextWindow.utilizationPercentage > slos.sloContextUtilizationPercent) {
    findings.push(
      `Context utilization at ${contextWindow.utilizationPercentage.toFixed(1)}% exceeds ${slos.sloContextUtilizationPercent}% SLO target`
    );
    recommendations.push('Review context management to stay within SLO target');
  }

  // Historical baseline comparisons
  if (baselines && baselines.avgResponseTimeMs > 0) {
    const responseTimePctDiff =
      ((performance.totalResponseTimeMs - baselines.avgResponseTimeMs) / baselines.avgResponseTimeMs) * 100;
    if (responseTimePctDiff > 50) {
      findings.push(
        `Response time ${Math.round(responseTimePctDiff)}% above ${baselines.windowDays}-day average (${(baselines.avgResponseTimeMs / 1000).toFixed(1)}s avg, N=${baselines.sampleCount})`
      );
    } else if (responseTimePctDiff < -30) {
      findings.push(
        `Response time ${Math.abs(Math.round(responseTimePctDiff))}% below ${baselines.windowDays}-day average — faster than typical`
      );
    }

    if (
      contextWindow.utilizationPercentage > baselines.utilizationRange.high ||
      contextWindow.utilizationPercentage < baselines.utilizationRange.low
    ) {
      findings.push(
        `Context utilization ${contextWindow.utilizationPercentage.toFixed(1)}% outside normal range (${baselines.utilizationRange.low}%-${baselines.utilizationRange.high}%, mean ± 1σ)`
      );
    }
  }

  // Analyze tool failures
  if (anomalies.toolFailureSpike && tools) {
    const failedTools = tools.filter(t => t.failureCount > 0);
    const totalFailures = failedTools.reduce((sum, t) => sum + t.failureCount, 0);
    findings.push(`Tool failure spike: ${totalFailures} failures across ${failedTools.length} tools`);

    for (const tool of failedTools.slice(0, 3)) {
      const safeName = escapeMarkdown(tool.toolName);
      if (tool.lastError) {
        findings.push(`  - ${safeName}: "${escapeMarkdown(tool.lastError.slice(0, 200))}"`);
      } else if (tool.errorCategories?.length) {
        findings.push(`  - ${safeName}: error type(s): ${tool.errorCategories.map(c => escapeMarkdown(c)).join(', ')}`);
      }
    }

    recommendations.push('Review tool error logs and implement retry logic or fallbacks');
    recommendations.push('Consider adding circuit breakers for frequently failing tools');
  }

  if (anomalies.toolTimeout && tools) {
    const slowTools = tools.filter(t => t.maxDurationMs > 30000);
    findings.push(`Tool timeout detected: ${slowTools.length} tools exceeded 30s`);
    recommendations.push('Add timeout limits to long-running tool operations');
  }

  // Analyze subagent issues
  if (anomalies.subagentTimeout && subagents) {
    const timedOutAgents = subagents.filter(s => s.timeoutCount > 0);
    findings.push(`Subagent timeout: ${timedOutAgents.length} agents timed out`);

    for (const agent of timedOutAgents) {
      findings.push(
        `  - ${escapeMarkdown(agent.agentName)}: ${agent.timeoutCount} timeouts, ${(agent.totalDurationMs / 60000).toFixed(1)}min total`
      );
    }

    recommendations.push('Review subagent task complexity and consider breaking into smaller tasks');
    recommendations.push('Implement progressive timeout increases with backoff');
  }

  // Analyze model fallback
  if (model.fallbackUsed) {
    findings.push(`Model fallback triggered: ${model.originalModelId ?? 'unknown'} → ${model.modelId}`);
    findings.push(`Fallback reason: ${model.fallbackReason ?? 'unknown'}`);
    recommendations.push('Monitor fallback frequency and investigate root cause');
  }

  // Determine severity and impact
  let severity: 'critical' | 'high' | 'medium' | 'low';
  let estimatedImpact: string;

  if (anomalies.anomalyScore >= 70) {
    severity = 'critical';
    estimatedImpact = 'High user impact - likely degraded or failed experience';
  } else if (anomalies.anomalyScore >= 50) {
    severity = 'high';
    estimatedImpact = 'Moderate user impact - noticeable degradation in response quality or speed';
  } else if (anomalies.anomalyScore >= 30) {
    severity = 'medium';
    estimatedImpact = 'Low user impact - may affect edge cases or specific use patterns';
  } else {
    severity = 'low';
    estimatedImpact = 'Minimal user impact - within acceptable operational parameters';
  }

  // Generate summary
  const summary =
    findings.length > 0
      ? `Detected ${findings.length} issue(s) with anomaly score ${anomalies.anomalyScore}/100. Primary concern: ${anomalies.primaryAnomaly.replace('_', ' ')}.`
      : 'No significant anomalies detected. System operating within normal parameters.';

  return {
    summary,
    findings: findings.length > 0 ? findings : ['No significant anomalies detected'],
    recommendations: recommendations.length > 0 ? recommendations : ['Continue monitoring for pattern changes'],
    severity,
    estimatedImpact,
    recommendedAction: getRecommendedAction(anomalies.anomalyScore),
  };
}

// ─── LLM Analysis Prompt ────────────────────────────────────────────────────

/**
 * Build a prompt for LLM analysis of telemetry data.
 * When slos/baselines are provided, includes SLO context and historical comparisons.
 */
export function buildAnalysisPrompt(
  telemetry: ContextTelemetry,
  slos: SloConfig = DEFAULT_SLOS,
  baselines: HistoricalBaselines | null = null
): string {
  const { anomalies, contextWindow, performance, model, tools, subagents } = telemetry;

  return `You are an expert AI operations analyst. Analyze the following context telemetry data from an LLM completion and provide actionable insights.

## Telemetry Data

### Model Information
- Model: ${model.modelId}
- Provider: ${model.provider}
- Fallback Used: ${model.fallbackUsed ? `Yes (from ${model.originalModelId ?? 'unknown'}, reason: ${model.fallbackReason ?? 'unknown'})` : 'No'}

### Anomaly Detection
- Anomaly Score: ${anomalies.anomalyScore}/100
- Severity: ${anomalies.severity}
- Primary Anomaly: ${anomalies.primaryAnomaly}
- Context Overflow: ${anomalies.contextOverflow}
- High Utilization: ${anomalies.highUtilization} (Critical: ${anomalies.criticalUtilization})
- High Truncation: ${anomalies.highTruncation} (Critical: ${anomalies.criticalTruncation})
- Tool Failure Spike: ${anomalies.toolFailureSpike}
- Tool Timeout: ${anomalies.toolTimeout}
- Subagent Timeout: ${anomalies.subagentTimeout}
- Slow Response: ${anomalies.slowTotalResponse}
- Slow First Token: ${anomalies.slowFirstToken}

### Context Window
- Input Tokens: ${contextWindow.inputTokens.toLocaleString()}
- Context Limit: ${contextWindow.contextWindowLimit.toLocaleString()}
- Utilization: ${contextWindow.utilizationPercentage.toFixed(1)}%
- Overflow Detected: ${contextWindow.overflowDetected}${contextWindow.overflowAmount ? ` (${contextWindow.overflowAmount.toLocaleString()} tokens)` : ''}

### Token Distribution
${
  contextWindow.tokensBySource
    ? `- System Prompts: ${contextWindow.tokensBySource.systemPrompts.toLocaleString()} (${((contextWindow.tokensBySource.systemPrompts / contextWindow.inputTokens) * 100).toFixed(1)}%)
- Conversation History: ${contextWindow.tokensBySource.conversationHistory.toLocaleString()} (${((contextWindow.tokensBySource.conversationHistory / contextWindow.inputTokens) * 100).toFixed(1)}%)
- Mementos: ${contextWindow.tokensBySource.mementos.toLocaleString()} (${((contextWindow.tokensBySource.mementos / contextWindow.inputTokens) * 100).toFixed(1)}%)
- Attached Files: ${contextWindow.tokensBySource.fabFiles.toLocaleString()} (${((contextWindow.tokensBySource.fabFiles / contextWindow.inputTokens) * 100).toFixed(1)}%)
- URL Content: ${contextWindow.tokensBySource.urlContent.toLocaleString()} (${((contextWindow.tokensBySource.urlContent / contextWindow.inputTokens) * 100).toFixed(1)}%)
- Tool Schemas: ${contextWindow.tokensBySource.toolSchemas.toLocaleString()} (${((contextWindow.tokensBySource.toolSchemas / contextWindow.inputTokens) * 100).toFixed(1)}%)
- User Prompt: ${contextWindow.tokensBySource.userPrompt.toLocaleString()} (${((contextWindow.tokensBySource.userPrompt / contextWindow.inputTokens) * 100).toFixed(1)}%)`
    : '_(Basic telemetry — token breakdown not available)_'
}

### Performance
- Total Response Time: ${(performance.totalResponseTimeMs / 1000).toFixed(2)}s
- Time to First Token: ${performance.firstTokenTimeMs ? `${(performance.firstTokenTimeMs / 1000).toFixed(2)}s` : 'N/A'}

${
  tools && tools.length > 0
    ? `### Tool Usage
[TOOL_DATA]
${tools
  .map(t => {
    // Truncate and escape error messages to prevent prompt injection
    const safeError = t.lastError
      ? ` (error: \`${t.lastError.slice(0, 100).replace(/[`$]/g, '')}${t.lastError.length > 100 ? '...' : ''}\`)`
      : '';
    const errorCats =
      !safeError && t.errorCategories?.length
        ? ` (error types: ${t.errorCategories.map(c => c.slice(0, 50)).join(', ')})`
        : '';
    // Surface content truncation (web_fetch, issue #452) so a silent partial-read
    // regression is visible in the ops rollup, not just the raw call counts.
    const truncInfo =
      t.truncatedInvocationCount && t.truncatedInvocationCount > 0
        ? ` (truncated ${t.truncatedInvocationCount}/${t.invocationCount}, max ${(t.maxExtractedChars ?? 0).toLocaleString()} chars)`
        : '';
    return `- ${t.toolName.slice(0, 100)}: ${t.invocationCount} calls, ${t.failureCount} failures, max ${(t.maxDurationMs / 1000).toFixed(1)}s${safeError}${errorCats}${truncInfo}`;
  })
  .join('\n')}
[/TOOL_DATA]`
    : ''
}

${
  subagents && subagents.length > 0
    ? `### Subagent Activity
[SUBAGENT_DATA]
${subagents.map(s => `- ${s.agentName.slice(0, 100)}: ${s.delegationCount} delegations, ${s.timeoutCount} timeouts, ${(s.totalDurationMs / 1000).toFixed(1)}s total`).join('\n')}
[/SUBAGENT_DATA]`
    : ''
}

## SLO Context
- Response Time P95 Target: ${(slos.sloResponseTimeP95Ms / 1000).toFixed(0)}s | This entry: ${(performance.totalResponseTimeMs / 1000).toFixed(2)}s
- First Token Time Target: ${(slos.sloFirstTokenTimeMs / 1000).toFixed(1)}s | This entry: ${performance.firstTokenTimeMs ? `${(performance.firstTokenTimeMs / 1000).toFixed(2)}s` : 'N/A'}
- Error Rate Target: ${slos.sloErrorRatePercent}%
- Context Utilization Target: ${slos.sloContextUtilizationPercent}% | This entry: ${contextWindow.utilizationPercentage.toFixed(1)}%

${
  baselines
    ? `## Historical Baselines (${baselines.windowDays}-day, same model/provider, N=${baselines.sampleCount})
- Avg Response Time: ${(baselines.avgResponseTimeMs / 1000).toFixed(1)}s | This entry: ${(performance.totalResponseTimeMs / 1000).toFixed(2)}s
- P95 Response Time: ${(baselines.p95ResponseTimeMs / 1000).toFixed(1)}s
- Normal Utilization: ${baselines.utilizationRange.low}% - ${baselines.utilizationRange.high}% (mean ± 1σ)

`
    : ''
}
## Interpretation Guide

The system has already calculated the anomaly score and severity:
- **Anomaly Score: ${anomalies.anomalyScore}/100**
- **Severity: ${anomalies.severity}**
- **Primary Anomaly: ${anomalies.primaryAnomaly}**

${anomalies.primaryAnomaly === 'none' ? '**This is a HEALTHY completion with no anomalies. Your analysis should confirm normal operation.**\n' : ''}
### Language Calibration (MANDATORY)

Your tone MUST match the severity level:

**Score 0-19 (low):** Report observations only. Use measured, factual language.
- DO NOT use words like "critical", "concerning", "alarming", "urgent", "immediately"
- Focus on: "normal operation", "within expected parameters", "no issues detected"
- Example: "Completion executed normally. System prompts used 1,845 tokens, typical for agentic workflows."

**Score 20-29 (medium):** Note minor observations worth awareness.
- Example: "Minor observation: first token latency of 8.5s is slightly elevated but within acceptable range."

**Score 30-49 (high):** Highlight issues requiring attention, but not alarmist.
- Example: "High utilization at 88% warrants monitoring. Consider reviewing token distribution."

**Score 50+ (critical):** Use direct, urgent language. Action is warranted.
- Example: "Critical: Context overflow caused 12,450 tokens to exceed limit, likely degrading response."

### System Context (Important)

These are NORMAL for this system - do NOT flag as problems:
- System prompts consuming 1000-2000 tokens (expected in agentic AI systems)
- Short user queries of 10-100 tokens (normal for simple questions)
- Response times vary by model (GPT-5 may have 30s response times)
- Zero mementos/conversation history (normal for new sessions or simple queries)
- No tool usage (not all completions require tools)

### Analysis Instructions

${
  anomalies.primaryAnomaly === 'none'
    ? `Since this is a HEALTHY completion with no anomalies (primaryAnomaly: none):
1. Provide a brief summary confirming normal operation
2. Include 0-1 observations (not "concerns")
3. Recommendation should be "No action needed" or "Continue monitoring"
4. Do NOT invent problems where none exist`
    : `Provide:
1. A concise summary matching the ${anomalies.severity} severity tone
2. Specific findings (only for flagged anomalies, not normal metrics)
3. Actionable recommendations
4. Root cause analysis if anomalies are present`
}

### Example Outputs

**Healthy (primaryAnomaly: none):**
{
  "summary": "Healthy completion with no anomalies. System operating within normal parameters.",
  "findings": ["No anomalies detected"],
  "recommendations": ["No action needed"],
  "estimatedImpact": "No user impact",
  "rootCause": null,
  "correlations": []
}

**Critical (score 55+):**
{
  "summary": "Critical: Context overflow with 12,450 tokens exceeding limit. Tool failures also observed.",
  "findings": ["Context overflow: 12,450 tokens over limit", "3 tool failures in delegate-to-agent"],
  "recommendations": ["Implement aggressive message truncation", "Review attached files"],
  "estimatedImpact": "High - user likely experienced degraded response",
  "rootCause": "Accumulated history combined with large attachments exceeded limits",
  "correlations": ["Overflow likely caused tool failures"]
}

Respond in JSON format with this exact structure:
{
  "summary": "Brief overview matching severity tone",
  "findings": ["Finding based on actual flagged anomalies"],
  "recommendations": ["${anomalies.primaryAnomaly === 'none' ? 'No action needed' : 'Specific recommendation'}"],
  "estimatedImpact": "${anomalies.primaryAnomaly === 'none' ? 'No user impact - normal operation' : 'Description of impact'}",
  "rootCause": "Only if anomalies are flagged, otherwise null",
  "correlations": []
}`;
}

// ─── LLM Analysis ───────────────────────────────────────────────────────────

/**
 * Generate LLM-powered analysis of telemetry data.
 * Unified implementation used by both the analyze API and the auto-alert handler.
 *
 * @throws on failure (caller decides whether to fall back to rule-based)
 */
export async function generateLLMAnalysis(
  telemetry: ContextTelemetry,
  config: LLMConfig,
  logger: Logger,
  slos: SloConfig = DEFAULT_SLOS,
  baselines: HistoricalBaselines | null = null
): Promise<LLMAnalysis> {
  const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys('system', {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  });

  const availableModels = await getAvailableModels(apiKeyTable);
  const modelInfo = availableModels.find(m => m.id === config.modelId);

  if (!modelInfo) {
    throw new Error(`Configured model ${config.modelId} is not available. Check API key configuration.`);
  }

  const llm = getLlmByModel(apiKeyTable, { modelInfo, logger });

  if (!llm) {
    throw new Error(`Failed to create LLM backend for model ${config.modelId}`);
  }

  const prompt = buildAnalysisPrompt(telemetry, slos, baselines);
  const messages = [{ role: 'user' as const, content: prompt }];

  const llmOptions = {
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    stream: false,
    thinking: { enabled: false, budget_tokens: 0 },
  };

  let responseText = '';
  const MAX_RESPONSE_SIZE = 50000; // 50KB limit

  // Call LLM with timeout.
  // Note: Promise.race rejects on timeout but llm.complete() keeps running.
  // Acceptable in Lambda (runtime tears down), but leaks on long-lived Next.js server.
  // TODO: Add AbortController support when llm.complete() accepts a signal.
  await Promise.race([
    llm.complete(config.modelId, messages, llmOptions, async texts => {
      if (texts && texts.length > 0) {
        const chunk = texts.join('');
        if (responseText.length + chunk.length > MAX_RESPONSE_SIZE) {
          throw new Error('LLM response exceeded maximum size limit');
        }
        responseText += chunk;
      }
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`LLM call timed out after ${config.timeoutMs}ms`)), config.timeoutMs)
    ),
  ]);

  if (!responseText.trim()) {
    throw new Error('LLM returned empty response');
  }

  logger.debug(`[ContextTelemetry] Raw LLM response (${responseText.length} chars): ${responseText.slice(0, 500)}`);

  // Extract JSON from response (handle markdown code blocks)
  let jsonStr = responseText.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  // Fallback: extract bare JSON object if no code block found
  if (!jsonMatch) {
    const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      jsonStr = braceMatch[0];
    }
  }

  const parsed = JSON.parse(jsonStr);
  const validated = LLMAnalysisSchema.safeParse(parsed);

  if (!validated.success) {
    logger.warn('[ContextTelemetry] LLM response validation failed:', validated.error);
    throw new Error('LLM response did not match expected schema');
  }

  return validated.data;
}

// ─── Analysis Source Type ────────────────────────────────────────────────────

/** Source tag for analysis - indicates how and from which flow the analysis was generated. */
export type AnalysisSource = 'auto-llm' | 'auto-rule-based' | 'manual-llm' | 'manual-rule-based' | 'llm' | 'rule-based';

// ─── Issue Body Formatting ──────────────────────────────────────────────────

/**
 * Sanitize user-provided content for safe inclusion in GitHub issues.
 * Prevents markdown injection attacks by escaping potentially dangerous patterns.
 */
function sanitizeMarkdown(content: string): string {
  return content
    .slice(0, 5000)
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '\\[$1\\]\\($2\\)')
    .replace(/(https?:\/\/[^\s]+)/g, '`$1`');
}

export interface IssueBodyOptions {
  /** AI/rule-based analysis to include. Omit to generate raw-metrics-only body. */
  analysis?: LLMAnalysis | null;
  /** Source tag shown in the issue body so readers know how analysis was generated. */
  analysisSource?: AnalysisSource;
  /** Deterministic fingerprint for dedup (embedded as HTML comment). */
  fingerprint?: string;
  /** Semantic fingerprint for fuzzy dedup (embedded as HTML comment). */
  semanticFingerprint?: string;
  /** Priority label (P0-P3). */
  priority?: Priority;
  /** Whether this is a regression of a previously closed issue. */
  isRegression?: boolean;
  /** The closed issue this is a regression of. */
  matchedClosedIssue?: IssueForDedup;
  /** Include per-source token breakdown table. Default true. */
  includeTokenBreakdown?: boolean;
  /** Include tool failure and subagent timeout tables. Default true. */
  includeToolDetails?: boolean;
  /** User-provided additional context (will be sanitized). */
  additionalContext?: string;
}

/**
 * Unified formatter for telemetry GitHub issue bodies.
 * Used by both auto-alert handler and manual create-issue API.
 */
export function formatIssueBody(telemetry: ContextTelemetry, options: IssueBodyOptions = {}): string {
  const {
    analysis,
    analysisSource,
    fingerprint,
    semanticFingerprint,
    priority,
    isRegression = false,
    matchedClosedIssue,
    includeTokenBreakdown = true,
    includeToolDetails = true,
    additionalContext,
  } = options;

  const { anomalies, contextWindow, performance, model, tools, subagents } = telemetry;

  const safeModelId = escapeMarkdown(model.modelId);
  const safeProvider = escapeMarkdown(model.provider);
  const safeOriginalModelId = escapeMarkdown(model.originalModelId ?? 'unknown');
  const safeFallbackReason = escapeMarkdown(model.fallbackReason ?? 'unknown');
  const safePrimaryAnomaly = escapeMarkdown(formatPrimaryAnomaly(anomalies.primaryAnomaly));
  const safeSeverity = escapeMarkdown(anomalies.severity);

  const sections: string[] = [];

  // Fingerprints (hidden in HTML comments for deduplication)
  if (fingerprint) {
    sections.push(formatFingerprintComment(fingerprint));
  }
  if (semanticFingerprint) {
    sections.push(formatSemanticFingerprintComment(semanticFingerprint));
  }
  if (fingerprint || semanticFingerprint) {
    sections.push('');
  }

  // Header
  sections.push(`## Context Telemetry ${isRegression || fingerprint ? 'Alert' : 'Anomaly Report'}`);
  sections.push('');

  // Regression notice
  if (isRegression && matchedClosedIssue) {
    sections.push(
      `> \u{1F6A8} **REGRESSION**: This issue was previously fixed and closed as #${matchedClosedIssue.number}.`
    );
    sections.push(`> The same anomaly pattern has reoccurred.`);
    sections.push('');
  }

  // Summary line (with priority if available)
  if (priority) {
    sections.push(`> Auto-generated issue for anomaly score ${anomalies.anomalyScore}/100 (priority: ${priority}).`);
    sections.push('');
  }

  // Key metrics
  sections.push(`**Severity:** ${safeSeverity.toUpperCase()}`);
  if (priority) {
    sections.push(`**Priority:** ${priority}`);
  }
  sections.push(`**Anomaly Score:** ${anomalies.anomalyScore}/100`);
  sections.push(`**Primary Anomaly:** ${safePrimaryAnomaly}`);
  sections.push(`**Timestamp:** ${telemetry.timestamp}`);
  sections.push('');

  // AI Analysis Section (if available)
  if (analysis) {
    sections.push(`## AI Analysis`);
    if (analysisSource) {
      sections.push(`> _Analysis source: ${analysisSource}_`);
    }
    sections.push('');
    sections.push(`### Summary`);
    sections.push(analysis.summary);
    sections.push('');

    if (analysis.rootCause) {
      sections.push(`### Root Cause`);
      sections.push(analysis.rootCause);
      sections.push('');
    }

    sections.push(`### Findings`);
    for (const finding of analysis.findings) {
      sections.push(`- ${finding}`);
    }
    sections.push('');

    sections.push(`### Recommendations`);
    for (const rec of analysis.recommendations) {
      sections.push(`- ${rec}`);
    }
    sections.push('');

    if (analysis.correlations && analysis.correlations.length > 0) {
      sections.push(`### Correlations`);
      for (const corr of analysis.correlations) {
        sections.push(`- ${corr}`);
      }
      sections.push('');
    }

    sections.push(`**Estimated Impact:** ${analysis.estimatedImpact}`);
    sections.push('');
    sections.push('---');
    sections.push('');
  }

  // Technical Details
  sections.push(`## Technical Details`);
  sections.push('');

  // Model Info
  sections.push(`### Model Information`);
  sections.push(`- **Model:** ${safeModelId}`);
  sections.push(`- **Provider:** ${safeProvider}`);
  if (model.fallbackUsed) {
    sections.push(`- **Fallback:** Yes (from ${safeOriginalModelId})`);
    sections.push(`- **Fallback Reason:** ${safeFallbackReason}`);
  }
  sections.push('');

  // Context Window Stats
  sections.push(`### Context Window`);
  sections.push(`- **Input Tokens:** ${contextWindow.inputTokens.toLocaleString()}`);
  sections.push(`- **Utilization:** ${contextWindow.utilizationPercentage.toFixed(1)}%`);
  sections.push(`- **Context Limit:** ${contextWindow.contextWindowLimit.toLocaleString()}`);
  if (contextWindow.overflowDetected) {
    sections.push(`- **Overflow:** ${contextWindow.overflowAmount?.toLocaleString() ?? 'unknown'} tokens`);
  }
  sections.push('');

  // Token Breakdown
  if (includeTokenBreakdown) {
    sections.push(`### Token Distribution`);
    const { tokensBySource } = contextWindow;
    if (tokensBySource) {
      sections.push(`| Source | Tokens | % |`);
      sections.push(`|--------|--------|---|`);
      const total = contextWindow.inputTokens;
      const sources = [
        { name: 'System Prompts', value: tokensBySource.systemPrompts },
        { name: 'Conversation History', value: tokensBySource.conversationHistory },
        { name: 'Mementos', value: tokensBySource.mementos },
        { name: 'Files', value: tokensBySource.fabFiles },
        { name: 'URL Content', value: tokensBySource.urlContent },
        { name: 'Tool Schemas', value: tokensBySource.toolSchemas },
        { name: 'User Prompt', value: tokensBySource.userPrompt },
      ];
      for (const source of sources) {
        if (source.value > 0) {
          sections.push(
            `| ${source.name} | ${source.value.toLocaleString()} | ${((source.value / total) * 100).toFixed(1)}% |`
          );
        }
      }
    } else {
      sections.push('_(Basic telemetry — token breakdown not available)_');
    }
    sections.push('');
  }

  // Performance
  sections.push(`### Performance`);
  sections.push(`- **Total Response Time:** ${(performance.totalResponseTimeMs / 1000).toFixed(2)}s`);
  if (performance.firstTokenTimeMs) {
    sections.push(`- **Time to First Token:** ${(performance.firstTokenTimeMs / 1000).toFixed(2)}s`);
  }
  sections.push('');

  // Detected Anomalies
  sections.push(`### Detected Anomalies`);
  const detectedAnomalies: string[] = [];
  if (anomalies.contextOverflow) detectedAnomalies.push('Context Overflow');
  if (anomalies.criticalUtilization) detectedAnomalies.push('Critical Utilization (≥95%)');
  else if (anomalies.highUtilization) detectedAnomalies.push('High Utilization (≥90%)');
  if (anomalies.criticalTruncation) detectedAnomalies.push('Critical Truncation (≥75%)');
  else if (anomalies.highTruncation) detectedAnomalies.push('High Truncation (≥50%)');
  if (anomalies.toolFailureSpike) detectedAnomalies.push('Tool Failure Spike');
  if (anomalies.toolTimeout) detectedAnomalies.push('Tool Timeout (>30s)');
  if (anomalies.subagentTimeout) detectedAnomalies.push('Subagent Timeout (>5min)');
  if (anomalies.slowTotalResponse) detectedAnomalies.push('Slow Total Response (>60s)');
  if (anomalies.slowFirstToken) detectedAnomalies.push('Slow First Token (>10s)');

  if (detectedAnomalies.length > 0) {
    for (const anomaly of detectedAnomalies) {
      sections.push(`- ${anomaly}`);
    }
  } else {
    sections.push('No specific anomalies flagged.');
  }
  sections.push('');

  // Tool Details
  if (includeToolDetails && tools && tools.some(t => t.failureCount > 0)) {
    sections.push(`### Tool Failures`);
    sections.push(`| Tool | Invocations | Failures | Error Info |`);
    sections.push(`|------|-------------|----------|------------|`);
    for (const tool of tools.filter(t => t.failureCount > 0).slice(0, 10)) {
      const rawError = tool.lastError ?? (tool.errorCategories?.length ? tool.errorCategories.join(', ') : '-');
      const safeError = escapeMarkdown(rawError.slice(0, 200));
      sections.push(
        `| ${escapeMarkdown(tool.toolName)} | ${tool.invocationCount} | ${tool.failureCount} | ${safeError} |`
      );
    }
    sections.push('');
  }

  // Subagent Details
  if (includeToolDetails && subagents && subagents.some(s => s.timeoutCount > 0)) {
    sections.push(`### Subagent Timeouts`);
    sections.push(`| Agent | Delegations | Timeouts | Duration |`);
    sections.push(`|-------|-------------|----------|----------|`);
    for (const agent of subagents.filter(s => s.timeoutCount > 0)) {
      sections.push(
        `| ${escapeMarkdown(agent.agentName)} | ${agent.delegationCount} | ${agent.timeoutCount} | ${(agent.totalDurationMs / 1000).toFixed(1)}s |`
      );
    }
    sections.push('');
  }

  // Additional Context (sanitized)
  if (additionalContext) {
    sections.push(`### Additional Context`);
    sections.push(sanitizeMarkdown(additionalContext));
    sections.push('');
  }

  // Footer
  sections.push('---');
  const sourceLabel = analysis ? (analysisSource ? ` with AI Analysis (${analysisSource})` : ' with AI Analysis') : '';
  sections.push(`*Auto-generated by Context Telemetry${sourceLabel}*`);
  if (anomalies.dedupKey) {
    sections.push(`*Dedup Key: \`${anomalies.dedupKey}\`*`);
  }

  return sections.join('\n');
}
