// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const resources = vi.hoisted(() => {
  function output<T>(value: T) {
    return { value, apply: <Result>(callback: (input: T) => Result) => output(callback(value)) };
  }
  return {
    output,
    alarm: vi.fn(function (name: string, _args: Record<string, unknown>) {
      return { arn: output(`alarm-arn-${name}`) };
    }),
    dashboard: vi.fn(function (_name: string, _args: Record<string, unknown>) {}),
    topic: { arn: 'alarm-topic' } as { arn: string } | undefined,
    oobTopic: { arn: 'email-topic' } as { arn: string } | undefined,
    cron: { nodes: { function: { name: 'poller-function' } } } as { nodes: { function: { name: string } } } | undefined,
    reconcileCron: { nodes: { function: { name: 'reconcile-function' } } } as
      { nodes: { function: { name: string } } } | undefined,
  };
});

vi.mock('../cron', () => ({
  get providerUsagePollCron() {
    return resources.cron;
  },
  get spendReconciliationCron() {
    return resources.reconcileCron;
  },
}));
// Keeps the admin key store out of these tests; infra/__tests__/providerAdminKeyAccess.test.ts covers it.
vi.mock('../constants', () => ({ runsScheduledJobs: false }));
vi.mock('../dlqAlarms', () => ({
  get dlqAlarmTopic() {
    return resources.topic;
  },
  get oobAlarmTopic() {
    return resources.oobTopic;
  },
}));
vi.mock('@bike4mind/infra', () => import('../../b4m-core/infra/src/stageGating'));

function callFor(
  mock: typeof resources.alarm | typeof resources.dashboard,
  name: string
): Record<string, unknown> | undefined {
  return mock.mock.calls.find(([logicalName]) => logicalName === name)?.[1];
}

async function load(stage = 'production', appName = 'test-app') {
  vi.resetModules();
  vi.stubGlobal('$app', { name: appName, stage });
  return import('../providerSpend');
}

