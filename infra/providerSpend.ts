/**
 * Provider-reported LLM spend: hourly alarms per provider on ProviderReportedUsd, which the
 * providerUsagePoll cron (infra/cron.ts) reads from each provider's own usage report, plus alarms
 * on the poller failing or skipping a provider, and a small dashboard. The ledger-derived twin is
 * infra/llmSpend.ts. Also alarms on the nightly spend reconciliation (spendReconciliationCron) drifting
 * from the provider's billing or reconciling nothing.
 */

import { providerUsagePollCron, spendReconciliationCron } from './cron';
import { dlqAlarmTopic, oobAlarmTopic } from './dlqAlarms';
import { parseAlarmThreshold } from './signupAlarmThreshold';
import { isMonitoredStage as _isMonitoredStage } from '@bike4mind/infra';

const MONITORED_STAGES = ['dev', 'production'] as const;
const isMonitoredStage = _isMonitoredStage($app.stage, MONITORED_STAGES, process.env.ENABLE_MONITORING);

/** Must stay in sync with PROVIDERS in apps/workers/src/cron/providerUsagePoll.ts. */
export const PROVIDER_SPEND_PROVIDERS = ['anthropic', 'openai'] as const;
export const PROVIDER_SPEND_ALARM_USD_PER_HOUR_DEFAULT = 25;
export const PROVIDER_SPEND_ALARM_USD_PER_HOUR_ANTHROPIC_DEFAULT = 90;

const providerSpendThresholds: Record<(typeof PROVIDER_SPEND_PROVIDERS)[number], number> = {
  anthropic: parseAlarmThreshold(
    'PROVIDER_SPEND_ALARM_USD_PER_HOUR_ANTHROPIC',
    process.env.PROVIDER_SPEND_ALARM_USD_PER_HOUR_ANTHROPIC,
    PROVIDER_SPEND_ALARM_USD_PER_HOUR_ANTHROPIC_DEFAULT
  ),
  openai: parseAlarmThreshold(
    'PROVIDER_SPEND_ALARM_USD_PER_HOUR',
    process.env.PROVIDER_SPEND_ALARM_USD_PER_HOUR,
    PROVIDER_SPEND_ALARM_USD_PER_HOUR_DEFAULT
  ),
};

let providerSpendDashboard: aws.cloudwatch.Dashboard | undefined;

