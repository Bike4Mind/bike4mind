import { describe, it, expect } from 'vitest';
import { buildDlqAlarmSpecs, DLQ_ALARM_DEFAULTS } from '../dlqAlarmSpecs.js';

const NAMING = { appName: 'b4m', stage: 'production' };

describe('buildDlqAlarmSpecs', () => {
  it('builds the exact message-count alarm shape deployed from infra/dlqAlarms.ts', () => {
    const [messages] = buildDlqAlarmSpecs(
      { label: 'image-generation', displayName: 'Image Generation', application: 'ImageGeneration' },
      NAMING
    );
    expect(messages.kind).toBe('messages');
    expect(messages.resourceName).toBe('dlq-image-generation-messages');
    expect(messages.args).toEqual({
      name: 'b4m-production-dlq-image-generation-messages',
      alarmDescription: 'Image Generation DLQ has messages - processing failures detected',
      comparisonOperator: 'GreaterThanThreshold',
      evaluationPeriods: 3,
      metricName: 'ApproximateNumberOfMessagesVisible',
      namespace: 'AWS/SQS',
      period: 60,
      statistic: 'Maximum',
      threshold: 0,
      treatMissingData: 'notBreaching',
      tags: { Application: 'ImageGeneration', Severity: 'Critical', MonitoringType: 'DLQ' },
    });
  });

  it('builds the exact message-age alarm shape deployed from infra/dlqAlarms.ts', () => {
    const [, age] = buildDlqAlarmSpecs(
      { label: 'sre-job', displayName: 'SRE Job', application: 'SreAgent' },
      NAMING
    );
    expect(age.kind).toBe('age');
    expect(age.resourceName).toBe('dlq-sre-job-age');
    expect(age.args).toEqual({
      name: 'b4m-production-dlq-sre-job-age',
      alarmDescription: 'SRE Job DLQ has message stuck for >1 hour',
      comparisonOperator: 'GreaterThanThreshold',
      evaluationPeriods: 1,
      metricName: 'ApproximateAgeOfOldestMessage',
      namespace: 'AWS/SQS',
      period: 300,
      statistic: 'Maximum',
      threshold: 3600,
      treatMissingData: 'notBreaching',
      tags: { Application: 'SreAgent', Severity: 'High', MonitoringType: 'DLQ' },
    });
  });

  it('applies per-descriptor overrides', () => {
    const [messages, age] = buildDlqAlarmSpecs(
      {
        label: 'q',
        displayName: 'Q',
        application: 'App',
        messageEvalPeriods: 5,
        messageThreshold: 10,
        ageThreshold: 7200,
      },
      NAMING
    );
    expect(messages.args.evaluationPeriods).toBe(5);
    expect(messages.args.threshold).toBe(10);
    expect(age.args.threshold).toBe(7200);
    // Age eval periods have no per-descriptor override; they stay at the default.
    expect(age.args.evaluationPeriods).toBe(DLQ_ALARM_DEFAULTS.ageEvalPeriods);
  });

  it('accepts custom defaults', () => {
    const [messages, age] = buildDlqAlarmSpecs(
      { label: 'q', displayName: 'Q', application: 'App' },
      NAMING,
      { ...DLQ_ALARM_DEFAULTS, messagePeriod: 120, agePeriod: 600 }
    );
    expect(messages.args.period).toBe(120);
    expect(age.args.period).toBe(600);
  });

  it('rejects a descriptor with no label', () => {
    expect(() => buildDlqAlarmSpecs({ label: '', displayName: 'X', application: 'App' }, NAMING)).toThrow(
      'label is required'
    );
  });
});
