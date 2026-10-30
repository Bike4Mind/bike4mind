// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const resources = vi.hoisted(() => {
  function output<T>(value: T) {
    return { value, apply: <Result>(callback: (input: T) => Result) => output(callback(value)) };
  }
  return {
    output,
    filter: vi.fn(function (_name: string, _args: Record<string, unknown>) {}),
    alarm: vi.fn(function (name: string, _args: Record<string, unknown>) {
      return { arn: output(`alarm-arn-${name}`) };
    }),
    dashboard: vi.fn(function (_name: string, _args: Record<string, unknown>) {}),
    containerDefinitions: JSON.stringify([
      { logConfiguration: { options: { 'awslogs-group': 'chat-completion-logs' } } },
    ]) as string,
    topic: { arn: 'alarm-topic' } as { arn: string } | undefined,
    oobTopic: { arn: 'email-topic' } as { arn: string } | undefined,
  };
});

vi.mock('../chatCompletion', () => ({
  chatCompletion: {
    nodes: {
      get taskDefinition() {
        return resources.output({ containerDefinitions: resources.containerDefinitions });
      },
    },
  },
}));
vi.mock('../dlqAlarms', () => ({
  get dlqAlarmTopic() {
    return resources.topic;
  },
  get oobAlarmTopic() {
    return resources.oobTopic;
  },
}));
vi.mock('@bike4mind/infra', () => import('../../b4m-core/infra/src/stageGating'));
vi.mock('@bike4mind/observability', () => import('../../b4m-core/observability/src/index'));

const PROVIDERS = ['anthropic', 'openai', 'bedrock', 'google', 'other'];

function callFor(mock: typeof resources.filter, name: string): Record<string, unknown> | undefined {
  return mock.mock.calls.find(([logicalName]) => logicalName === name)?.[1];
}

async function load(stage = 'production', appName = 'test-app') {
  vi.resetModules();
  vi.stubGlobal('$app', { name: appName, stage });
  return import('../llmSpend');
}

