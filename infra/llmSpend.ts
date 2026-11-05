/**
 * Estimated upstream LLM spend from the `llm-usage-settled` log line
 * (b4m-core/services/src/llm/llmUsageSettledLog.ts) of the ChatCompletion service and the
 * `cli_completion_request` WebSocket route: metric filters, a dashboard, and a
 * 5-minute spend-rate alarm and an hourly spend alarm per provider (LLM_SPEND_ALARM_USD_PER_5MIN,
 * LLM_SPEND_ALARM_USD_PER_HOUR, LLM_SPEND_ALARM_USD_PER_HOUR_ANTHROPIC) plus hourly and 5-minute
 * ceilings on young-account spend, and a count of completions that cost more than the balance could pay.
 * See infra/signup-code-send-alarm.md.
 */

import { dlqAlarmTopic } from './dlqAlarms';
import { parseAlarmThreshold } from './signupAlarmThreshold';
import { llmSpendLogSources, type LlmSpendLogSource } from './llmSpendLogGroups';
import { isMonitoredStage as _isMonitoredStage } from '@bike4mind/infra';

const MONITORED_STAGES = ['dev', 'production'] as const;
const isMonitoredStage = _isMonitoredStage($app.stage, MONITORED_STAGES, process.env.ENABLE_MONITORING);

/** Must stay in sync with LLM_SPEND_PROVIDERS in llmUsageSettledLog.ts. */
export const LLM_SPEND_PROVIDERS = ['anthropic', 'openai', 'bedrock', 'google', 'other'] as const;
export const llmSpendNamespace = () => `${$app.name}/${$app.stage}/LLMSpend`;
export const LLM_SPEND_ALARM_USD_PER_5MIN_DEFAULT = 25;
export const LLM_SPEND_ALARM_USD_PER_HOUR_DEFAULT = 20;
export const LLM_SPEND_ALARM_USD_PER_HOUR_ANTHROPIC_DEFAULT = 75;
// Ordinary new-user use peaks around 2 USD per rolling hour; 5 leaves headroom.
export const YOUNG_ACCOUNT_SPEND_ALARM_USD_PER_HOUR_DEFAULT = 5;
export const LLM_SPEND_YOUNG_ACCOUNT_ALARM_USD_PER_5MIN_DEFAULT = 3;
const USAGE_MESSAGE = 'llm-usage-settled';
/** Must stay in sync with the charged-down-to-zero log line in b4m-core/services/src/cliCompletions.ts. */
export const COMPLETION_CREDIT_OVERDRAFT_MESSAGE =
  '[CLI_CREDITS] ALERT: Completion cost more than the balance could pay - charged down to zero';
/** Must stay in sync with warnOnSettlementDebt in b4m-core/services/src/llm/ChatCompletionProcess.ts (web chat). */
export const SETTLEMENT_DEBT_MESSAGE =
  '[BILLING_SHORTFALL_DEBT] Settlement exceeded the balance; holder owes credits until topped up';
/** Every log line that means a completion cost more than its holder's balance could pay. */
export const COMPLETION_CREDIT_OVERDRAFT_MESSAGES = [
  COMPLETION_CREDIT_OVERDRAFT_MESSAGE,
  SETTLEMENT_DEBT_MESSAGE,
] as const;

export function llmSpendFilterPattern(value: 'usd' | 'outputTokens', byModel = false): string {
  // CloudWatch only extracts fields selected by the pattern, including metric values/dimensions.
  const modelSelector = byModel ? ' && $.model = *' : '';
  return `{ $.message = "${USAGE_MESSAGE}" && $.provider = *${modelSelector} && $.${value} >= 0 }`;
}

export const LLM_SPEND_YOUNG_ACCOUNT_FILTER_PATTERN = `{ $.message = "${USAGE_MESSAGE}" && $.isYoungAccount IS TRUE && $.usd >= 0 }`;
export const COMPLETION_CREDIT_OVERDRAFT_FILTER_PATTERN = `{ ${COMPLETION_CREDIT_OVERDRAFT_MESSAGES.map(message => `$.message = "${message}"`).join(' || ')} }`;

const spendThreshold = parseAlarmThreshold(
  'LLM_SPEND_ALARM_USD_PER_5MIN',
  process.env.LLM_SPEND_ALARM_USD_PER_5MIN,
  LLM_SPEND_ALARM_USD_PER_5MIN_DEFAULT
);

const hourlySpendThreshold = parseAlarmThreshold(
  'LLM_SPEND_ALARM_USD_PER_HOUR',
  process.env.LLM_SPEND_ALARM_USD_PER_HOUR,
  LLM_SPEND_ALARM_USD_PER_HOUR_DEFAULT
);

