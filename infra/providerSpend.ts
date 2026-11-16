/**
 * Provider-reported LLM spend: hourly alarms per provider on ProviderReportedUsd, which the
 * providerUsagePoll cron (infra/cron.ts) reads from each provider's own usage report, plus alarms
 * on the poller failing or skipping a provider, and a small dashboard. The ledger-derived twin is
 * infra/llmSpend.ts.
 *
 * Also holds the access policy and the access alarms for the provider admin key store
 * (infra/providerAdminKeys.ts) the two spend crons read.
 */

import { providerUsagePollCron, spendReconciliationCron } from './cron';
import { dlqAlarmTopic, oobAlarmTopic } from './dlqAlarms';
import {
  PROVIDER_ADMIN_KEY_PROVIDERS,
  providerAdminKeyChangeEventPattern,
  providerAdminKeyKmsEventPattern,
  providerAdminKeyLogsPolicy,
  providerAdminKeyReadEventPattern,
  providerAdminKeySecretPolicy,
  providerAdminKeyStore,
  type ProviderAdminKeyStore,
} from './providerAdminKeys';
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

// Names the access policy and the access rules need, resolved to plain strings.
function resolveAdminKeyStoreRefs(store: ProviderAdminKeyStore) {
  if (!providerUsagePollCron || !spendReconciliationCron) {
    throw new Error('the provider admin key store requires both spend crons');
  }
  return $resolve({
    readerRoleArns: [
      providerUsagePollCron.nodes.function.nodes.role.arn,
      spendReconciliationCron.nodes.function.nodes.role.arn,
    ],
    secrets: PROVIDER_ADMIN_KEY_PROVIDERS.map(provider => ({
      name: store.secrets[provider].name,
      arn: store.secrets[provider].arn,
    })),
    keyId: store.key.keyId,
    keyArn: store.key.arn,
  });
}

const adminKeyStore = providerAdminKeyStore && {
  store: providerAdminKeyStore,
  refs: resolveAdminKeyStoreRefs(providerAdminKeyStore),
};

if (adminKeyStore) {
  for (const provider of PROVIDER_ADMIN_KEY_PROVIDERS) {
    new aws.secretsmanager.SecretPolicy(`ProviderAdminKeySecretPolicy-${provider}`, {
      secretArn: adminKeyStore.store.secrets[provider].arn,
      policy: adminKeyStore.refs.apply(refs => JSON.stringify(providerAdminKeySecretPolicy(refs.readerRoleArns))),
      blockPublicPolicy: true,
    });
  }
}

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

  if (adminKeyStore) {
    // Matched events land here so the CloudTrail record of each access is kept.
    const accessLogGroup = new aws.cloudwatch.LogGroup('ProviderAdminKeyAccessLogs', {
      name: `/aws/events/${prefix}-provider-admin-key-access`,
      retentionInDays: 365,
    });

    new aws.cloudwatch.LogResourcePolicy('ProviderAdminKeyAccessLogsPolicy', {
      policyName: `${prefix}-provider-admin-key-access`,
      policyDocument: accessLogGroup.arn.apply(arn => JSON.stringify(providerAdminKeyLogsPolicy(arn))),
    });

    const accessRules = [
      {
        id: 'Read',
        name: `${prefix}-provider-admin-key-read`,
        description: 'A principal other than the spend crons read a provider admin key secret',
        alarmDescription: 'A principal other than the spend crons read a provider admin key secret',
        // Read-only management events reach a rule only in this state.
        state: 'ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS',
        pattern: adminKeyStore.refs.apply(refs =>
          JSON.stringify(
            providerAdminKeyReadEventPattern({ secrets: refs.secrets, allowedRoleArns: refs.readerRoleArns })
          )
        ),
      },
      {
        id: 'Change',
        name: `${prefix}-provider-admin-key-change`,
        description: 'A provider admin key secret or its policy was changed',
        alarmDescription: 'A provider admin key secret or its resource policy was changed',
        state: undefined,
        pattern: adminKeyStore.refs.apply(refs =>
          JSON.stringify(providerAdminKeyChangeEventPattern({ secrets: refs.secrets }))
        ),
      },
      {
        id: 'KmsChange',
        name: `${prefix}-provider-admin-key-kms-change`,
        description: 'The provider admin key store KMS key policy, grants or lifecycle changed',
        alarmDescription:
          'The KMS key that encrypts the provider admin key secrets had its policy, grants or lifecycle changed',
        state: undefined,
        pattern: adminKeyStore.refs.apply(refs =>
          JSON.stringify(providerAdminKeyKmsEventPattern({ keyId: refs.keyId, keyArn: refs.keyArn }))
        ),
      },
    ];

    for (const { id, name, description, alarmDescription, state, pattern } of accessRules) {
      const rule = new aws.cloudwatch.EventRule(`ProviderAdminKey${id}Rule`, {
        name,
        description,
        eventPattern: pattern,
        ...(state ? { state } : {}),
      });

      new aws.cloudwatch.EventTarget(`ProviderAdminKey${id}Target`, {
        rule: rule.name,
        arn: accessLogGroup.arn,
      });

      new aws.cloudwatch.MetricAlarm(`ProviderAdminKey${id}Alarm`, {
        name,
        alarmDescription,
        comparisonOperator: 'GreaterThanOrEqualToThreshold',
        evaluationPeriods: 1,
        metricName: 'MatchedEvents',
        namespace: 'AWS/Events',
        dimensions: { RuleName: name },
        period: 300,
        statistic: 'Sum',
        threshold: 1,
        treatMissingData: 'notBreaching',
        alarmActions: actions,
        tags: { Application: 'LLMSpend', Severity: 'Critical' },
      });
    }
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
