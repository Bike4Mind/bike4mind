import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';

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

import {
  buildFeedbackDeliveryFailureMetrics,
  buildFeedbackDeliverySkippedMetrics,
  recordWebhookDeliveryFailure,
} from './cloudwatch';

// A metric identified by a subset of dimensions is a DISTINCT CloudWatch stream from the
// full-dimension one, so `feedbackDeliveryFailures` and `feedbackDeliveryMisconfigured`
// (infra/alarms.ts), which read a `{ Stage }`-only stream, only receive data if these builders
// emit that exact rollup. See the sibling `webhookDeliveryHighFailures` alarm, which lacks any
// rollup and can never fire.
describe('buildFeedbackDeliveryFailureMetrics', () => {
  it('emits both a full drill-down entry and a Stage-only rollup entry', () => {
    const metrics = buildFeedbackDeliveryFailureMetrics('slack', 'production', '500', 'production');

    expect(metrics).toHaveLength(2);
    expect(metrics).toContainEqual({
      name: 'DeliveryFailed',
      value: 1,
      dimensions: { channel: 'slack', stageClass: 'production', errorType: '500' },
      unit: StandardUnit.Count,
    });
    expect(metrics).toContainEqual({
      name: 'DeliveryFailed',
      value: 1,
      dimensions: { Stage: 'production' },
      unit: StandardUnit.Count,
    });
  });

  it('scopes the rollup to the real stage value, not a binary production/nonprod split, so a dev-stage failure is distinguishable from a preview', () => {
    const devMetrics = buildFeedbackDeliveryFailureMetrics('email', 'nonprod', 'publish_error', 'dev');
    const previewMetrics = buildFeedbackDeliveryFailureMetrics('email', 'nonprod', 'publish_error', 'pr-1234');

    expect(devMetrics).toContainEqual(
      expect.objectContaining({ name: 'DeliveryFailed', dimensions: { Stage: 'dev' } })
    );
    expect(previewMetrics).toContainEqual(
      expect.objectContaining({ name: 'DeliveryFailed', dimensions: { Stage: 'pr-1234' } })
    );
    // Different Stage dimension values are different CloudWatch metric streams - an alarm
    // reading { Stage: 'dev' } structurally cannot match a { Stage: 'pr-1234' } data point.
  });

  it('falls back to "unknown" when the stage is undefined, rather than dropping the rollup', () => {
    const metrics = buildFeedbackDeliveryFailureMetrics('slack', 'nonprod', 'network', undefined);

    expect(metrics).toContainEqual(expect.objectContaining({ dimensions: { Stage: 'unknown' } }));
  });
});

describe('buildFeedbackDeliverySkippedMetrics', () => {
  it('emits a rollup for unconfigured_webhook (enabled but broken) on top of the drill-down entry', () => {
    const metrics = buildFeedbackDeliverySkippedMetrics('slack', 'production', 'unconfigured_webhook', 'production');

    expect(metrics).toHaveLength(2);
    expect(metrics).toContainEqual({
      name: 'DeliverySkipped',
      value: 1,
      dimensions: { channel: 'slack', stageClass: 'production', reason: 'unconfigured_webhook' },
      unit: StandardUnit.Count,
    });
    expect(metrics).toContainEqual({
      name: 'DeliverySkipped',
      value: 1,
      dimensions: { Stage: 'production' },
      unit: StandardUnit.Count,
    });
  });

  it('emits a rollup for no_recipients the same way', () => {
    const metrics = buildFeedbackDeliverySkippedMetrics('email', 'production', 'no_recipients', 'production');

    expect(metrics).toContainEqual(
      expect.objectContaining({ name: 'DeliverySkipped', dimensions: { Stage: 'production' } })
    );
  });

  it('does NOT emit a rollup for "disabled" - an admin turning the setting off is not an incident', () => {
    const metrics = buildFeedbackDeliverySkippedMetrics('slack', 'production', 'disabled', 'production');

    expect(metrics).toHaveLength(1);
    expect(metrics[0].dimensions).toEqual({ channel: 'slack', stageClass: 'production', reason: 'disabled' });
  });

  it('does NOT emit a rollup for "nonprod_unconfigured" - the deliberate non-prod suppression case', () => {
    const metrics = buildFeedbackDeliverySkippedMetrics('slack', 'nonprod', 'nonprod_unconfigured', 'pr-1234');

    expect(metrics).toHaveLength(1);
  });
});

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
