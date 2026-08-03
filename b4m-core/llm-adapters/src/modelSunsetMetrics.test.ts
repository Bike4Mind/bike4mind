import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';

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

import { recordDeprecatedModelRequest, MODEL_SUNSET_NAMESPACE, DEPRECATED_MODEL_REQUEST_METRIC } from './modelSunsetMetrics';

describe('recordDeprecatedModelRequest', () => {
  const originalStage = process.env.SEED_STAGE_NAME;

  beforeEach(() => {
    send.mockReset().mockResolvedValue(undefined);
    process.env.SEED_STAGE_NAME = 'production';
  });

  afterEach(() => {
    if (originalStage === undefined) delete process.env.SEED_STAGE_NAME;
    else process.env.SEED_STAGE_NAME = originalStage;
  });

  // The alarm and dashboard reference these strings from infra/, where nothing
  // can import them. A rename that only touches this package would leave the
  // alarm watching a metric nobody publishes - exactly the silent failure this
  // whole file exists to prevent - so pin the literals, not the constants.
  it('publishes under the namespace and metric name infra watches', async () => {
    await recordDeprecatedModelRequest('grok-3', 'grok-4.5');

    const { Namespace, MetricData } = send.mock.calls[0][0].input;
    expect(Namespace).toBe('Lumina5/ModelSunset');
    expect(MODEL_SUNSET_NAMESPACE).toBe('Lumina5/ModelSunset');
    expect(DEPRECATED_MODEL_REQUEST_METRIC).toBe('DeprecatedModelRequest');
    for (const datum of MetricData) {
      expect(datum.MetricName).toBe('DeprecatedModelRequest');
    }
  });

  it('publishes an alarmable Stage-only datapoint alongside the per-model breakdown', async () => {
    await recordDeprecatedModelRequest('grok-3', 'grok-4.5');

    expect(send).toHaveBeenCalledTimes(1);
    const { MetricData } = send.mock.calls[0][0].input;
    expect(MetricData).toHaveLength(2);
    expect(MetricData[0].Dimensions).toEqual([{ Name: 'Stage', Value: 'production' }]);
    // Model is the pinned id, not the upgrade target: the pin is what gets fixed.
    expect(MetricData[1].Dimensions).toEqual([
      { Name: 'Stage', Value: 'production' },
      { Name: 'Model', Value: 'grok-3' },
    ]);
    expect(MetricData.every((d: { Value: number }) => d.Value === 1)).toBe(true);
  });

  it('stamps a timestamp so a datapoint lands in the period it happened in', async () => {
    await recordDeprecatedModelRequest('grok-3', 'grok-4.5');

    const { MetricData } = send.mock.calls[0][0].input;
    for (const datum of MetricData) {
      expect(datum.Timestamp).toBeInstanceOf(Date);
    }
  });

  it('no-ops outside a deployed stage', async () => {
    delete process.env.SEED_STAGE_NAME;
    await recordDeprecatedModelRequest('grok-3', 'grok-4.5');
    expect(send).not.toHaveBeenCalled();
  });

  it('swallows CloudWatch failures but logs them, so telemetry never breaks a request', async () => {
    send.mockRejectedValue(new Error('throttled'));
    const logger = { warn: vi.fn() } as unknown as Logger;

    await expect(recordDeprecatedModelRequest('grok-3', 'grok-4.5', logger)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[model-sunset]'),
      expect.objectContaining({ requestedModel: 'grok-3', resolvedModel: 'grok-4.5', error: 'throttled' })
    );
  });
});
