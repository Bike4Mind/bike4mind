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
      treatMissingData: 'ignore',
      tags: { Application: 'ImageGeneration', Severity: 'Critical', MonitoringType: 'DLQ' },
    });
  });

  it('builds the exact message-age alarm shape deployed from infra/dlqAlarms.ts', () => {
    const [, age] = buildDlqAlarmSpecs({ label: 'sre-job', displayName: 'SRE Job', application: 'SreAgent' }, NAMING);
    expect(age.kind).toBe('age');
    expect(age.resourceName).toBe('dlq-sre-job-age');
    expect(age.args).toEqual({
      name: 'b4m-production-dlq-sre-job-age',
      alarmDescription: 'SRE Job DLQ has message stuck for >1 hour',
      comparisonOperator: 'GreaterThanThreshold',
      evaluationPeriods: 1,
      threshold: 3600,
      treatMissingData: 'ignore',
      metricQueries: [
        {
          id: 'visible',
          metric: {
            namespace: 'AWS/SQS',
            metricName: 'ApproximateNumberOfMessagesVisible',
            period: 300,
            stat: 'Maximum',
          },
          returnData: false,
        },
        {
          id: 'age',
          metric: {
            namespace: 'AWS/SQS',
            metricName: 'ApproximateAgeOfOldestMessage',
            period: 300,
            stat: 'Maximum',
          },
          returnData: false,
        },
        {
          id: 'oldest',
          label: 'Oldest message age (0 when the queue is empty)',
          expression: 'IF(visible > 0, age, 0)',
          returnData: true,
        },
      ],
      tags: { Application: 'SreAgent', Severity: 'High', MonitoringType: 'DLQ' },
    });
  });

  it('holds alarm state on a missing SQS datapoint for both alarm kinds', () => {
    // 'ignore' holds the state; 'notBreaching' let a gap resolve ALARM to OK, and 'missing'
    // moved it to INSUFFICIENT_DATA - both re-page on the next breaching datapoint.
    // Asserted per kind so a fix cannot land on one alarm only.
    const specs = buildDlqAlarmSpecs({ label: 'q', displayName: 'Q', application: 'App' }, NAMING);
    expect(specs.map(spec => [spec.kind, spec.args.treatMissingData])).toEqual([
      ['messages', 'ignore'],
      ['age', 'ignore'],
    ]);
  });

  it('scores an empty queue as 0 on the age alarm so a drain can still reach OK', () => {
    // ApproximateAgeOfOldestMessage is not published for an empty queue. Without the IF the
    // alarm would sit in INSUFFICIENT_DATA forever; with it, a drained DLQ resolves to OK.
    const [, ageSpec] = buildDlqAlarmSpecs({ label: 'q', displayName: 'Q', application: 'App' }, NAMING);
    if (ageSpec.kind !== 'age') throw new Error(`expected an age spec, got ${ageSpec.kind}`);
    const queries = ageSpec.args.metricQueries;
    expect(queries.find(q => q.returnData)?.expression).toBe('IF(visible > 0, age, 0)');
    expect(queries.map(q => q.metric?.metricName)).toEqual([
      'ApproximateNumberOfMessagesVisible',
      'ApproximateAgeOfOldestMessage',
      undefined,
    ]);
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
    const [messages, age] = buildDlqAlarmSpecs({ label: 'q', displayName: 'Q', application: 'App' }, NAMING, {
      ...DLQ_ALARM_DEFAULTS,
      messagePeriod: 120,
      agePeriod: 600,
    });
    expect(messages.args.period).toBe(120);
    if (age.kind !== 'age') throw new Error(`expected an age spec, got ${age.kind}`);
    expect(age.args.metricQueries.map(q => q.metric?.period)).toEqual([600, 600, undefined]);
  });

  it('rejects a descriptor with no label', () => {
    expect(() => buildDlqAlarmSpecs({ label: '', displayName: 'X', application: 'App' }, NAMING)).toThrow(
      'label is required'
    );
  });
});
