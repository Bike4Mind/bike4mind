import { DescribeAlarmsCommand, PutMetricAlarmCommand, type MetricAlarm } from '@aws-sdk/client-cloudwatch';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  desiredProviderSpendAlarmThresholds,
  reconcileProviderSpendAlarmThresholds,
  type ProviderSpendAlarmThresholds,
} from './providerSpendAlarmThresholds';

describe('desiredProviderSpendAlarmThresholds', () => {
  it.each([
    ['unset', {}, {}],
    ['empty', { providerSpendOpenaiUsdPerHour: '', providerSpendAnthropicUsdPerHour: ' ' }, {}],
    ['zero', { providerSpendOpenaiUsdPerHour: '0', providerSpendAnthropicUsdPerHour: 0 }, {}],
    ['negative', { providerSpendOpenaiUsdPerHour: '-5' }, {}],
    ['junk', { providerSpendOpenaiUsdPerHour: 'fifty', providerSpendAnthropicUsdPerHour: true }, {}],
    ['infinite', { providerSpendAnthropicUsdPerHour: 'Infinity' }, {}],
    [
      'numeric strings',
      { providerSpendOpenaiUsdPerHour: ' 50 ', providerSpendAnthropicUsdPerHour: '45' },
      { openai: 50, anthropic: 45 },
    ],
    ['numbers', { providerSpendOpenaiUsdPerHour: 24.5 }, { openai: 24.5 }],
  ])('reads %s', (_label, settings, expected) => {
    expect(desiredProviderSpendAlarmThresholds(settings)).toEqual(expected);
  });
});

const NAMES = {
  openai: 'app-production-provider-reported-spend-hourly-openai',
  anthropic: 'app-production-provider-reported-spend-hourly-anthropic',
};

const liveAlarm = (name: string, provider: string, threshold: number): MetricAlarm => ({
  AlarmName: name,
  AlarmArn: `alarm-arn-${name}`,
  AlarmDescription: 'description',
  ActionsEnabled: true,
  ComparisonOperator: 'GreaterThanOrEqualToThreshold',
  EvaluationPeriods: 1,
  MetricName: 'ProviderReportedOrgUsd',
  Namespace: 'app/production/LLMSpend',
  Dimensions: [{ Name: 'Provider', Value: provider }],
  Period: 3600,
  Statistic: 'Sum',
  Threshold: threshold,
  TreatMissingData: 'notBreaching',
  AlarmActions: ['dlq-topic', 'oob-topic'],
  OKActions: ['dlq-topic', 'oob-topic'],
  InsufficientDataActions: [],
  StateValue: 'OK',
});

const LIVE = [liveAlarm(NAMES.openai, 'openai', 25), liveAlarm(NAMES.anthropic, 'anthropic', 90)];

const send = vi.fn();
const logger = { log: vi.fn(), error: vi.fn() };
const reconcile = (desired: ProviderSpendAlarmThresholds, alarmNames: Partial<typeof NAMES> = NAMES) =>
  reconcileProviderSpendAlarmThresholds({ client: { send }, alarmNames, desired, logger });
const puts = () =>
  send.mock.calls.map(([command]) => command).filter(command => command instanceof PutMetricAlarmCommand);

beforeEach(() => {
  vi.clearAllMocks();
  send.mockImplementation(async (command: unknown) =>
    command instanceof DescribeAlarmsCommand ? { MetricAlarms: LIVE } : {}
  );
});

describe('reconcileProviderSpendAlarmThresholds', () => {
  it('does nothing without a desired threshold', async () => {
    await reconcile({});
    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing for a provider whose alarm is not named on this stage', async () => {
    await reconcile({ openai: 50 }, { anthropic: NAMES.anthropic });
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves alarms alone when their live thresholds already match', async () => {
    await reconcile({ openai: 25, anthropic: 90 });
    expect(puts()).toEqual([]);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('rewrites only the changed alarm, copying its configuration and replacing the threshold', async () => {
    await reconcile({ openai: 50, anthropic: 90 });
    expect(puts()).toHaveLength(1);
    expect(puts()[0].input).toEqual({
      AlarmName: NAMES.openai,
      AlarmDescription: 'description',
      ActionsEnabled: true,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 1,
      MetricName: 'ProviderReportedOrgUsd',
      Namespace: 'app/production/LLMSpend',
      Dimensions: [{ Name: 'Provider', Value: 'openai' }],
      Period: 3600,
      Statistic: 'Sum',
      TreatMissingData: 'notBreaching',
      AlarmActions: ['dlq-topic', 'oob-topic'],
      OKActions: ['dlq-topic', 'oob-topic'],
      InsufficientDataActions: [],
      Threshold: 50,
    });
    expect(logger.log).toHaveBeenCalledExactlyOnceWith('provider-spend-alarm-threshold-updated', {
      alarmName: NAMES.openai,
      oldThreshold: 25,
      newThreshold: 50,
    });
  });

  it('describes only the alarms it may change and leaves the other provider untouched', async () => {
    await reconcile({ anthropic: 45 });
    const describe = send.mock.calls[0][0] as DescribeAlarmsCommand;
    expect(describe.input.AlarmNames).toEqual([NAMES.anthropic]);
    expect(puts().map(put => [put.input.AlarmName, put.input.Threshold])).toEqual([[NAMES.anthropic, 45]]);
  });

  it('logs a missing alarm and carries on', async () => {
    send.mockImplementation(async (command: unknown) =>
      command instanceof DescribeAlarmsCommand ? { MetricAlarms: [LIVE[1]] } : {}
    );
    await reconcile({ openai: 50, anthropic: 45 });
    expect(logger.error).toHaveBeenCalledWith('provider-spend-alarm-threshold-missing-alarm', {
      alarmName: NAMES.openai,
    });
    expect(puts().map(put => put.input.AlarmName)).toEqual([NAMES.anthropic]);
  });

  it.each([new Error('AccessDenied'), 'network down'])(
    'continues to the next alarm when one update fails: %s',
    async error => {
      send.mockImplementation(async (command: unknown) => {
        if (command instanceof DescribeAlarmsCommand) return { MetricAlarms: LIVE };
        if (command instanceof PutMetricAlarmCommand && command.input.AlarmName === NAMES.openai) throw error;
        return {};
      });
      await expect(reconcile({ openai: 50, anthropic: 45 })).resolves.toBeUndefined();
      expect(puts().map(put => put.input.AlarmName)).toEqual([NAMES.openai, NAMES.anthropic]);
      expect(logger.error).toHaveBeenCalledWith('provider-spend-alarm-threshold-update-failed', {
        alarmName: NAMES.openai,
        error: error instanceof Error ? error.message : error,
      });
      expect(logger.log).toHaveBeenCalledExactlyOnceWith('provider-spend-alarm-threshold-updated', {
        alarmName: NAMES.anthropic,
        oldThreshold: 90,
        newThreshold: 45,
      });
    }
  );

  it('logs and swallows a DescribeAlarms failure', async () => {
    send.mockRejectedValue(new Error('throttled'));
    await expect(reconcile({ openai: 50 })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('provider-spend-alarm-threshold-reconcile-failed', {
      error: 'throttled',
    });
  });
});
