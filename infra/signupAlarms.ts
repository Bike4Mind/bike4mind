/**
 * Signup code send rate alarm: counts sends logged by the Next.js server function and alarms
 * when the hourly total reaches the ceiling in SIGNUP_CODE_SEND_ALARM_PER_HOUR (unset: no alarm).
 */

import { web } from './web';
import { dlqAlarmTopic } from './dlqAlarms';
import { parseSignupCodeSendAlarmThreshold } from './signupAlarmThreshold';
import { isMonitoredStage as _isMonitoredStage } from '@bike4mind/infra';

const MONITORED_STAGES = ['dev', 'production'] as const;
const isMonitoredStage = _isMonitoredStage($app.stage, MONITORED_STAGES, process.env.ENABLE_MONITORING);

const threshold = parseSignupCodeSendAlarmThreshold(process.env.SIGNUP_CODE_SEND_ALARM_PER_HOUR);

if (isMonitoredStage && threshold !== undefined) {
  if (!dlqAlarmTopic) {
    throw new Error('alarm routing requires dlqAlarmTopic');
  }

  if (!web.nodes.server) {
    throw new Error('signup code send alarm requires the Next.js server function');
  }

  const serverLogGroupName = web.nodes.server
    .apply(fn => fn.nodes.logGroup)
    .apply(logGroup => {
      if (!logGroup) throw new Error('Next.js server function is missing its CloudWatch log group');
      return logGroup.name;
    });

  new aws.cloudwatch.LogMetricFilter('signupCodeSendsFilter', {
    name: `${$app.name}-${$app.stage}-signup-code-sends`,
    logGroupName: serverLogGroupName,
    // Term match, both required: one timing line per request, and only the send route logs
    // that path. The line is Lambda-prefixed text, so a JSON selector pattern would not match.
    pattern: '"req-timing" "/api/otc/send"',
    metricTransformation: {
      name: 'SignupCodeSends',
      namespace: 'Lumina5/Signup',
      value: '1',
      unit: 'Count',
    },
  });

  new aws.cloudwatch.MetricAlarm('signupCodeSendRate', {
    name: `${$app.name}-${$app.stage}-signup-code-send-rate`,
    alarmDescription: 'Signup code sends per hour above the configured ceiling',
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 1,
    metricName: 'SignupCodeSends',
    namespace: 'Lumina5/Signup',
    period: 3600,
    statistic: 'Sum',
    threshold,
    treatMissingData: 'notBreaching',
    alarmActions: [dlqAlarmTopic.arn],
    tags: {
      Application: 'Signup',
      Severity: 'Medium',
    },
  });
}
