/**
 * Alarms when the Next.js server reports the Turnstile policy inactive on a deployed stage (event
 * `turnstile-policy-inactive` from apps/client/server/utils/auth/turnstile.ts, logged at most every
 * 5 minutes per container), so a stage that should be challenging sign-ins and is not gets noticed.
 * Also alarms on `turnstile-misconfigured` (apps/client/server/middlewares/requireTurnstile.ts), where
 * the challenge is on but rejects every request because the secret or hostname allowlist is wrong.
 */

import { web } from './web';
import { cardVerificationRecoveryLogGroup } from './cardVerificationRecovery';
import { dlqAlarmTopic, oobAlarmTopic } from './dlqAlarms';
import { messageFilterPattern } from './logMessageFilterPattern';
import { isMonitoredStage as _isMonitoredStage } from '@bike4mind/infra';

const MONITORED_STAGES = ['dev', 'production'] as const;
const isMonitoredStage = _isMonitoredStage($app.stage, MONITORED_STAGES, process.env.ENABLE_MONITORING);

const metricNamespace = `${$app.name}/${$app.stage}/Turnstile`;

if (isMonitoredStage) {
  if (!dlqAlarmTopic || !oobAlarmTopic) {
    throw new Error('alarm routing requires dlqAlarmTopic and oobAlarmTopic');
  }

  if (!web.nodes.server) {
    throw new Error('turnstile policy alarm requires the Next.js server function');
  }

  const serverLogGroupName = web.nodes.server
    .apply(fn => fn.nodes.logGroup)
    .apply(logGroup => {
      if (!logGroup) throw new Error('Next.js server function is missing its CloudWatch log group');
      return logGroup.name;
    });

  // Slack (dlqAlarmTopic) plus email (oobAlarmTopic). OK actions close each episode so the next
  // breach is a fresh ALARM transition and notifies again.
  const actions = [dlqAlarmTopic.arn, oobAlarmTopic.arn];

  const watchEvent = (event: string, resourceName: string, metricName: string, alarmDescription: string) => {
    new aws.cloudwatch.LogMetricFilter(`${resourceName}Filter`, {
      name: `${$app.name}-${$app.stage}-${event}`,
      logGroupName: serverLogGroupName,
      pattern: messageFilterPattern(event),
      metricTransformation: {
        name: metricName,
        namespace: metricNamespace,
        value: '1',
        unit: 'Count',
      },
    });

    new aws.cloudwatch.MetricAlarm(resourceName, {
      name: `${$app.name}-${$app.stage}-${event}`,
      alarmDescription,
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName,
      namespace: metricNamespace,
      period: 3600,
      statistic: 'Sum',
      threshold: 1,
      treatMissingData: 'notBreaching',
      alarmActions: actions,
      okActions: actions,
      tags: {
        Application: 'Turnstile',
        Severity: 'High',
      },
    });
  };

  watchEvent(
    'turnstile-policy-inactive',
    'turnstilePolicyInactive',
    'TurnstilePolicyInactive',
    'The server reported the Turnstile policy inactive in the last hour'
  );
  watchEvent(
    'turnstile-misconfigured',
    'turnstileMisconfigured',
    'TurnstileMisconfigured',
    'Turnstile rejected the server configuration in the last hour, so challenged sign-ins are failing'
  );
  watchEvent(
    'card-verification-failure-spike',
    'cardVerificationFailureSpike',
    'CardVerificationFailureSpike',
    'The server reported a card verification failure spike under its private alert policy'
  );
  if (cardVerificationRecoveryLogGroup) {
    new aws.cloudwatch.LogMetricFilter('cardVerificationRecoveryFailureSpikeFilter', {
      logGroupName: cardVerificationRecoveryLogGroup,
      pattern: messageFilterPattern('card-verification-failure-spike'),
      metricTransformation: {
        name: 'CardVerificationFailureSpike',
        namespace: metricNamespace,
        value: '1',
        unit: 'Count',
      },
    });
  }
}