const hourlyAnthropicSpendThreshold = parseAlarmThreshold(
  'LLM_SPEND_ALARM_USD_PER_HOUR_ANTHROPIC',
  process.env.LLM_SPEND_ALARM_USD_PER_HOUR_ANTHROPIC,
  LLM_SPEND_ALARM_USD_PER_HOUR_ANTHROPIC_DEFAULT
);

const youngAccountSpendThreshold = parseAlarmThreshold(
  'YOUNG_ACCOUNT_SPEND_ALARM_USD_PER_HOUR',
  process.env.YOUNG_ACCOUNT_SPEND_ALARM_USD_PER_HOUR,
  YOUNG_ACCOUNT_SPEND_ALARM_USD_PER_HOUR_DEFAULT
);

const youngAccountSpendBurstThreshold = parseAlarmThreshold(
  'LLM_SPEND_YOUNG_ACCOUNT_ALARM_USD_PER_5MIN',
  process.env.LLM_SPEND_YOUNG_ACCOUNT_ALARM_USD_PER_5MIN,
  LLM_SPEND_YOUNG_ACCOUNT_ALARM_USD_PER_5MIN_DEFAULT
);

function createLlmSpendFilters({ key, logGroupName }: LlmSpendLogSource, prefix: string, namespace: string): void {
  const logicalName = (base: string) => (key ? `${base}-${key}` : base);
  const name = (suffix: string) => (key ? `${prefix}-${key}-${suffix}` : `${prefix}-${suffix}`);

  // One filter per metric: the Provider dimension is read from the log line, so every provider
  // lands in the same series set without a filter each.
  new aws.cloudwatch.LogMetricFilter(logicalName('llmSpendUsdFilter'), {
    name: name('llm-spend-usd'),
    logGroupName,
    pattern: llmSpendFilterPattern('usd'),
    metricTransformation: {
      name: 'EstimatedUsd',
      namespace,
      value: '$.usd',
      unit: 'None',
      dimensions: { Provider: '$.provider' },
    },
  });

  new aws.cloudwatch.LogMetricFilter(logicalName('llmSpendTokensFilter'), {
    name: name('llm-spend-output-tokens'),
    logGroupName,
    pattern: llmSpendFilterPattern('outputTokens'),
    metricTransformation: {
      name: 'TokensOutput',
      namespace,
      value: '$.outputTokens',
      unit: 'Count',
      dimensions: { Provider: '$.provider' },
    },
  });

  // Model ids come from the model catalog, not the request, so this dimension stays bounded.
  new aws.cloudwatch.LogMetricFilter(logicalName('llmSpendUsdByModelFilter'), {
    name: name('llm-spend-usd-by-model'),
    logGroupName,
    pattern: llmSpendFilterPattern('usd', true),
    metricTransformation: {
      name: 'EstimatedUsdByModel',
      namespace,
      value: '$.usd',
      unit: 'None',
      dimensions: { Provider: '$.provider', Model: '$.model' },
    },
  });

  new aws.cloudwatch.LogMetricFilter(logicalName('llmSpendYoungAccountUsdFilter'), {
    name: name('llm-spend-usd-young-accounts'),
    logGroupName,
    pattern: LLM_SPEND_YOUNG_ACCOUNT_FILTER_PATTERN,
    metricTransformation: {
      name: 'EstimatedUsdYoungAccounts',
      namespace,
      value: '$.usd',
      unit: 'None',
    },
  });

  new aws.cloudwatch.LogMetricFilter(logicalName('completionCreditOverdraftFilter'), {
    name: name('completion-credit-overdraft'),
    logGroupName,
    pattern: COMPLETION_CREDIT_OVERDRAFT_FILTER_PATTERN,
    metricTransformation: {
      name: 'CompletionCreditOverdrafts',
      namespace,
      value: '1',
      unit: 'Count',
    },
  });
}

let llmSpendDashboard: aws.cloudwatch.Dashboard | undefined;

