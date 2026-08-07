import { describe, expect, it } from 'vitest';
import {
  ANOMALY_THRESHOLDS,
  type AnomaliesTelemetry,
  type SubagentTelemetry,
  type ToolTelemetry,
} from '@bike4mind/common';
import { TelemetryBuilder } from './TelemetryBuilder';

const sessionId = { hash: 'test-hash', dateKey: '2026-01-01' };

/** Builds through the public API so these stay valid if computeAnomalies is refactored. */
const anomaliesFor = (setup: (b: TelemetryBuilder) => void = () => {}): AnomaliesTelemetry => {
  const builder = new TelemetryBuilder(sessionId);
  builder.setRequestedModel('claude-3-5-sonnet', 'anthropic');
  setup(builder);
  return builder.build().anomalies;
};

const withUtilization =
  (percentage: number, overflowDetected = false) =>
  (b: TelemetryBuilder) => {
    b.setContextWindow({ utilizationPercentage: percentage, overflowDetected });
  };

const withTruncation = (percentage: number) => (b: TelemetryBuilder) => {
  b.setTruncation({ wasTruncated: true, truncationPercentage: percentage });
};

const tool = (overrides: Partial<ToolTelemetry> = {}): ToolTelemetry => ({
  toolName: 'web_fetch',
  isMcpTool: false,
  invocationCount: 1,
  successCount: 1,
  failureCount: 0,
  totalDurationMs: 100,
  maxDurationMs: 100,
  retryCount: 0,
  ...overrides,
});

const subagent = (overrides: Partial<SubagentTelemetry> = {}): SubagentTelemetry => ({
  agentName: 'researcher',
  delegationCount: 1,
  successCount: 1,
  failureCount: 0,
  timeoutCount: 0,
  totalDurationMs: 1000,
  totalTokensUsed: 100,
  ...overrides,
});

