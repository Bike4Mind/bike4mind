// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { ContextTelemetry, AnomaliesTelemetry } from '@bike4mind/common';
import { buildAnalysisPrompt, formatIssueBody, type LLMAnalysis } from './telemetryAnalysis';

function createTestTelemetry(overrides: { anomalies?: Partial<AnomaliesTelemetry> } = {}): ContextTelemetry {
  const defaultAnomalies: AnomaliesTelemetry = {
    contextOverflow: false,
    highUtilization: false,
    criticalUtilization: false,
    highTruncation: false,
    criticalTruncation: false,
    toolFailureSpike: false,
    toolTimeout: false,
    subagentTimeout: false,
    slowFirstToken: false,
    slowTotalResponse: false,
    anomalyScore: 30,
    severity: 'medium',
    dedupKey: 'test-key',
    primaryAnomaly: 'slow_response',
  };

  return {
    schemaVersion: '1.0',
    timestamp: new Date().toISOString(),
    captureOverheadMs: 10,
    anonymousSessionId: { hash: 'test-hash', dateKey: '2025-01-01' },
    operation: { name: 'chat_completion' },
    model: {
      modelId: 'claude-3-5-sonnet-20241022',
      provider: 'anthropic',
      fallbackUsed: false,
      usedThinking: false,
      usedTools: false,
    },
    contextWindow: {
      inputTokens: 1000,
      outputTokens: 500,
      contextWindowLimit: 200000,
      utilizationPercentage: 0.5,
      reservedOutputTokens: 8000,
      overflowDetected: false,
      tokensBySource: {
        systemPrompts: 100,
        conversationHistory: 400,
        mementos: 100,
        fabFiles: 100,
        urlContent: 100,
        toolSchemas: 100,
        userPrompt: 100,
      },
    },
    costs: {
      inputCostUsd: 0.01,
      outputCostUsd: 0.02,
      totalCostUsd: 0.03,
      creditsUsed: 1,
    },
    performance: {
      totalResponseTimeMs: 5000,
    },
    anomalies: { ...defaultAnomalies, ...overrides.anomalies },
    tools: [],
    subagents: [],
  };
}

describe('formatIssueBody', () => {
  it('escapes LLM analysis text written into the issue body', () => {
    const telemetry = createTestTelemetry();
    const analysis: LLMAnalysis = {
      summary: 'see [x](https://example.invalid) and @org/team <img>',
      rootCause: 'caused by `unstable_fn` and *retries*',
      findings: ['finding with <img src=x> and @someone'],
      recommendations: ['recommend [click](https://example.invalid)'],
      correlations: ['correlated with @another/team'],
      estimatedImpact: 'impact is *severe* with `code`',
    };

    const body = formatIssueBody(telemetry, { analysis });
    const zwsp = '\u200B';

    // Escaped forms are present.
    expect(body).toContain('\\[x\\](https://example.invalid)');
    expect(body).toContain('&lt;img&gt;');
    expect(body).toContain(`@${zwsp}org/team`);
    expect(body).toContain('\\`unstable\\_fn\\`');
    expect(body).toContain('\\*retries\\*');
    expect(body).toContain('&lt;img src=x&gt;');
    expect(body).toContain(`@${zwsp}someone`);
    expect(body).toContain('\\[click\\](https://example.invalid)');
    expect(body).toContain(`@${zwsp}another/team`);
    expect(body).toContain('\\*severe\\*');
    expect(body).toContain('\\`code\\`');

    // Raw, unescaped active markdown must not survive.
    expect(body).not.toContain('[x](');
    expect(body).not.toContain('<img>');
    expect(body).not.toContain('<img src=x>');
    expect(body).not.toContain('[click](');
    expect(body).not.toContain('@org/team');
    expect(body).not.toContain('@someone');
    expect(body).not.toContain('@another/team');
  });

  it('omits the lake row for a turn that never recorded the bucket', () => {
    const body = formatIssueBody(createTestTelemetry(), { includeTokenBreakdown: true });

    expect(body).toContain('| System Prompts |');
    expect(body).not.toContain('Lake Retrieval');
  });

  it('reports a recorded lake volume as its own row', () => {
    const telemetry = createTestTelemetry();
    telemetry.contextWindow.tokensBySource!.lakeRetrieval = 250;

    const body = formatIssueBody(telemetry, { includeTokenBreakdown: true });

    expect(body).toContain('| Lake Retrieval | 250 | 25.0% |');
  });

  it('keeps the lake row for a measured zero, unlike buckets that are merely empty', () => {
    const telemetry = createTestTelemetry();
    telemetry.contextWindow.tokensBySource!.lakeRetrieval = 0;
    telemetry.contextWindow.tokensBySource!.urlContent = 0;

    const body = formatIssueBody(telemetry, { includeTokenBreakdown: true });

    expect(body).toContain('| Lake Retrieval | 0 | 0.0% |');
    expect(body).not.toContain('URL Content');
  });
});

describe('buildAnalysisPrompt token distribution', () => {
  it('leaves the lake line out when the bucket is unrecorded', () => {
    const prompt = buildAnalysisPrompt(createTestTelemetry());

    expect(prompt).toContain('- User Prompt: 100');
    expect(prompt).not.toContain('Lake Retrieval');
  });

  it('includes the lake line when the bucket was recorded, zero included', () => {
    const telemetry = createTestTelemetry();
    telemetry.contextWindow.tokensBySource!.lakeRetrieval = 0;

    const prompt = buildAnalysisPrompt(telemetry);

    expect(prompt).toContain('- Lake Retrieval: 0 (0.0%)');
  });
});
