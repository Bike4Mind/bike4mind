import { DescribeAlarmsCommand, PutMetricAlarmCommand, type MetricAlarm } from '@aws-sdk/client-cloudwatch';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  desiredYoungAccountAlarmThresholds,
  reconcileYoungAccountAlarmThresholds,
} from './youngAccountSpendAlarmThresholds';

describe('desiredYoungAccountAlarmThresholds', () => {
  it.each([
    ['0', {}, {}],
    ['unset', {}, {}],
    ['negative', { youngAccountSpendPageUsdPerHour: '-3', youngAccountSpendWarnUsdPerHour: -1 }, {}],
    ['a non-numeric string', { youngAccountSpendPageUsdPerHour: 'abc', youngAccountSpendWarnUsdPerHour: ' ' }, {}],
    ['zero', { youngAccountSpendPageUsdPerHour: '0', youngAccountSpendWarnUsdPerHour: 0 }, {}],
    ['infinite', { youngAccountSpendPageUsdPerHour: 'Infinity' }, {}],
    ['valid', { youngAccountSpendPageUsdPerHour: '7.5', youngAccountSpendWarnUsdPerHour: 3 }, { page: 7.5, warn: 3 }],
  ])('reads %s', (_label, settings, expected) => {
    expect(desiredYoungAccountAlarmThresholds(settings)).toEqual(expected);
  });
});

const NAMES = { page: 'app-prod-young-account-spend-rate', warn: 'app-prod-young-account-spend-rate-warn' };

const liveAlarm = (name: string, threshold: number): MetricAlarm => ({
  AlarmName: name,
  AlarmArn: `alarm-arn-${name}`,
  AlarmDescription: 'description',
  ActionsEnabled: true,
  ComparisonOperator: 'GreaterThanOrEqualToThreshold',
  EvaluationPeriods: 1,
  MetricName: 'EstimatedUsdYoungAccounts',
  Namespace: 'app/prod/LLMSpend',
  Period: 3600,
  Statistic: 'Sum',
  Threshold: threshold,
  TreatMissingData: 'notBreaching',
  AlarmActions: ['topic'],
  OKActions: ['topic'],
  InsufficientDataActions: [],
  StateValue: 'OK',
});

const send = vi.fn();
const logger = { log: vi.fn(), error: vi.fn() };
const reconcile = (desired: { page?: number; warn?: number }) =>
  reconcileYoungAccountAlarmThresholds({ client: { send }, alarmNames: NAMES, desired, logger });
const puts = () =>
  send.mock.calls.map(([command]) => command).filter(command => command instanceof PutMetricAlarmCommand);

beforeEach(() => {
  vi.clearAllMocks();
  send.mockImplementation(async (command: unknown) =>
    command instanceof DescribeAlarmsCommand
      ? { MetricAlarms: [liveAlarm(NAMES.page, 5), liveAlarm(NAMES.warn, 2)] }
      : {}
  );
});

describe('reconcileYoungAccountAlarmThresholds', () => {
  it('does nothing without a desired threshold', async () => {
    await reconcile({});
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves an alarm alone when its live threshold already matches', async () => {
    await reconcile({ page: 5, warn: 2 });
    expect(puts()).toEqual([]);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('rewrites only the changed alarm, copying its configuration and replacing the threshold', async () => {
    await reconcile({ page: 8, warn: 2 });
    const [put] = puts();
    expect(puts()).toHaveLength(1);
    expect(put.input).toEqual({
      AlarmName: NAMES.page,
      AlarmDescription: 'description',
      ActionsEnabled: true,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 1,
      MetricName: 'EstimatedUsdYoungAccounts',
      Namespace: 'app/prod/LLMSpend',
      Period: 3600,
      Statistic: 'Sum',
      TreatMissingData: 'notBreaching',
      AlarmActions: ['topic'],
      OKActions: ['topic'],
      InsufficientDataActions: [],
      Threshold: 8,
    });
    expect(logger.log).toHaveBeenCalledExactlyOnceWith('young-account-alarm-threshold-updated', {
      alarmName: NAMES.page,
      oldThreshold: 5,
      newThreshold: 8,
    });
  });

  it('writes one PutMetricAlarm per changed alarm', async () => {
    await reconcile({ page: 10, warn: 3 });
    expect(puts().map(put => [put.input.AlarmName, put.input.Threshold])).toEqual([
      [NAMES.page, 10],
      [NAMES.warn, 3],
    ]);
  });

  it('describes only the alarms it may change', async () => {
    await reconcile({ warn: 3 });
    const describe = send.mock.calls[0][0] as DescribeAlarmsCommand;
    expect(describe.input.AlarmNames).toEqual([NAMES.warn]);
  });

  it('logs a missing alarm and carries on', async () => {
    send.mockImplementation(async (command: unknown) =>
      command instanceof DescribeAlarmsCommand ? { MetricAlarms: [liveAlarm(NAMES.warn, 2)] } : {}
    );
    await reconcile({ page: 8, warn: 3 });
    expect(logger.error).toHaveBeenCalledWith('young-account-alarm-threshold-missing-alarm', {
      alarmName: NAMES.page,
    });
    expect(puts().map(put => put.input.AlarmName)).toEqual([NAMES.warn]);
  });

  it('logs a DescribeAlarms failure without throwing', async () => {
    send.mockRejectedValue(new Error('AccessDenied'));
    await expect(reconcile({ page: 8 })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('young-account-alarm-threshold-reconcile-failed', {
      error: 'AccessDenied',
    });
  });
});