if (isMonitoredStage) {
  if (!dlqAlarmTopic || !oobAlarmTopic) {
    throw new Error('alarm routing requires dlqAlarmTopic and oobAlarmTopic');
  }

  const actions = [dlqAlarmTopic.arn, oobAlarmTopic.arn];
  const prefix = `${$app.name}-${$app.stage}`;
  // Must match llmSpendNamespace() in llmSpend.ts and the poller; inlined so importing this module
  // does not also evaluate llmSpend.ts.
  const LLM_SPEND_NAMESPACE = `${$app.name}/${$app.stage}/LLMSpend`;

  for (const provider of PROVIDER_SPEND_PROVIDERS) {
    new aws.cloudwatch.MetricAlarm(`providerReportedSpendHourly-${provider}`, {
      name: `${prefix}-provider-reported-spend-hourly-${provider}`,
      alarmDescription: `${provider} usage report for the last hour, priced with our model rates, at or above the configured USD ceiling`,
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName: 'ProviderReportedUsd',
      namespace: LLM_SPEND_NAMESPACE,
      dimensions: { Provider: provider },
      period: 3600,
      statistic: 'Sum',
      threshold: providerSpendThresholds[provider],
      treatMissingData: 'notBreaching',
      alarmActions: actions,
      okActions: actions,
      tags: { Application: 'LLMSpend', Severity: 'Critical' },
    });
  }

  // The cron only exists where scheduled jobs run, so a preview that opts in to monitoring has none.
  if (providerUsagePollCron) {
    // Fires on the ProviderUsagePollSkipped datum the poller publishes, in place of spend, for a
    // provider with no admin key.
    for (const provider of PROVIDER_SPEND_PROVIDERS) {
      new aws.cloudwatch.MetricAlarm(`providerUsagePollSkipped-${provider}`, {
        name: `${prefix}-provider-usage-poll-skipped-${provider}`,
        alarmDescription: `Usage poller skipped ${provider}: admin key not configured`,
        comparisonOperator: 'GreaterThanOrEqualToThreshold',
        evaluationPeriods: 1,
        metricName: 'ProviderUsagePollSkipped',
        namespace: LLM_SPEND_NAMESPACE,
        dimensions: { Provider: provider },
        period: 3600,
        statistic: 'Sum',
        threshold: 1,
        treatMissingData: 'notBreaching',
        alarmActions: [dlqAlarmTopic.arn],
        tags: { Application: 'LLMSpend', Severity: 'Medium' },
      });
    }

    new aws.cloudwatch.MetricAlarm('providerUsagePollErrors', {
      name: `${prefix}-provider-usage-poll-errors`,
      alarmDescription: 'The hourly provider usage poller failed, so the provider-reported spend alarms are blind',
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName: 'Errors',
      namespace: 'AWS/Lambda',
      period: 3600,
      statistic: 'Sum',
      threshold: 1,
      treatMissingData: 'notBreaching',
      dimensions: { FunctionName: providerUsagePollCron.nodes.function.name },
      alarmActions: [dlqAlarmTopic.arn],
      tags: { Application: 'LLMSpend', Severity: 'Medium' },
    });
  }

  if (spendReconciliationCron) {
    // SpendReconciliationDrift counts closed-month rows whose deltaPct exceeds
    // SPEND_RECONCILIATION_DRIFT_ALERT_PCT (@bike4mind/common), the banner's error band.
    new aws.cloudwatch.MetricAlarm('spendReconciliationDrift', {
      name: `${prefix}-spend-reconciliation-drift`,
      alarmDescription:
        "Nightly spend reconciliation: a provider's billed spend for the closed month differs from our internal COGS by more than the error band",
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName: 'SpendReconciliationDrift',
      namespace: LLM_SPEND_NAMESPACE,
      period: 86400,
      statistic: 'Maximum',
      threshold: 1,
      treatMissingData: 'notBreaching',
      // No okActions: the next day's empty bucket reads as OK before the 06:00 run, so a drift
      // that persists would post a recovery every night and page again each morning.
      alarmActions: actions,
      tags: { Application: 'LLMSpend', Severity: 'Critical' },
    });

    // Separate from drift: every provider-month was skipped or failed, so the run checked nothing.
    new aws.cloudwatch.MetricAlarm('spendReconciliationNothingReconciled', {
      name: `${prefix}-spend-reconciliation-nothing-reconciled`,
      alarmDescription:
        'Nightly spend reconciliation reconciled no provider-month: every provider was skipped or failed',
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName: 'SpendReconciliationNothingReconciled',
      namespace: LLM_SPEND_NAMESPACE,
      period: 86400,
      statistic: 'Maximum',
      threshold: 1,
      treatMissingData: 'notBreaching',
      alarmActions: [dlqAlarmTopic.arn],
      tags: { Application: 'LLMSpend', Severity: 'Medium' },
    });

    // A crash, timeout or failed publish never reaches the metrics above, so both would stay silent.
    new aws.cloudwatch.MetricAlarm('spendReconciliationErrors', {
      name: `${prefix}-spend-reconciliation-errors`,
      alarmDescription:
        'The nightly spend reconciliation Lambda failed, so the drift and nothing-reconciled alarms are blind',
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName: 'Errors',
      namespace: 'AWS/Lambda',
      period: 86400,
      statistic: 'Sum',
      threshold: 1,
      treatMissingData: 'notBreaching',
      dimensions: { FunctionName: spendReconciliationCron.nodes.function.name },
      alarmActions: [dlqAlarmTopic.arn],
      tags: { Application: 'LLMSpend', Severity: 'Medium' },
    });
  }

  const dashboardBody = aws.getRegionOutput().name.apply(region => {
    const byProvider = (metric: string) =>
      PROVIDER_SPEND_PROVIDERS.map(provider => [
        LLM_SPEND_NAMESPACE,
        metric,
        'Provider',
        provider,
        { stat: 'Sum', label: provider },
      ]);
    return JSON.stringify({
      widgets: [
        {
          type: 'metric',
          x: 0,
          y: 0,
          width: 12,
          height: 6,
          properties: {
            title: 'Provider-reported USD per hour',
            metrics: byProvider('ProviderReportedUsd'),
            view: 'timeSeries',
            region,
            period: 3600,
            yAxis: { left: { min: 0, label: 'USD' } },
          },
        },
        {
          type: 'metric',
          x: 12,
          y: 0,
          width: 12,
          height: 6,
          properties: {
            title: 'Unpriced output tokens per hour',
            metrics: byProvider('UnpricedOutputTokens'),
            view: 'timeSeries',
            region,
            period: 3600,
            yAxis: { left: { min: 0, label: 'Tokens' } },
          },
        },
      ],
    });
  });

  providerSpendDashboard = new aws.cloudwatch.Dashboard('ProviderSpendDashboard', {
    dashboardName: `${prefix}-provider-spend`,
    dashboardBody,
  });
}

export { providerSpendDashboard };
