import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ILogger } from '@bike4mind/observability';

const send = vi.fn();

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: vi.fn(function (this: any) {
    this.send = send;
  }),
  PutMetricDataCommand: vi.fn(function (this: any, input: unknown) {
    this.input = input;
  }),
  StandardUnit: { Count: 'Count' },
}));

import { recordReplSandboxUnavailable, REPL_SANDBOX_NAMESPACE, SANDBOX_UNAVAILABLE_METRIC } from './replSandboxMetrics';

describe('recordReplSandboxUnavailable', () => {
  const originalStage = process.env.SEED_STAGE_NAME;

  beforeEach(() => {
    send.mockReset().mockResolvedValue(undefined);
    process.env.SEED_STAGE_NAME = 'production';
  });

  afterEach(() => {
    if (originalStage === undefined) delete process.env.SEED_STAGE_NAME;
    else process.env.SEED_STAGE_NAME = originalStage;
  });

  // infra/alarms.ts references these strings and cannot import them. A rename
  // confined to this package would leave the alarm watching a metric nobody
  // publishes - which is the same silent failure the metric exists to catch -
  // so pin the literals, not the constants.
  it('publishes under the namespace and metric name infra watches', async () => {
    await recordReplSandboxUnavailable('wake');

    const { Namespace, MetricData } = send.mock.calls[0][0].input;
    expect(Namespace).toBe('Lumina5/ReplSandbox');
    expect(REPL_SANDBOX_NAMESPACE).toBe('Lumina5/ReplSandbox');
    expect(SANDBOX_UNAVAILABLE_METRIC).toBe('SandboxUnavailable');
    for (const datum of MetricData) {
      expect(datum.MetricName).toBe('SandboxUnavailable');
    }
  });

  it('publishes an alarmable Stage-only datapoint alongside the per-caller breakdown', async () => {
    await recordReplSandboxUnavailable('rlm-answer');

    expect(send).toHaveBeenCalledTimes(1);
    const { MetricData } = send.mock.calls[0][0].input;
    expect(MetricData).toHaveLength(2);
    expect(MetricData[0].Dimensions).toEqual([{ Name: 'Stage', Value: 'production' }]);
    expect(MetricData[1].Dimensions).toEqual([
      { Name: 'Stage', Value: 'production' },
      { Name: 'Caller', Value: 'rlm-answer' },
    ]);
    expect(MetricData.every((d: { Value: number }) => d.Value === 1)).toBe(true);
  });

  it('stamps a timestamp so a datapoint lands in the period it happened in', async () => {
    await recordReplSandboxUnavailable('wake');

    const { MetricData } = send.mock.calls[0][0].input;
    for (const datum of MetricData) {
      expect(datum.Timestamp).toBeInstanceOf(Date);
    }
  });

  it('no-ops outside a deployed stage', async () => {
    delete process.env.SEED_STAGE_NAME;
    await recordReplSandboxUnavailable('wake');
    expect(send).not.toHaveBeenCalled();
  });

  it('swallows CloudWatch failures but logs them, so telemetry never turns a degrade into a failure', async () => {
    send.mockRejectedValue(new Error('throttled'));
    const logger = { warn: vi.fn() } as unknown as ILogger;

    await expect(recordReplSandboxUnavailable('wake', logger)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[repl-sandbox]'),
      expect.objectContaining({ caller: 'wake', error: 'throttled' })
    );
  });
});
