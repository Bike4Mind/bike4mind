import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: vi.fn(function (this: any) {
    this.send = send;
  }),
  PutMetricDataCommand: vi.fn(function (this: any, input: unknown) {
    this.input = input;
  }),
  StandardUnit: { Count: 'Count', Milliseconds: 'Milliseconds', None: 'None', Percent: 'Percent' },
}));

import { recordWebhookDeliveryFailure } from './cloudwatch';

describe('recordWebhookDeliveryFailure', () => {
  beforeEach(() => {
    send.mockReset().mockResolvedValue(undefined);
  });

  // webhookDeliveryHighFailures (infra/alarms.ts) alarms on DeliveryFailed with no
  // dimension filter, so it only receives data from a dimensionless datapoint - the
  // dimensioned one is a separate CloudWatch metric stream the alarm never sees.
  it('emits a dimensionless DeliveryFailed datapoint alongside the dimensioned one', async () => {
    await recordWebhookDeliveryFailure('org-1', 'event.type', 100, 500, 'timeout');

    expect(send).toHaveBeenCalledTimes(1);
    const { MetricData } = send.mock.calls[0][0].input;
    const failedData = MetricData.filter((d: { MetricName: string }) => d.MetricName === 'DeliveryFailed');

    expect(failedData).toHaveLength(2);
    expect(failedData).toContainEqual(
      expect.objectContaining({
        MetricName: 'DeliveryFailed',
        Value: 1,
        Dimensions: [
          { Name: 'orgId', Value: 'org-1' },
          { Name: 'eventType', Value: 'event.type' },
          { Name: 'errorType', Value: 'timeout' },
        ],
      })
    );
    expect(failedData).toContainEqual(
      expect.objectContaining({ MetricName: 'DeliveryFailed', Value: 1, Dimensions: [] })
    );
  });

  it('still emits the dimensionless DeliveryFailed datapoint when httpStatusCode is absent', async () => {
    await recordWebhookDeliveryFailure('org-1', 'event.type', 100, 0, 'timeout');

    const { MetricData } = send.mock.calls[0][0].input;
    const dimensionless = MetricData.filter(
      (d: { MetricName: string; Dimensions: unknown[] }) =>
        d.MetricName === 'DeliveryFailed' && d.Dimensions.length === 0
    );
    expect(dimensionless).toHaveLength(1);
  });

  it('leaves the other emitted metrics unchanged', async () => {
    await recordWebhookDeliveryFailure('org-1', 'event.type', 100, 500, 'timeout');

    const { MetricData } = send.mock.calls[0][0].input;
    const names = MetricData.map((d: { MetricName: string }) => d.MetricName);
    expect(names).toEqual([
      'DeliveryAttempted',
      'DeliveryFailed',
      'DeliveryFailed',
      'DeliveryLatency',
      'HttpResponseCode',
    ]);
  });
});
