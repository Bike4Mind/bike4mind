import { describe, expect, it } from 'vitest';
import type { ContextTelemetry, ContextTelemetryAlerts } from '@bike4mind/common';
import { ContextTelemetryAlertsSchema } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { AnomalyAlertService } from './AnomalyAlertService';

const alertConfig: ContextTelemetryAlerts = ContextTelemetryAlertsSchema.parse({});
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

const service = new AnomalyAlertService({ logger, alertConfig });

function telemetry(performance: ContextTelemetry['performance']): ContextTelemetry {
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
      inputTokens: 1_000,
      outputTokens: 500,
      contextWindowLimit: 200_000,
      utilizationPercentage: 0.5,
      reservedOutputTokens: 8_000,
      overflowDetected: false,
    },
    costs: { inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0, creditsUsed: 0 },
    performance,
    anomalies: {
      contextOverflow: false,
      highUtilization: false,
      criticalUtilization: false,
      highTruncation: false,
      criticalTruncation: false,
      toolFailureSpike: false,
      toolTimeout: false,
      subagentTimeout: false,
      slowFirstToken: true,
      slowTotalResponse: false,
      anomalyScore: 40,
      severity: 'medium',
      dedupKey: 'slow_response_claude-3-5-sonnet',
      primaryAnomaly: 'slow_response',
    },
  };
}

/** The Slack "*First Token:*" field, or '' when absent. */
function firstTokenField(performance: ContextTelemetry['performance']): string {
  const message = service.formatSlackMessage(telemetry(performance));
  const field = message.blocks.flatMap(block => block.fields ?? []).find(field => field.text.includes('First Token'));

  return field?.text ?? '';
}

/** The "*Detected Anomalies:*" section body, or '' when absent. */
function anomalyDetailsText(performance: ContextTelemetry['performance']): string {
  const message = service.formatSlackMessage(telemetry(performance));
  const block = message.blocks.find(b => b.text?.text.startsWith('*Detected Anomalies:*'));
  return block?.text?.text ?? '';
}

describe('AnomalyAlertService TTFVT rendering', () => {
  it('renders the measured number', () => {
    const field = firstTokenField({ totalResponseTimeMs: 20_000, firstTokenTimeMs: 12_000 });
    expect(field).toContain(`${(12_000).toLocaleString()}ms`);
  });

  it('renders "never rendered", not N/A, for a streamed-but-invisible turn', () => {
    const field = firstTokenField({ totalResponseTimeMs: 20_000, firstChunkTimeMs: 500 });

    expect(field).toContain('never rendered');
    expect(field).not.toContain('N/A');
  });

  it('renders N/A when neither timing was recorded', () => {
    const field = firstTokenField({ totalResponseTimeMs: 20_000 });
    expect(field).toBe('*First Token:*\nN/A');
  });

  // Assert on the anomaly-details section specifically: `allText`/the First Token field already
  // contains "never rendered", so only this pins the details line and kills a revert to the
  // always-"Slow first token" branch.
  it('labels the anomaly never-rendered in the anomaly details', () => {
    const details = anomalyDetailsText({ totalResponseTimeMs: 20_000, firstChunkTimeMs: 500 });

    expect(details).toContain('First token never rendered');
    expect(details).not.toContain('Slow first token');
  });

  it('labels a slow measured turn as a slow first token in the anomaly details', () => {
    const details = anomalyDetailsText({ totalResponseTimeMs: 20_000, firstTokenTimeMs: 12_000 });

    expect(details).toContain('Slow first token');
    expect(details).not.toContain('never rendered');
  });
});