describe('TelemetryBuilder anomaly classification', () => {
  it('reports no anomaly for a clean turn', () => {
    const anomalies = anomaliesFor();

    expect(anomalies.anomalyScore).toBe(0);
    expect(anomalies.primaryAnomaly).toBe('none');
  });

  describe('utilization', () => {
    // Regression: this band used to score 10 but fall through to primaryAnomaly 'none',
    // hiding the turn from the admin Severity filter and stat counts.
    it('classifies a high-utilization-only turn instead of leaving it unclassified', () => {
      const anomalies = anomaliesFor(withUtilization(92));

      expect(anomalies.primaryAnomaly).toBe('high_utilization');
      expect(anomalies.anomalyScore).toBe(10);
      expect(anomalies.severity).toBe('low');
    });

    it('fires exactly at the high-utilization threshold', () => {
      expect(anomaliesFor(withUtilization(ANOMALY_THRESHOLDS.highUtilization)).primaryAnomaly).toBe('high_utilization');
      expect(anomaliesFor(withUtilization(ANOMALY_THRESHOLDS.highUtilization - 0.01)).primaryAnomaly).toBe('none');
    });

    // Regression: criticalUtilization also sets highUtilization, and counting raw flags
    // made a single-cause turn look multi-cause.
    it('keeps a critical-utilization-only turn single-cause', () => {
      const anomalies = anomaliesFor(withUtilization(97));

      expect(anomalies.primaryAnomaly).toBe('high_utilization');
      expect(anomalies.anomalyScore).toBe(25);
    });
  });

  describe('overflow', () => {
    // Regression: on the normal capture path utilization is inputTokens/maxSafeInputTokens,
    // so overflow implies >100% utilization. Counting utilization separately made
    // 'context_overflow' unreachable there.
    it('reports overflow rather than utilization when both are set', () => {
      expect(anomaliesFor(withUtilization(105, true)).primaryAnomaly).toBe('context_overflow');
    });

    // The hard-overflow path measures utilization against contextLimit, not the safe
    // input budget, so it can report overflow below the utilization threshold.
    it('reports overflow when utilization is below the threshold', () => {
      expect(anomaliesFor(withUtilization(82, true)).primaryAnomaly).toBe('context_overflow');
    });
  });

  describe('single-cause turns with paired flags', () => {
    it('classifies critical truncation as high_truncation', () => {
      const anomalies = anomaliesFor(withTruncation(80));

      expect(anomalies.primaryAnomaly).toBe('high_truncation');
      expect(anomalies.anomalyScore).toBe(20);
    });

    it('classifies a failing slow tool as tool_failure', () => {
      const anomalies = anomaliesFor(b => {
        b.addTool(tool({ invocationCount: 3, successCount: 0, failureCount: 3, maxDurationMs: 45_000 }));
      });

      expect(anomalies.primaryAnomaly).toBe('tool_failure');
      expect(anomalies.toolFailureSpike).toBe(true);
      expect(anomalies.toolTimeout).toBe(true);
    });

    it('classifies both slow-response flags as slow_response', () => {
      const anomalies = anomaliesFor(b => {
        b.setPerformance({ totalResponseTimeMs: 70_000, firstTokenTimeMs: 12_000 });
      });

      expect(anomalies.primaryAnomaly).toBe('slow_response');
    });

    it('classifies a subagent timeout as subagent_timeout', () => {
      const anomalies = anomaliesFor(b => {
        b.addSubagent(subagent({ totalDurationMs: 400_000 }));
      });

      expect(anomalies.primaryAnomaly).toBe('subagent_timeout');
    });
  });

  describe("'multiple'", () => {
    it('reports multiple when genuinely distinct causes fire', () => {
      const anomalies = anomaliesFor(b => {
        withUtilization(92)(b);
        withTruncation(60)(b);
      });

      expect(anomalies.primaryAnomaly).toBe('multiple');
      expect(anomalies.anomalyScore).toBe(20);
    });
  });

  describe('dedupKey', () => {
    it('keys on the primary anomaly and model', () => {
      expect(anomaliesFor(withUtilization(92)).dedupKey).toBe('high_utilization_claude-3-5-sonnet');
    });

    it('appends the failing tool name for tool failures', () => {
      const anomalies = anomaliesFor(b => {
        b.addTool(tool({ toolName: 'delegate-to-agent', invocationCount: 4, successCount: 0, failureCount: 4 }));
      });

      expect(anomalies.dedupKey).toBe('tool_failure_claude-3-5-sonnet_delegate-to-agent');
    });
  });

  // The equivalence the admin Context Inspector relies on: it filters and counts real
  // anomalies via primaryAnomaly !== 'none', while the score filter keys anomalyScore.
  // If the two ever disagree a turn is silently dropped from the list.
  describe('score/classification equivalence', () => {
    const cases: Array<[string, (b: TelemetryBuilder) => void]> = [
      ['clean', () => {}],
      ['just below utilization threshold', withUtilization(89.99)],
      ['high utilization', withUtilization(92)],
      ['critical utilization', withUtilization(97)],
      ['overflow below utilization threshold', withUtilization(82, true)],
      ['overflow above utilization threshold', withUtilization(105, true)],
      ['just below truncation threshold', withTruncation(49.99)],
      ['high truncation', withTruncation(60)],
      ['critical truncation', withTruncation(80)],
      ['tool failure spike', b => b.addTool(tool({ invocationCount: 3, successCount: 0, failureCount: 3 }))],
      ['tool timeout', b => b.addTool(tool({ maxDurationMs: 45_000 }))],
      ['subagent timeout', b => b.addSubagent(subagent({ totalDurationMs: 400_000 }))],
      ['slow first token', b => b.setPerformance({ totalResponseTimeMs: 20_000, firstTokenTimeMs: 12_000 })],
      ['slow total response', b => b.setPerformance({ totalResponseTimeMs: 70_000 })],
      [
        'several causes',
        b => {
          withUtilization(97)(b);
          withTruncation(80)(b);
          b.addSubagent(subagent({ totalDurationMs: 400_000 }));
        },
      ],
    ];

    it.each(cases)('holds score > 0 <=> primaryAnomaly !== none for %s', (_name, setup) => {
      const anomalies = anomaliesFor(setup);

      expect(anomalies.anomalyScore > 0).toBe(anomalies.primaryAnomaly !== 'none');
    });
  });
});
