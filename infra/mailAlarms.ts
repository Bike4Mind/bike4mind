/**
 * Alarm on outbound email sends the mail transport rejects (sign-in codes included).
 * See infra/signup-code-send-alarm.md.
 */

import { isMonitoredStage } from '@bike4mind/infra';
import { dlqAlarmTopic } from './dlqAlarms';
import { emailSendSubscription } from './eventBus';

if (isMonitoredStage($app.stage, ['dev', 'production'], process.env.ENABLE_MONITORING)) {
  if (!dlqAlarmTopic) throw new Error('mail send failure alarm requires dlqAlarmTopic');

  const logGroupName = emailSendSubscription.nodes.function
    .apply(fn => fn.nodes.logGroup)
    .apply(logGroup => {
      if (!logGroup) throw new Error('email-send subscriber function is missing its CloudWatch log group');
      return logGroup.name;
    });
  const namespace = `${$app.name}/${$app.stage}/Mail`;

  new aws.cloudwatch.LogMetricFilter('mailSendFailuresFilter', {
    name: `${$app.name}-${$app.stage}-mail-send-failures`,
    logGroupName,
    pattern: '"Email delivery failed"',
    metricTransformation: { name: 'MailSendFailures', namespace, value: '1', unit: 'Count' },
  });

  new aws.cloudwatch.MetricAlarm('mailSendFailures', {
    name: `${$app.name}-${$app.stage}-mail-send-failures`,
    alarmDescription: 'Outbound email sends rejected by the mail transport in the last hour',
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    threshold: 1,
    metricName: 'MailSendFailures',
    namespace,
    period: 3600,
    evaluationPeriods: 1,
    statistic: 'Sum',
    treatMissingData: 'notBreaching',
    alarmActions: [dlqAlarmTopic.arn],
    okActions: [dlqAlarmTopic.arn],
    tags: { Application: 'Mail', Severity: 'High' },
  });
}
