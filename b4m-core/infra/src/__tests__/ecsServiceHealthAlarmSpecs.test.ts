import { describe, it, expect } from 'vitest';
import { buildEcsServiceHealthAlarmSpec, ECS_SERVICE_HEALTH_ALARM_DEFAULTS } from '../ecsServiceHealthAlarmSpecs.js';

const NAMING = { appName: 'b4m', stage: 'production' };

const FANOUT = {
  label: 'subscriber-fanout',
  displayName: 'Subscriber Fanout',
  application: 'RealtimeFanout',
  serviceName: 'subscriberFanoutV2',
};

describe('buildEcsServiceHealthAlarmSpec', () => {
  it('builds the no-tasks alarm shape', () => {
    const spec = buildEcsServiceHealthAlarmSpec(FANOUT, NAMING);
    expect(spec.kind).toBe('no-tasks');
    expect(spec.resourceName).toBe('ecs-subscriber-fanout-no-tasks');
    expect(spec.serviceName).toBe('subscriberFanoutV2');
    expect(spec.args).toEqual({
      name: 'b4m-production-ecs-subscriber-fanout-no-tasks',
      alarmDescription:
        'Subscriber Fanout has no running ECS tasks - the service is down. ' +
        'Check the service events for a task that cannot start (image pull denied, missing secret).',
      comparisonOperator: 'LessThanThreshold',
      evaluationPeriods: 2,
      metricName: 'CPUUtilization',
      namespace: 'AWS/ECS',
      period: 300,
      statistic: 'Maximum',
      threshold: 0,
      treatMissingData: 'breaching',
      tags: { Application: 'RealtimeFanout', Severity: 'Critical', MonitoringType: 'ECSService' },
    });
  });

  // The whole alarm rests on these two fields. A positive threshold would fire on an
  // idle service, and 'notBreaching' would reproduce exactly the INSUFFICIENT_DATA
  // blind spot that let a dead service go unnoticed for two and a half weeks.
  it('detects the outage through missing data, not through a utilization level', () => {
    const { args } = buildEcsServiceHealthAlarmSpec(FANOUT, NAMING);
    expect(args.threshold).toBe(0);
    expect(args.comparisonOperator).toBe('LessThanThreshold');
    expect(args.treatMissingData).toBe('breaching');
  });

  it('holds OK for any real datapoint a live task could emit', () => {
    const { args } = buildEcsServiceHealthAlarmSpec(FANOUT, NAMING);
    // Utilization is never negative, so no live sample can satisfy the comparison.
    for (const observed of [0, 0.01, 8.5, 100]) {
      expect(observed < args.threshold).toBe(false);
    }
  });

  it('defaults severity to Critical and allows a downgrade', () => {
    expect(buildEcsServiceHealthAlarmSpec(FANOUT, NAMING).args.tags.Severity).toBe('Critical');
    expect(buildEcsServiceHealthAlarmSpec({ ...FANOUT, severity: 'High' }, NAMING).args.tags.Severity).toBe('High');
  });

  it('allows overriding the evaluation periods without touching the period length', () => {
    const spec = buildEcsServiceHealthAlarmSpec({ ...FANOUT, noTasksEvalPeriods: 4 }, NAMING);
    expect(spec.args.evaluationPeriods).toBe(4);
    expect(spec.args.period).toBe(ECS_SERVICE_HEALTH_ALARM_DEFAULTS.noTasksPeriod);
  });

  it('namespaces the alarm by app and stage', () => {
    const spec = buildEcsServiceHealthAlarmSpec(FANOUT, { appName: 'b4m', stage: 'dev' });
    expect(spec.args.name).toBe('b4m-dev-ecs-subscriber-fanout-no-tasks');
  });

  it('rejects a descriptor missing the fields the alarm cannot be built without', () => {
    expect(() => buildEcsServiceHealthAlarmSpec({ ...FANOUT, label: '' }, NAMING)).toThrow(/label is required/);
    expect(() => buildEcsServiceHealthAlarmSpec({ ...FANOUT, serviceName: '' }, NAMING)).toThrow(
      /serviceName is required/
    );
  });
});
