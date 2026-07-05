/**
 * Telemetry Fingerprint Tests
 *
 * Tests for the telemetry fingerprinting module used for
 * GitHub issue deduplication and regression detection.
 */

import { describe, it, expect } from 'vitest';
import type { ContextTelemetry, AnomaliesTelemetry } from '@bike4mind/common';
import {
  generateTelemetryFingerprint,
  generateSemanticTelemetryFingerprint,
  normalizeModelId,
  buildAnomalyFlags,
  formatFingerprintComment,
  formatSemanticFingerprintComment,
  extractFingerprintFromBody,
  extractSemanticFingerprintFromBody,
  getSeverityEmoji,
  formatPrimaryAnomaly,
} from './telemetryFingerprint';

// Helper to create minimal valid ContextTelemetry for testing
function createTestTelemetry(overrides: {
  anomalies?: Partial<AnomaliesTelemetry>;
  model?: { modelId?: string; provider?: string };
}): ContextTelemetry {
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
      modelId: overrides.model?.modelId ?? 'claude-3-5-sonnet-20241022',
      provider: (overrides.model?.provider as 'anthropic') ?? 'anthropic',
      fallbackUsed: false,
      usedThinking: false,
      usedTools: false,
    },
    systemPrompts: { prompts: [], totalTokens: 0, duplicateCount: 0 },
    features: { contributions: [] },
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
    truncation: {
      wasTruncated: false,
      originalMessageCount: 10,
      finalMessageCount: 10,
      truncatedMessageCount: 0,
      truncationPercentage: 0,
    },
    performance: {
      totalResponseTimeMs: 5000,
    },
    anomalies: { ...defaultAnomalies, ...overrides.anomalies },
    requestMetadata: {
      queryComplexity: 'simple',
      historyMessageCount: 5,
      attachedFileCount: 0,
      mementoCount: 0,
      enabledFeatures: [],
    },
  };
}

