// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { ContextTelemetry, AnomaliesTelemetry } from '@bike4mind/common';
import { formatIssueBody, type LLMAnalysis } from './telemetryAnalysis';

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
});