function dashboardBody(): { widgets: Array<{ type: string; properties: Record<string, unknown> }> } {
  const args = resources.dashboard.mock.calls[0]?.[1] as { dashboardBody: { value: string } } | undefined;
  if (!args) throw new Error('dashboard not created');
  return JSON.parse(args.dashboardBody.value);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ENABLE_MONITORING', undefined);
  vi.stubEnv('LLM_SPEND_ALARM_USD_PER_5MIN', undefined);
  vi.stubEnv('LLM_SPEND_ALARM_USD_PER_HOUR', undefined);
  vi.stubEnv('LLM_SPEND_ALARM_USD_PER_HOUR_ANTHROPIC', undefined);
  vi.stubEnv('YOUNG_ACCOUNT_SPEND_ALARM_USD_PER_HOUR', undefined);
  vi.stubGlobal('aws', {
    cloudwatch: {
      LogMetricFilter: resources.filter,
      MetricAlarm: resources.alarm,
      Dashboard: resources.dashboard,
    },
    getRegionOutput: () => ({ name: resources.output('us-east-2') }),
  });
  vi.stubGlobal('$util', {
    all: (values: Array<{ value: unknown }>) => resources.output(values.map(v => v.value)),
  });
  resources.containerDefinitions = JSON.stringify([
    { logConfiguration: { options: { 'awslogs-group': 'chat-completion-logs' } } },
  ]);
  resources.topic = { arn: 'alarm-topic' };
  resources.oobTopic = { arn: 'email-topic' };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('LLM spend metric filters', () => {
  it('extracts estimated USD and output tokens with the provider as a dimension', async () => {
    await load();
    const pattern = (field: string) => `{ $.message = "llm-usage-settled" && $.provider = * && $.${field} >= 0 }`;
    expect(resources.filter).toHaveBeenCalledWith('llmSpendUsdFilter', {
      name: 'test-app-production-llm-spend-usd',
      logGroupName: expect.objectContaining({ value: 'chat-completion-logs' }),
      pattern: pattern('usd'),
      metricTransformation: {
        name: 'EstimatedUsd',
        namespace: 'test-app/production/LLMSpend',
        value: '$.usd',
        unit: 'None',
        dimensions: { Provider: '$.provider' },
      },
    });
    expect(resources.filter).toHaveBeenCalledWith('llmSpendTokensFilter', {
      name: 'test-app-production-llm-spend-output-tokens',
      logGroupName: expect.objectContaining({ value: 'chat-completion-logs' }),
      pattern: pattern('outputTokens'),
      metricTransformation: {
        name: 'TokensOutput',
        namespace: 'test-app/production/LLMSpend',
        value: '$.outputTokens',
        unit: 'Count',
        dimensions: { Provider: '$.provider' },
      },
    });
  });

  it('breaks spend down by model and counts the young-account share', async () => {
    await load();
    expect(callFor(resources.filter, 'llmSpendUsdByModelFilter')).toMatchObject({
      pattern: '{ $.message = "llm-usage-settled" && $.provider = * && $.model = * && $.usd >= 0 }',
      metricTransformation: {
        name: 'EstimatedUsdByModel',
        value: '$.usd',
        dimensions: { Provider: '$.provider', Model: '$.model' },
      },
    });
    expect(callFor(resources.filter, 'llmSpendYoungAccountUsdFilter')).toMatchObject({
      pattern: '{ $.message = "llm-usage-settled" && $.isYoungAccount IS TRUE && $.usd >= 0 }',
      metricTransformation: {
        name: 'EstimatedUsdYoungAccounts',
        namespace: 'test-app/production/LLMSpend',
        value: '$.usd',
      },
    });
    expect(callFor(resources.filter, 'llmSpendYoungAccountUsdFilter')?.metricTransformation).not.toHaveProperty(
      'dimensions'
    );
    expect(resources.filter).toHaveBeenCalledTimes(4);
  });

  it('selects every extracted metric value and dimension in the CloudWatch pattern', async () => {
    await load();
    for (const [, args] of resources.filter.mock.calls) {
      const transformation = args.metricTransformation as { value: string; dimensions?: Record<string, string> };
      const selectors = [transformation.value, ...Object.values(transformation.dimensions ?? {})];
      const pattern = String(args.pattern);
      for (const selector of selectors) {
        // Match a complete selector, so $.model cannot be satisfied by $.modelName.
        expect(pattern).toMatch(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(?:=|>=)`));
      }
    }
  });

  it('keeps the provider list in sync with the log line', async () => {
    const { LLM_SPEND_PROVIDERS } = await load();
    const log = await import('../../b4m-core/services/src/llm/llmUsageSettledLog');
    expect(LLM_SPEND_PROVIDERS).toEqual(log.LLM_SPEND_PROVIDERS);
    expect(log.LLM_USAGE_SETTLED_MESSAGE).toBe('llm-usage-settled');
  });
});

describe('LLM spend alarms', () => {
  it.each(PROVIDERS)('alarms on 5-minute %s spend and routes ALARM and OK to Slack and email', async provider => {
    await load();
    expect(resources.alarm).toHaveBeenCalledWith(`llmSpendRate-${provider}`, {
      name: `test-app-production-llm-spend-rate-${provider}`,
      alarmDescription: expect.any(String),
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName: 'EstimatedUsd',
      namespace: 'test-app/production/LLMSpend',
      dimensions: { Provider: provider },
      period: 300,
      statistic: 'Sum',
      threshold: 25,
      treatMissingData: 'notBreaching',
      alarmActions: ['alarm-topic', 'email-topic'],
      okActions: ['alarm-topic', 'email-topic'],
      tags: { Application: 'LLMSpend', Severity: 'High' },
    });
  });

  it.each([
    ['anthropic', 75],
    ['openai', 20],
  ])('pages on hourly %s spend at a ceiling of %i USD', async (provider, threshold) => {
    await load();
    expect(resources.alarm).toHaveBeenCalledWith(`llmSpendHourly-${provider}`, {
      name: `test-app-production-llm-spend-hourly-${provider}`,
      alarmDescription: `Estimated ${provider} LLM spend in one hour at or above the configured USD ceiling`,
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName: 'EstimatedUsd',
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
  });

  it('alarms on hourly spend by accounts under 7 days old', async () => {
    await load();
    expect(resources.alarm).toHaveBeenCalledWith('youngAccountSpendRate', {
      name: 'test-app-production-young-account-spend-rate',
      alarmDescription:
        'Estimated LLM spend per hour by accounts under 7 days old at or above the configured USD ceiling',
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName: 'EstimatedUsdYoungAccounts',
      namespace: 'test-app/production/LLMSpend',
      period: 3600,
      statistic: 'Sum',
      threshold: 2,
      treatMissingData: 'notBreaching',
      alarmActions: ['alarm-topic', 'email-topic'],
      okActions: ['alarm-topic', 'email-topic'],
      tags: { Application: 'LLMSpend', Severity: 'High' },
    });
  });

  it('reads the configured ceilings', async () => {
    vi.stubEnv('LLM_SPEND_ALARM_USD_PER_5MIN', '60');
    vi.stubEnv('YOUNG_ACCOUNT_SPEND_ALARM_USD_PER_HOUR', '9');
    vi.stubEnv('LLM_SPEND_ALARM_USD_PER_HOUR', '30');
    vi.stubEnv('LLM_SPEND_ALARM_USD_PER_HOUR_ANTHROPIC', '90');
    await load();
    const expected = (name: string) => {
      if (name === 'youngAccountSpendRate') return 9;
      if (name === 'llmSpendHourly-anthropic') return 90;
      if (name.startsWith('llmSpendHourly-')) return 30;
      return 60;
    };
    for (const [name, args] of resources.alarm.mock.calls) expect(args.threshold).toBe(expected(name));
  });

  it.each([
    ['LLM_SPEND_ALARM_USD_PER_HOUR', '0'],
    ['LLM_SPEND_ALARM_USD_PER_HOUR_ANTHROPIC', '1.5'],
  ])('rejects a malformed hourly ceiling %s=%s', async (name, raw) => {
    vi.stubEnv(name, raw);
    await expect(load()).rejects.toThrow(new RegExp(name));
  });

  it('rejects a malformed young-account ceiling', async () => {
    vi.stubEnv('YOUNG_ACCOUNT_SPEND_ALARM_USD_PER_HOUR', '0');
    await expect(load()).rejects.toThrow(/YOUNG_ACCOUNT_SPEND_ALARM_USD_PER_HOUR/);
  });

  it.each(['0', '2.5', 'abc'])('rejects a malformed ceiling %s', async raw => {
    vi.stubEnv('LLM_SPEND_ALARM_USD_PER_5MIN', raw);
    await expect(load()).rejects.toThrow(/LLM_SPEND_ALARM_USD_PER_5MIN/);
  });

  it('fails loudly when alarm routing is missing', async () => {
    resources.oobTopic = undefined;
    await expect(load()).rejects.toThrow('alarm routing requires dlqAlarmTopic and oobAlarmTopic');
  });

  it('fails loudly when the ChatCompletion log group cannot be resolved', async () => {
    resources.containerDefinitions = JSON.stringify([{}]);
    await expect(load()).rejects.toThrow('ChatCompletion container log group');
  });
});

describe('LLM spend dashboard', () => {
  it('shows spend, tokens, young-account share, signup and WAF edge signals', async () => {
    await load();
    expect(callFor(resources.dashboard, 'LlmSpendDashboard')).toMatchObject({
      dashboardName: 'test-app-production-llm-spend',
    });
    const { widgets } = dashboardBody();
    const titles = widgets.map(w => w.properties.title);
    expect(titles).toEqual([
      'LLM Spend - Alarm Status',
      'Estimated USD per 5 min by provider',
      'Estimated USD in selected range',
      'Estimated USD per hour by provider',
      'Output tokens per 5 min by provider',
      'Young-account share of estimated USD (%)',
      'Estimated USD per 5 min by model',
      'Sign-in code sends and API key creations per 5 min',
      'WAF: sign-in code requests with hosting or bot signals per 5 min',
    ]);
    const byTitle = (title: string) => widgets.find(w => w.properties.title === title)!.properties;

    expect(byTitle('LLM Spend - Alarm Status').alarms).toEqual(
      PROVIDERS.flatMap(p => [`alarm-arn-llmSpendRate-${p}`, `alarm-arn-llmSpendHourly-${p}`])
    );
    expect(byTitle('Estimated USD per 5 min by provider')).toMatchObject({ stacked: true, period: 300 });
    expect(byTitle('Estimated USD per hour by provider')).toMatchObject({
      stacked: true,
      period: 3600,
      annotations: {
        horizontal: [
          { label: 'Hourly alarm (anthropic)', value: 75 },
          { label: 'Hourly alarm (other providers)', value: 20 },
        ],
      },
    });
    expect(byTitle('Estimated USD in selected range')).toMatchObject({
      view: 'singleValue',
      period: 300,
      setPeriodToTimeRange: true,
    });
    expect(JSON.stringify(byTitle('Young-account share of estimated USD (%)').metrics)).toContain(
      'EstimatedUsdYoungAccounts'
    );
    expect(byTitle('Sign-in code sends and API key creations per 5 min').metrics).toEqual([
      ['test-app/production/Signup', 'SignupCodeSends', expect.any(Object)],
      ['test-app/production/Signup', 'ApiKeyCreations', expect.any(Object)],
    ]);
    expect(byTitle('WAF: sign-in code requests with hosting or bot signals per 5 min')).toMatchObject({
      region: 'us-east-1',
      metrics: [['test-app/production/Signup', 'OtcEdgeSignalRequests', expect.any(Object)]],
    });
  });
});

describe('LLM spend stage gating', () => {
  it.each(['dev', 'production'])('creates resources on %s', async stage => {
    await load(stage);
    expect(resources.alarm).toHaveBeenCalledTimes(PROVIDERS.length * 2 + 1);
    expect(resources.dashboard).toHaveBeenCalledTimes(1);
  });
  it('creates nothing on an unmonitored stage', async () => {
    await load('preview');
    expect(resources.filter).not.toHaveBeenCalled();
    expect(resources.alarm).not.toHaveBeenCalled();
    expect(resources.dashboard).not.toHaveBeenCalled();
  });
  it('allows a preview to opt in to monitoring', async () => {
    vi.stubEnv('ENABLE_MONITORING', 'true');
    await load('preview');
    expect(resources.dashboard).toHaveBeenCalledTimes(1);
  });
  it('declares the env var in the deploy contract and exports the module', () => {
    const contract = JSON.parse(readFileSync(new URL('../deploy-contract.json', import.meta.url), 'utf8'));
    expect(contract.deployEnv).toContain('LLM_SPEND_ALARM_USD_PER_5MIN');
    expect(contract.deployEnv).toContain('LLM_SPEND_ALARM_USD_PER_HOUR');
    expect(contract.deployEnv).toContain('LLM_SPEND_ALARM_USD_PER_HOUR_ANTHROPIC');
    expect(contract.deployEnv).toContain('YOUNG_ACCOUNT_SPEND_ALARM_USD_PER_HOUR');
    expect(readFileSync(new URL('../index.ts', import.meta.url), 'utf8')).toContain("export * from './llmSpend';");
  });
});
