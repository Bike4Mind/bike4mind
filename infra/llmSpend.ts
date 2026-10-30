/**
 * Estimated upstream LLM spend from the ChatCompletion service's `llm-usage-settled` log line
 * (b4m-core/services/src/llm/llmUsageSettledLog.ts): metric filters, a dashboard, and a
 * 5-minute spend-rate alarm per provider (LLM_SPEND_ALARM_USD_PER_5MIN).
 * See infra/signup-code-send-alarm.md.
 */

import { chatCompletion } from './chatCompletion';
import { dlqAlarmTopic } from './dlqAlarms';
import { parseAlarmThreshold } from './signupAlarmThreshold';
import { isMonitoredStage as _isMonitoredStage } from '@bike4mind/infra';

const MONITORED_STAGES = ['dev', 'production'] as const;
const isMonitoredStage = _isMonitoredStage($app.stage, MONITORED_STAGES, process.env.ENABLE_MONITORING);

/** Must stay in sync with LLM_SPEND_PROVIDERS in llmUsageSettledLog.ts. */
export const LLM_SPEND_PROVIDERS = ['anthropic', 'openai', 'bedrock', 'google', 'other'] as const;
export const llmSpendNamespace = () => `${$app.name}/${$app.stage}/LLMSpend`;
export const LLM_SPEND_ALARM_USD_PER_5MIN_DEFAULT = 25;
export const YOUNG_ACCOUNT_SPEND_ALARM_USD_PER_HOUR_DEFAULT = 2;
const USAGE_MESSAGE = 'llm-usage-settled';

export function llmSpendFilterPattern(value: 'usd' | 'outputTokens', byModel = false): string {
  // CloudWatch only extracts fields selected by the pattern, including metric values/dimensions.
  const modelSelector = byModel ? ' && $.model = *' : '';
  return `{ $.message = "${USAGE_MESSAGE}" && $.provider = *${modelSelector} && $.${value} >= 0 }`;
}

export const LLM_SPEND_YOUNG_ACCOUNT_FILTER_PATTERN = `{ $.message = "${USAGE_MESSAGE}" && $.isYoungAccount IS TRUE && $.usd >= 0 }`;

const spendThreshold = parseAlarmThreshold(
  'LLM_SPEND_ALARM_USD_PER_5MIN',
  process.env.LLM_SPEND_ALARM_USD_PER_5MIN,
  LLM_SPEND_ALARM_USD_PER_5MIN_DEFAULT
);

const youngAccountSpendThreshold = parseAlarmThreshold(
  'YOUNG_ACCOUNT_SPEND_ALARM_USD_PER_HOUR',
  process.env.YOUNG_ACCOUNT_SPEND_ALARM_USD_PER_HOUR,
  YOUNG_ACCOUNT_SPEND_ALARM_USD_PER_HOUR_DEFAULT
);

let llmSpendDashboard: aws.cloudwatch.Dashboard | undefined;

if (isMonitoredStage) {
  if (!dlqAlarmTopic) {
    throw new Error('alarm routing requires dlqAlarmTopic');
  }

  // Same resolution as logMonitor.ts: SST does not expose the container log group as a node.
  const logGroupName = chatCompletion.nodes.taskDefinition
    .apply(taskDefinition => taskDefinition.containerDefinitions)
    .apply(json => {
      const containerDefinitions = JSON.parse(json) as Array<{
        logConfiguration?: { options?: Record<string, string> };
      }>;
      const name = containerDefinitions[0]?.logConfiguration?.options?.['awslogs-group'];
      if (!name) throw new Error('Could not resolve the ChatCompletion container log group from its task definition');
      return name;
    });

  const actions = [dlqAlarmTopic.arn];
  const spendAlarms: aws.cloudwatch.MetricAlarm[] = [];
  const prefix = `${$app.name}-${$app.stage}`;
  const LLM_SPEND_NAMESPACE = llmSpendNamespace();

  // One filter per metric: the Provider dimension is read from the log line, so every provider
  // lands in the same series set without a filter each.
  new aws.cloudwatch.LogMetricFilter('llmSpendUsdFilter', {
    name: `${prefix}-llm-spend-usd`,
    logGroupName,
    pattern: llmSpendFilterPattern('usd'),
    metricTransformation: {
      name: 'EstimatedUsd',
      namespace: LLM_SPEND_NAMESPACE,
      value: '$.usd',
      unit: 'None',
      dimensions: { Provider: '$.provider' },
    },
  });

  new aws.cloudwatch.LogMetricFilter('llmSpendTokensFilter', {
    name: `${prefix}-llm-spend-output-tokens`,
    logGroupName,
    pattern: llmSpendFilterPattern('outputTokens'),
    metricTransformation: {
      name: 'TokensOutput',
      namespace: LLM_SPEND_NAMESPACE,
      value: '$.outputTokens',
      unit: 'Count',
      dimensions: { Provider: '$.provider' },
    },
  });

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
  }

  // Model ids come from the model catalog, not the request, so this dimension stays bounded.
  new aws.cloudwatch.LogMetricFilter('llmSpendUsdByModelFilter', {
    name: `${prefix}-llm-spend-usd-by-model`,
    logGroupName,
    pattern: llmSpendFilterPattern('usd', true),
    metricTransformation: {
      name: 'EstimatedUsdByModel',
      namespace: LLM_SPEND_NAMESPACE,
      value: '$.usd',
      unit: 'None',
      dimensions: { Provider: '$.provider', Model: '$.model' },
    },
  });

  new aws.cloudwatch.LogMetricFilter('llmSpendYoungAccountUsdFilter', {
    name: `${prefix}-llm-spend-usd-young-accounts`,
    logGroupName,
    pattern: LLM_SPEND_YOUNG_ACCOUNT_FILTER_PATTERN,
    metricTransformation: {
      name: 'EstimatedUsdYoungAccounts',
      namespace: LLM_SPEND_NAMESPACE,
      value: '$.usd',
      unit: 'None',
    },
  });

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
            y: 9,
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
            y: 15,
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
            y: 21,
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
            y: 21,
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
