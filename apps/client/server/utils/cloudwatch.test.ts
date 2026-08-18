import { describe, it, expect } from 'vitest';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { buildFeedbackDeliveryFailureMetrics } from './cloudwatch';

// Deliberately does not mock the AWS SDK - this tests only the pure metric-shape builder,
// which is the alarm's real contract. A dimensioned metric is a DISTINCT CloudWatch stream
// from its dimensionless namesake, so `feedbackDeliveryFailures` (infra/alarms.ts), which reads
// the dimensionless `DeliveryFailed` stream, only receives data if this builder emits one. See
// the sibling `webhookDeliveryHighFailures` alarm, which lacks this and can never fire.
describe('buildFeedbackDeliveryFailureMetrics', () => {
  it('emits both a dimensioned drill-down entry and a dimensionless alarm-read entry on production', () => {
    const metrics = buildFeedbackDeliveryFailureMetrics('slack', 'production', '500');

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
      dimensions: {},
      unit: StandardUnit.Count,
    });
  });

  it('emits ONLY the dimensioned entry on a non-prod stage, so a nonprod failure never trips the production alarm', () => {
    const metrics = buildFeedbackDeliveryFailureMetrics('email', 'nonprod', 'publish_error');

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toEqual({
      name: 'DeliveryFailed',
      value: 1,
      dimensions: { channel: 'email', stageClass: 'nonprod', errorType: 'publish_error' },
      unit: StandardUnit.Count,
    });
  });
});