const spendAlarm = (provider: string, threshold: number) => ({
  name: `test-app-production-provider-reported-spend-hourly-${provider}`,
  alarmDescription: expect.any(String),
  comparisonOperator: 'GreaterThanOrEqualToThreshold',
  evaluationPeriods: 1,
  metricName: 'ProviderReportedUsd',
  namespace: 'test-app/production/LLMSpend',
  dimensions: { Provider: provider },
  period: 3600,
  statistic: 'Sum',
  threshold,
  treatMissingData: 'notBreaching',
  alarmActions: ['alarm-topic', 'email-topic'],
  okActions: ['alarm-topic', 'email-topic'],
  tags: { Application: 'LLMSpend', Severity: 'Critical' },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ENABLE_MONITORING', undefined);
  vi.stubEnv('PROVIDER_SPEND_ALARM_USD_PER_HOUR', undefined);
  vi.stubEnv('PROVIDER_SPEND_ALARM_USD_PER_HOUR_ANTHROPIC', undefined);
  vi.stubGlobal('aws', {
    cloudwatch: { MetricAlarm: resources.alarm, Dashboard: resources.dashboard },
    getRegionOutput: () => ({ name: resources.output('us-east-2') }),
  });
  resources.topic = { arn: 'alarm-topic' };
  resources.oobTopic = { arn: 'email-topic' };
  resources.cron = { nodes: { function: { name: 'poller-function' } } };
  resources.reconcileCron = { nodes: { function: { name: 'reconcile-function' } } };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('provider-reported spend alarms', () => {
  it('pages on hourly Anthropic spend at the Anthropic ceiling', async () => {
    await load();
    expect(resources.alarm).toHaveBeenCalledWith('providerReportedSpendHourly-anthropic', spendAlarm('anthropic', 90));
  });

  it('pages on hourly OpenAI spend at the shared ceiling', async () => {
    await load();
    expect(resources.alarm).toHaveBeenCalledWith('providerReportedSpendHourly-openai', spendAlarm('openai', 25));
  });

  it('reads the configured ceilings', async () => {
    vi.stubEnv('PROVIDER_SPEND_ALARM_USD_PER_HOUR', '40');
    vi.stubEnv('PROVIDER_SPEND_ALARM_USD_PER_HOUR_ANTHROPIC', '150');
    await load();
    expect(callFor(resources.alarm, 'providerReportedSpendHourly-anthropic')?.threshold).toBe(150);
    expect(callFor(resources.alarm, 'providerReportedSpendHourly-openai')?.threshold).toBe(40);
  });

  it('keeps the Anthropic default when only the shared ceiling is set', async () => {
    vi.stubEnv('PROVIDER_SPEND_ALARM_USD_PER_HOUR', '40');
    await load();
    expect(callFor(resources.alarm, 'providerReportedSpendHourly-anthropic')?.threshold).toBe(90);
  });

  it.each([
    ['PROVIDER_SPEND_ALARM_USD_PER_HOUR', '0'],
    ['PROVIDER_SPEND_ALARM_USD_PER_HOUR', '2.5'],
    ['PROVIDER_SPEND_ALARM_USD_PER_HOUR_ANTHROPIC', 'abc'],
  ])('rejects a malformed %s of %s', async (name, raw) => {
    vi.stubEnv(name, raw);
    await expect(load()).rejects.toThrow(new RegExp(`${name} must be`));
  });

  it.each(['anthropic', 'openai'])('warns when the poller skips %s for a missing admin key', async provider => {
    await load();
    expect(resources.alarm).toHaveBeenCalledWith(`providerUsagePollSkipped-${provider}`, {
      name: `test-app-production-provider-usage-poll-skipped-${provider}`,
      alarmDescription: expect.any(String),
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName: 'ProviderUsagePollSkipped',
      namespace: 'test-app/production/LLMSpend',
      dimensions: { Provider: provider },
      period: 3600,
      statistic: 'Sum',
      threshold: 1,
      treatMissingData: 'notBreaching',
      alarmActions: ['alarm-topic'],
      tags: { Application: 'LLMSpend', Severity: 'Medium' },
    });
  });

  it('warns on any poller Lambda error in the hour', async () => {
    await load();
    expect(resources.alarm).toHaveBeenCalledWith('providerUsagePollErrors', {
      name: 'test-app-production-provider-usage-poll-errors',
      alarmDescription: expect.any(String),
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName: 'Errors',
      namespace: 'AWS/Lambda',
      period: 3600,
      statistic: 'Sum',
      threshold: 1,
      treatMissingData: 'notBreaching',
      dimensions: { FunctionName: 'poller-function' },
      alarmActions: ['alarm-topic'],
      tags: { Application: 'LLMSpend', Severity: 'Medium' },
    });
  });

  it('fails loudly when alarm routing is missing', async () => {
    resources.oobTopic = undefined;
    await expect(load()).rejects.toThrow('alarm routing requires dlqAlarmTopic and oobAlarmTopic');
  });
});

describe('spend reconciliation alarms', () => {
  it('pages when the nightly reconcile finds a closed month drifting past the error band', async () => {
    await load();
    expect(resources.alarm).toHaveBeenCalledWith('spendReconciliationDrift', {
      name: 'test-app-production-spend-reconciliation-drift',
      alarmDescription: expect.any(String),
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName: 'SpendReconciliationDrift',
      namespace: 'test-app/production/LLMSpend',
      period: 86400,
      statistic: 'Maximum',
      threshold: 1,
      treatMissingData: 'notBreaching',
      alarmActions: ['alarm-topic', 'email-topic'],
      tags: { Application: 'LLMSpend', Severity: 'Critical' },
    });
  });

  it('warns, separately from drift, when a nightly run reconciles nothing', async () => {
    await load();
    expect(resources.alarm).toHaveBeenCalledWith('spendReconciliationNothingReconciled', {
      name: 'test-app-production-spend-reconciliation-nothing-reconciled',
      alarmDescription: expect.any(String),
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName: 'SpendReconciliationNothingReconciled',
      namespace: 'test-app/production/LLMSpend',
      period: 86400,
      statistic: 'Maximum',
      threshold: 1,
      treatMissingData: 'notBreaching',
      alarmActions: ['alarm-topic'],
      tags: { Application: 'LLMSpend', Severity: 'Medium' },
    });
  });

  it('warns when the reconcile Lambda fails before it can publish', async () => {
    await load();
    expect(resources.alarm).toHaveBeenCalledWith('spendReconciliationErrors', {
      name: 'test-app-production-spend-reconciliation-errors',
      alarmDescription: expect.any(String),
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName: 'Errors',
      namespace: 'AWS/Lambda',
      period: 86400,
      statistic: 'Sum',
      threshold: 1,
      treatMissingData: 'notBreaching',
      dimensions: { FunctionName: 'reconcile-function' },
      alarmActions: ['alarm-topic'],
      tags: { Application: 'LLMSpend', Severity: 'Medium' },
    });
  });

  it('skips all three on a monitored preview, where the cron does not exist', async () => {
    vi.stubEnv('ENABLE_MONITORING', 'true');
    resources.reconcileCron = undefined;
    await load('preview');
    expect(callFor(resources.alarm, 'spendReconciliationDrift')).toBeUndefined();
    expect(callFor(resources.alarm, 'spendReconciliationNothingReconciled')).toBeUndefined();
    expect(callFor(resources.alarm, 'spendReconciliationErrors')).toBeUndefined();
  });

  it('publishes the metrics the alarms read, in the same namespace', () => {
    const worker = readFileSync(new URL('../../apps/workers/src/cron/spendReconciliation.ts', import.meta.url), 'utf8');
    expect(worker).toContain("MetricName: 'SpendReconciliationDrift'");
    expect(worker).toContain("MetricName: 'SpendReconciliationNothingReconciled'");
    expect(worker).toContain('Namespace: `${Resource.App.name}/${Resource.App.stage}/LLMSpend`');
  });
});

describe('provider spend dashboard', () => {
  it('charts provider-reported USD and unpriced tokens per hour', async () => {
    await load();
    const args = callFor(resources.dashboard, 'ProviderSpendDashboard') as
      { dashboardName: string; dashboardBody: { value: string } } | undefined;
    expect(args?.dashboardName).toBe('test-app-production-provider-spend');
    const { widgets } = JSON.parse(args!.dashboardBody.value) as {
      widgets: Array<{ properties: { title: string; period: number; metrics: unknown[][] } }>;
    };
    expect(widgets.map(w => w.properties.title)).toEqual([
      'Provider-reported USD per hour',
      'Unpriced output tokens per hour',
    ]);
    for (const widget of widgets) expect(widget.properties.period).toBe(3600);
    expect(widgets[0].properties.metrics).toEqual([
      ['test-app/production/LLMSpend', 'ProviderReportedUsd', 'Provider', 'anthropic', expect.any(Object)],
      ['test-app/production/LLMSpend', 'ProviderReportedUsd', 'Provider', 'openai', expect.any(Object)],
    ]);
  });
});

describe('provider spend stage gating', () => {
  it.each(['dev', 'production'])('creates resources on %s', async stage => {
    await load(stage);
    expect(resources.alarm).toHaveBeenCalledTimes(8);
    expect(resources.dashboard).toHaveBeenCalledTimes(1);
  });

  it('creates nothing on an unmonitored stage', async () => {
    await load('preview');
    expect(resources.alarm).not.toHaveBeenCalled();
    expect(resources.dashboard).not.toHaveBeenCalled();
  });

  it('skips poller alarms on a monitored preview, where the cron does not exist', async () => {
    vi.stubEnv('ENABLE_MONITORING', 'true');
    resources.cron = undefined;
    resources.reconcileCron = undefined;
    await load('preview');
    expect(callFor(resources.alarm, 'providerUsagePollErrors')).toBeUndefined();
    expect(callFor(resources.alarm, 'providerUsagePollSkipped-anthropic')).toBeUndefined();
    expect(callFor(resources.alarm, 'providerUsagePollSkipped-openai')).toBeUndefined();
    expect(resources.alarm).toHaveBeenCalledTimes(2);
    expect(callFor(resources.alarm, 'providerReportedSpendHourly-anthropic')).toBeDefined();
    expect(callFor(resources.alarm, 'providerReportedSpendHourly-openai')).toBeDefined();
    expect(resources.dashboard).toHaveBeenCalledTimes(1);
  });

  it('declares the env vars in the deploy contract and exports the module', () => {
    const contract = JSON.parse(readFileSync(new URL('../deploy-contract.json', import.meta.url), 'utf8'));
    expect(contract.deployEnv).toContain('PROVIDER_SPEND_ALARM_USD_PER_HOUR');
    expect(contract.deployEnv).toContain('PROVIDER_SPEND_ALARM_USD_PER_HOUR_ANTHROPIC');
    expect(readFileSync(new URL('../index.ts', import.meta.url), 'utf8')).toContain("export * from './providerSpend';");
  });

  it('alarms on the providers the poller publishes', async () => {
    const { PROVIDER_SPEND_PROVIDERS } = await load();
    const poller = readFileSync(new URL('../../apps/workers/src/cron/providerUsagePoll.ts', import.meta.url), 'utf8');
    for (const provider of PROVIDER_SPEND_PROVIDERS) expect(poller).toContain(`provider: '${provider}'`);
  });
});