describe('normalizeModelId', () => {
  it('should remove date-based versions (YYYYMMDD)', () => {
    expect(normalizeModelId('claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet');
  });

  it('should remove date-based versions (YYYY-MM-DD)', () => {
    expect(normalizeModelId('gpt-4o-2024-08-06')).toBe('gpt-4o');
  });

  it('should remove trailing version numbers', () => {
    expect(normalizeModelId('claude-3-sonnet-v2')).toBe('claude-3-sonnet');
  });

  it('should lowercase model IDs', () => {
    expect(normalizeModelId('Claude-3-5-Sonnet')).toBe('claude-3-5-sonnet');
  });

  it('should handle model IDs without versions', () => {
    expect(normalizeModelId('gpt-4o-mini')).toBe('gpt-4o-mini');
  });
});

describe('buildAnomalyFlags', () => {
  it('should return empty string when no anomalies are active', () => {
    const anomalies = createTestTelemetry({}).anomalies;
    expect(buildAnomalyFlags(anomalies)).toBe('');
  });

  it('should include active anomaly flags', () => {
    const anomalies = createTestTelemetry({
      anomalies: { slowTotalResponse: true, highUtilization: true },
    }).anomalies;
    expect(buildAnomalyFlags(anomalies)).toBe('highUtilization|slowTotalResponse');
  });

  it('should sort flags alphabetically', () => {
    const anomalies = createTestTelemetry({
      anomalies: { toolTimeout: true, contextOverflow: true, slowFirstToken: true },
    }).anomalies;
    expect(buildAnomalyFlags(anomalies)).toBe('contextOverflow|slowFirstToken|toolTimeout');
  });
});

describe('generateTelemetryFingerprint', () => {
  it('should generate consistent 40-char hex fingerprint', () => {
    const telemetry = createTestTelemetry({});
    const fp = generateTelemetryFingerprint(telemetry);

    expect(fp).toHaveLength(40);
    expect(fp).toMatch(/^[a-f0-9]{40}$/);
  });

  it('should generate same fingerprint for identical telemetry', () => {
    const telemetry1 = createTestTelemetry({});
    const telemetry2 = createTestTelemetry({});

    expect(generateTelemetryFingerprint(telemetry1)).toBe(generateTelemetryFingerprint(telemetry2));
  });

  it('should generate different fingerprint for different primary anomaly', () => {
    const telemetry1 = createTestTelemetry({ anomalies: { primaryAnomaly: 'slow_response' } });
    const telemetry2 = createTestTelemetry({ anomalies: { primaryAnomaly: 'context_overflow' } });

    expect(generateTelemetryFingerprint(telemetry1)).not.toBe(generateTelemetryFingerprint(telemetry2));
  });

  it('should generate different fingerprint for different severity', () => {
    const telemetry1 = createTestTelemetry({ anomalies: { severity: 'critical' } });
    const telemetry2 = createTestTelemetry({ anomalies: { severity: 'high' } });

    expect(generateTelemetryFingerprint(telemetry1)).not.toBe(generateTelemetryFingerprint(telemetry2));
  });

  it('should generate different fingerprint for different model', () => {
    const telemetry1 = createTestTelemetry({ model: { modelId: 'claude-3-5-sonnet' } });
    const telemetry2 = createTestTelemetry({ model: { modelId: 'gpt-4o' } });

    expect(generateTelemetryFingerprint(telemetry1)).not.toBe(generateTelemetryFingerprint(telemetry2));
  });

  it('should generate different fingerprint for different provider', () => {
    const telemetry1 = createTestTelemetry({ model: { provider: 'anthropic' } });
    const telemetry2 = createTestTelemetry({ model: { provider: 'openai' } });

    expect(generateTelemetryFingerprint(telemetry1)).not.toBe(generateTelemetryFingerprint(telemetry2));
  });

  it('should normalize model versions to same fingerprint', () => {
    const telemetry1 = createTestTelemetry({ model: { modelId: 'claude-3-5-sonnet-20241022' } });
    const telemetry2 = createTestTelemetry({ model: { modelId: 'claude-3-5-sonnet-20250101' } });

    // Both should normalize to 'claude-3-5-sonnet'
    expect(generateTelemetryFingerprint(telemetry1)).toBe(generateTelemetryFingerprint(telemetry2));
  });
});

describe('generateSemanticTelemetryFingerprint', () => {
  it('should generate consistent 40-char hex fingerprint', () => {
    const telemetry = createTestTelemetry({});
    const fp = generateSemanticTelemetryFingerprint(telemetry);

    expect(fp).toHaveLength(40);
    expect(fp).toMatch(/^[a-f0-9]{40}$/);
  });

  it('should generate same fingerprint regardless of severity', () => {
    const telemetry1 = createTestTelemetry({ anomalies: { severity: 'critical' } });
    const telemetry2 = createTestTelemetry({ anomalies: { severity: 'medium' } });

    // Semantic fingerprint ignores severity
    expect(generateSemanticTelemetryFingerprint(telemetry1)).toBe(generateSemanticTelemetryFingerprint(telemetry2));
  });

  it('should generate same fingerprint regardless of specific model version', () => {
    const telemetry1 = createTestTelemetry({ model: { modelId: 'claude-3-5-sonnet' } });
    const telemetry2 = createTestTelemetry({ model: { modelId: 'gpt-4o' } });

    // Both are same provider, so semantic fingerprint should match
    // (only primary anomaly + provider)
    expect(generateSemanticTelemetryFingerprint(telemetry1)).toBe(generateSemanticTelemetryFingerprint(telemetry2));
  });
});

describe('formatFingerprintComment', () => {
  it('should format fingerprint as HTML comment with telemetry prefix', () => {
    const fp = 'a'.repeat(40);
    expect(formatFingerprintComment(fp)).toBe(`<!-- telemetry-fingerprint:${'a'.repeat(40)} -->`);
  });
});

describe('formatSemanticFingerprintComment', () => {
  it('should format semantic fingerprint as HTML comment with telemetry prefix', () => {
    const fp = 'b'.repeat(40);
    expect(formatSemanticFingerprintComment(fp)).toBe(`<!-- telemetry-semantic-fingerprint:${'b'.repeat(40)} -->`);
  });
});

describe('extractFingerprintFromBody', () => {
  it('should extract telemetry fingerprint from issue body', () => {
    const fp = 'c'.repeat(40);
    const body = `Some content\n<!-- telemetry-fingerprint:${fp} -->\nMore content`;
    expect(extractFingerprintFromBody(body)).toBe(fp);
  });

  it('should return null for empty body', () => {
    expect(extractFingerprintFromBody(null)).toBeNull();
    expect(extractFingerprintFromBody(undefined)).toBeNull();
    expect(extractFingerprintFromBody('')).toBeNull();
  });

  it('should return null when no fingerprint found', () => {
    expect(extractFingerprintFromBody('No fingerprint here')).toBeNull();
  });

  it('should not match non-prefixed fingerprints', () => {
    const fp = 'd'.repeat(40);
    const body = `<!-- fingerprint:${fp} -->`; // liveops format, not telemetry
    expect(extractFingerprintFromBody(body)).toBeNull();
  });
});

describe('extractSemanticFingerprintFromBody', () => {
  it('should extract telemetry semantic fingerprint from issue body', () => {
    const fp = 'e'.repeat(40);
    const body = `Some content\n<!-- telemetry-semantic-fingerprint:${fp} -->\nMore content`;
    expect(extractSemanticFingerprintFromBody(body)).toBe(fp);
  });
});

describe('getSeverityEmoji', () => {
  it('should return correct emoji for each severity', () => {
    expect(getSeverityEmoji('critical')).toBe('\u{1F534}'); // Red
    expect(getSeverityEmoji('high')).toBe('\u{1F7E0}'); // Orange
    expect(getSeverityEmoji('medium')).toBe('\u{1F7E1}'); // Yellow
    expect(getSeverityEmoji('low')).toBe('\u{1F7E2}'); // Green
    expect(getSeverityEmoji('unknown')).toBe('\u{1F7E2}'); // Default to green
  });
});

describe('formatPrimaryAnomaly', () => {
  it('should replace underscores with spaces', () => {
    expect(formatPrimaryAnomaly('slow_response')).toBe('slow response');
    expect(formatPrimaryAnomaly('context_overflow')).toBe('context overflow');
    expect(formatPrimaryAnomaly('tool_failure')).toBe('tool failure');
  });
});
