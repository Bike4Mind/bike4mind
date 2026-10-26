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
  it.each(PROVIDERS)('extracts estimated USD and output tokens for %s', async provider => {
    await load();
    const pattern = `{ $.message = "llm-usage-settled" && $.provider = "${provider}" }`;
    expect(resources.filter).toHaveBeenCalledWith(`llmSpendUsdFilter-${provider}`, {
      name: `test-app-production-llm-spend-usd-${provider}`,
      logGroupName: expect.objectContaining({ value: 'chat-completion-logs' }),
      pattern,
      metricTransformation: {
        name: 'EstimatedUsd',
        namespace: 'test-app/production/LLMSpend',
        value: '$.usd',
        unit: 'None',
        dimensions: { Provider: '$.provider' },
      },
    });
    expect(resources.filter).toHaveBeenCalledWith(`llmSpendTokensFilter-${provider}`, {
      name: `test-app-production-llm-spend-output-tokens-${provider}`,
      logGroupName: expect.objectContaining({ value: 'chat-completion-logs' }),
      pattern,
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
      pattern: '{ $.message = "llm-usage-settled" }',
      metricTransformation: {
        name: 'EstimatedUsdByModel',
        value: '$.usd',
        dimensions: { Provider: '$.provider', Model: '$.model' },
      },
    });
    expect(callFor(resources.filter, 'llmSpendYoungAccountUsdFilter')).toMatchObject({
      pattern: '{ $.message = "llm-usage-settled" && $.isYoungAccount IS TRUE }',
      metricTransformation: {
        name: 'EstimatedUsdYoungAccounts',
        namespace: 'test-app/production/LLMSpend',
        value: '$.usd',
      },
    });
    expect(callFor(resources.filter, 'llmSpendYoungAccountUsdFilter')?.metricTransformation).not.toHaveProperty(
      'dimensions'
    );
    expect(resources.filter).toHaveBeenCalledTimes(PROVIDERS.length * 2 + 2);
  });

  it('keeps the provider list in sync with the log line', async () => {
    const { LLM_SPEND_PROVIDERS } = await load();
    const source = readFileSync(
      new URL('../../b4m-core/services/src/llm/llmUsageSettledLog.ts', import.meta.url),
      'utf8'
    );
    const quoted = LLM_SPEND_PROVIDERS.map(p => `'${p}'`).join(', ');
    expect(source).toContain(`LLM_SPEND_PROVIDERS = [${quoted}] as const`);
    expect(source).toContain("LLM_USAGE_SETTLED_MESSAGE = 'llm-usage-settled'");
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

  it('reads the configured ceiling', async () => {
    vi.stubEnv('LLM_SPEND_ALARM_USD_PER_5MIN', '60');
    await load();
    for (const [, args] of resources.alarm.mock.calls) expect(args.threshold).toBe(60);
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
      'Estimated USD today (UTC)',
      'Output tokens per 5 min by provider',
      'Young-account share of estimated USD (%)',
      'Estimated USD per 5 min by model',
      'Sign-in code sends and API key creations per 5 min',
      'WAF: sign-in code requests with hosting or bot signals per 5 min',
    ]);
    const byTitle = (title: string) => widgets.find(w => w.properties.title === title)!.properties;

    expect(byTitle('LLM Spend - Alarm Status').alarms).toEqual(PROVIDERS.map(p => `alarm-arn-llmSpendRate-${p}`));
    expect(byTitle('Estimated USD per 5 min by provider')).toMatchObject({ stacked: true, period: 300 });
    expect(byTitle('Estimated USD today (UTC)')).toMatchObject({ view: 'singleValue', period: 86400 });
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
    expect(resources.alarm).toHaveBeenCalledTimes(PROVIDERS.length);
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
    expect(readFileSync(new URL('../index.ts', import.meta.url), 'utf8')).toContain("export * from './llmSpend';");
  });
});