if (isMonitoredStage) {
  if (!dlqAlarmTopic) {
    throw new Error('alarm routing requires dlqAlarmTopic');
  }

  const actions = [dlqAlarmTopic.arn];
  const spendAlarms: aws.cloudwatch.MetricAlarm[] = [];
  const prefix = `${$app.name}-${$app.stage}`;
  const LLM_SPEND_NAMESPACE = llmSpendNamespace();

  for (const source of llmSpendLogSources()) {
    createLlmSpendFilters(source, prefix, LLM_SPEND_NAMESPACE);
  }

  // Two windows: the 5-minute alarm catches a runaway burst; the hourly one catches a sustained
  // drain that stays under the burst ceiling.
  for (const provider of LLM_SPEND_PROVIDERS) {
    spendAlarms.push(
      new aws.cloudwatch.MetricAlarm(`llmSpendRate-${provider}`, {
        name: `${prefix}-llm-spend-rate-${provider}`,
        alarmDescription: `Estimated ${provider} LLM spend per 5 minutes at or above the configured USD ceiling`,
        comparisonOperator: 'GreaterThanOrEqualToThreshold',
        evaluationPeriods: 1,
        metricName: 'EstimatedUsd',
        namespace: LLM_SPEND_NAMESPACE,
        dimensions: { Provider: provider },
        period: 300,
        statistic: 'Sum',
        threshold: spendThreshold,
        treatMissingData: 'notBreaching',
        alarmActions: actions,
        okActions: actions,
        tags: { Application: 'LLMSpend', Severity: 'High' },
      })
    );
    spendAlarms.push(
      new aws.cloudwatch.MetricAlarm(`llmSpendHourly-${provider}`, {
        name: `${prefix}-llm-spend-hourly-${provider}`,
        alarmDescription: `Estimated ${provider} LLM spend in one hour at or above the configured USD ceiling`,
        comparisonOperator: 'GreaterThanOrEqualToThreshold',
        evaluationPeriods: 1,
        metricName: 'EstimatedUsd',
        namespace: LLM_SPEND_NAMESPACE,
        dimensions: { Provider: provider },
        period: 3600,
        statistic: 'Sum',
        threshold: provider === 'anthropic' ? hourlyAnthropicSpendThreshold : hourlySpendThreshold,
        treatMissingData: 'notBreaching',
        alarmActions: actions,
        okActions: actions,
        tags: { Application: 'LLMSpend', Severity: 'Critical' },
      })
    );
  }

  new aws.cloudwatch.MetricAlarm('youngAccountSpendRate', {
    name: `${prefix}-young-account-spend-rate`,
    alarmDescription:
      'Estimated LLM spend per hour by accounts under 7 days old at or above the configured USD ceiling',
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 1,
    metricName: 'EstimatedUsdYoungAccounts',
    namespace: LLM_SPEND_NAMESPACE,
    period: 3600,
    statistic: 'Sum',
    threshold: youngAccountSpendThreshold,
    treatMissingData: 'notBreaching',
    alarmActions: actions,
    okActions: actions,
    tags: { Application: 'LLMSpend', Severity: 'High' },
  });

  new aws.cloudwatch.MetricAlarm('llmSpendYoungAccounts', {
    name: `${prefix}-llm-spend-young-accounts`,
    alarmDescription:
      'Estimated LLM spend per 5 minutes by accounts under 7 days old at or above the configured USD ceiling',
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 1,
    metricName: 'EstimatedUsdYoungAccounts',
    namespace: LLM_SPEND_NAMESPACE,
    period: 300,
    statistic: 'Sum',
    threshold: youngAccountSpendBurstThreshold,
    treatMissingData: 'notBreaching',
    alarmActions: actions,
    okActions: actions,
    tags: { Application: 'LLMSpend', Severity: 'High' },
  });

  new aws.cloudwatch.MetricAlarm('completionCreditOverdraft', {
    name: `${prefix}-completion-credit-overdraft`,
    alarmDescription:
      'A completion cost more credits than its holder had (CLI: charged down to zero; web chat: balance left negative)',
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 1,
    metricName: 'CompletionCreditOverdrafts',
    namespace: LLM_SPEND_NAMESPACE,
    period: 300,
    statistic: 'Sum',
    threshold: 1,
    treatMissingData: 'notBreaching',
    alarmActions: [dlqAlarmTopic.arn],
    okActions: [dlqAlarmTopic.arn],
    tags: { Application: 'LLMSpend', Severity: 'Medium' },
  });

  // Emitted by signupAlarms.ts (default region) and waf.ts (us-east-1, production with WAF only).
  const signupNamespace = `${$app.name}/${$app.stage}/Signup`;

  const dashboardBody = $util
    .all([aws.getRegionOutput().name, $util.all(spendAlarms.map(alarm => alarm.arn))])
    .apply(([region, alarmArns]) => {
      const providerMetrics = (metric: string, stat: string) =>
        LLM_SPEND_PROVIDERS.map((provider, i) => [
          LLM_SPEND_NAMESPACE,
          metric,
          'Provider',
          provider,
          { stat, label: provider, id: `p${i}` },
        ]);
      const providerSum = LLM_SPEND_PROVIDERS.map((_, i) => `FILL(p${i}, 0)`).join(' + ');

      return JSON.stringify({
        widgets: [
          {
            type: 'alarm',
            x: 0,
            y: 0,
            width: 24,
            height: 3,
            properties: {
              title: 'LLM Spend - Alarm Status',
              alarms: alarmArns,
            },
          },
          {
            type: 'metric',
            x: 0,
            y: 3,
            width: 18,
            height: 6,
            properties: {
              title: 'Estimated USD per 5 min by provider',
              metrics: providerMetrics('EstimatedUsd', 'Sum'),
              view: 'timeSeries',
              stacked: true,
              region,
              period: 300,
              yAxis: { left: { min: 0, label: 'USD' } },
              annotations: { horizontal: [{ label: 'Per-provider alarm', value: spendThreshold }] },
            },
          },
          {
            type: 'metric',
            x: 18,
            y: 3,
            width: 6,
            height: 6,
            properties: {
              title: 'Estimated USD in selected range',
              metrics: [
                [{ expression: providerSum, label: 'Total', id: 'total' }],
                ...providerMetrics('EstimatedUsd', 'Sum'),
              ],
              view: 'singleValue',
              region,
              period: 300,
              setPeriodToTimeRange: true,
            },
          },
          {
            type: 'metric',
            x: 0,
            y: 9,
            width: 24,
            height: 6,
            properties: {
              title: 'Estimated USD per hour by provider',
              metrics: providerMetrics('EstimatedUsd', 'Sum'),
              view: 'timeSeries',
              stacked: true,
              region,
              period: 3600,
              yAxis: { left: { min: 0, label: 'USD' } },
              annotations: {
                horizontal: [
                  { label: 'Hourly alarm (anthropic)', value: hourlyAnthropicSpendThreshold },
                  { label: 'Hourly alarm (other providers)', value: hourlySpendThreshold },
                ],
              },
            },
          },
          {
            type: 'metric',
            x: 0,
            y: 15,
            width: 12,
            height: 6,
            properties: {
              title: 'Output tokens per 5 min by provider',
              metrics: providerMetrics('TokensOutput', 'Sum'),
              view: 'timeSeries',
              stacked: true,
              region,
              period: 300,
              yAxis: { left: { min: 0, label: 'Tokens' } },
            },
          },
          {
            type: 'metric',
            x: 12,
            y: 15,
            width: 12,
            height: 6,
            properties: {
              title: 'Young-account share of estimated USD (%)',
              metrics: [
                [{ expression: `100 * FILL(young, 0) / (${providerSum})`, label: 'Accounts < 7 days', id: 'share' }],
                [LLM_SPEND_NAMESPACE, 'EstimatedUsdYoungAccounts', { stat: 'Sum', id: 'young', visible: false }],
                ...providerMetrics('EstimatedUsd', 'Sum').map(([ns, metric, dim, value, opts]) => [
                  ns,
                  metric,
                  dim,
                  value,
                  { ...(opts as Record<string, unknown>), visible: false },
                ]),
              ],
              view: 'timeSeries',
              region,
              period: 300,
              yAxis: { left: { min: 0, max: 100, label: '%' } },
            },
          },
          {
            type: 'metric',
            x: 0,
            y: 21,
            width: 24,
            height: 6,
            properties: {
              title: 'Estimated USD per 5 min by model',
              metrics: [
                [
                  {
                    expression: `SEARCH('{${LLM_SPEND_NAMESPACE},Model,Provider} MetricName="EstimatedUsdByModel"', 'Sum', 300)`,
                    id: 'by_model',
                  },
                ],
              ],
              view: 'timeSeries',
              stacked: true,
              region,
              period: 300,
              yAxis: { left: { min: 0, label: 'USD' } },
            },
          },
          {
            type: 'metric',
            x: 0,
            y: 27,
            width: 12,
            height: 6,
            properties: {
              title: 'Sign-in code sends and API key creations per 5 min',
              metrics: [
                [signupNamespace, 'SignupCodeSends', { stat: 'Sum', label: 'Sign-in code sends' }],
                [signupNamespace, 'ApiKeyCreations', { stat: 'Sum', label: 'API keys created' }],
              ],
              view: 'timeSeries',
              region,
              period: 300,
              yAxis: { left: { min: 0, label: 'Count' } },
            },
          },
          {
            type: 'metric',
            x: 12,
            y: 27,
            width: 12,
            height: 6,
            properties: {
              title: 'WAF: sign-in code requests with hosting or bot signals per 5 min',
              metrics: [[signupNamespace, 'OtcEdgeSignalRequests', { stat: 'Sum', label: 'Edge-signal requests' }]],
              view: 'timeSeries',
              region: 'us-east-1',
              period: 300,
              yAxis: { left: { min: 0, label: 'Requests' } },
            },
          },
        ],
      });
    });

  llmSpendDashboard = new aws.cloudwatch.Dashboard('LlmSpendDashboard', {
    dashboardName: `${prefix}-llm-spend`,
    dashboardBody,
  });
}

export { llmSpendDashboard };
