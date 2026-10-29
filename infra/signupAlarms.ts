/**
 * Signup abuse alarms on the Next.js server log group: sign-in code sends (hourly ceiling from
 * SIGNUP_CODE_SEND_ALARM_PER_HOUR, unset: no hourly alarm; 5-minute burst ceiling from
 * SIGNUP_CODE_SEND_ALARM_PER_5MIN), user API key creation (API_KEY_CREATE_ALARM_PER_5MIN), and a
 * large signup grant released while a signup protection is still off.
 * See infra/signup-code-send-alarm.md.
 */

import { web } from './web';
import { dlqAlarmTopic, oobAlarmTopic } from './dlqAlarms';
import {
  API_KEY_CREATE_BURST_DEFAULT,
  SIGNUP_CODE_SEND_BURST_DEFAULT,
  parseAlarmThreshold,
  parseSignupCodeSendAlarmThreshold,
} from './signupAlarmThreshold';
import { isMonitoredStage as _isMonitoredStage } from '@bike4mind/infra';

const MONITORED_STAGES = ['dev', 'production'] as const;
const isMonitoredStage = _isMonitoredStage($app.stage, MONITORED_STAGES, process.env.ENABLE_MONITORING);

const hourlyThreshold = parseSignupCodeSendAlarmThreshold(process.env.SIGNUP_CODE_SEND_ALARM_PER_HOUR);
const burstThreshold = parseAlarmThreshold(
  'SIGNUP_CODE_SEND_ALARM_PER_5MIN',
  process.env.SIGNUP_CODE_SEND_ALARM_PER_5MIN,
  SIGNUP_CODE_SEND_BURST_DEFAULT
);
const apiKeyThreshold = parseAlarmThreshold(
  'API_KEY_CREATE_ALARM_PER_5MIN',
  process.env.API_KEY_CREATE_ALARM_PER_5MIN,
  API_KEY_CREATE_BURST_DEFAULT
);
const metricNamespace = `${$app.name}/${$app.stage}/Signup`;

/** Matches the JSON message field inside Lambda-prefixed logs, not caller-controlled metadata. */
function messageFilterPattern(message: string): string {
  return `%\\x22message\\x22:\\x22${message}\\x22%`;
}

if (isMonitoredStage) {
  if (!dlqAlarmTopic || !oobAlarmTopic) {
    throw new Error('alarm routing requires dlqAlarmTopic and oobAlarmTopic');
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

  // Slack (dlqAlarmTopic) plus email (oobAlarmTopic). OK actions close each episode so the next
  // breach is a fresh ALARM transition and notifies again.
  const actions = [dlqAlarmTopic.arn, oobAlarmTopic.arn];

  new aws.cloudwatch.LogMetricFilter('signupCodeSendsFilter', {
    name: `${$app.name}-${$app.stage}-signup-code-sends`,
    logGroupName: serverLogGroupName,
    pattern: messageFilterPattern('otc-code-dispatched'),
    metricTransformation: {
      name: 'SignupCodeSends',
      namespace: metricNamespace,
      value: '1',
      unit: 'Count',
    },
  });

  if (hourlyThreshold !== undefined) {
    new aws.cloudwatch.MetricAlarm('signupCodeSendRate', {
      name: `${$app.name}-${$app.stage}-signup-code-send-rate`,
      alarmDescription: 'Sign-in code email dispatches per hour at or above the configured ceiling',
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName: 'SignupCodeSends',
      namespace: metricNamespace,
      period: 3600,
      statistic: 'Sum',
      threshold: hourlyThreshold,
      treatMissingData: 'notBreaching',
      alarmActions: actions,
      okActions: actions,
      tags: {
        Application: 'Signup',
        Severity: 'Medium',
      },
    });
  }

  new aws.cloudwatch.MetricAlarm('signupCodeSendBurst', {
    name: `${$app.name}-${$app.stage}-signup-code-send-burst`,
    alarmDescription: 'Sign-in code email dispatches per 5 minutes at or above the burst ceiling',
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 1,
    metricName: 'SignupCodeSends',
    namespace: metricNamespace,
    period: 300,
    statistic: 'Sum',
    threshold: burstThreshold,
    treatMissingData: 'notBreaching',
    alarmActions: actions,
    okActions: actions,
    tags: {
      Application: 'Signup',
      Severity: 'High',
    },
  });

  new aws.cloudwatch.LogMetricFilter('apiKeyCreationsFilter', {
    name: `${$app.name}-${$app.stage}-api-key-creations`,
    logGroupName: serverLogGroupName,
    pattern: messageFilterPattern('user-api-key-created'),
    metricTransformation: {
      name: 'ApiKeyCreations',
      namespace: metricNamespace,
      value: '1',
      unit: 'Count',
    },
  });

  new aws.cloudwatch.MetricAlarm('apiKeyCreateBurst', {
    name: `${$app.name}-${$app.stage}-api-key-create-burst`,
    alarmDescription: 'User API keys created per 5 minutes at or above the burst ceiling',
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 1,
    metricName: 'ApiKeyCreations',
    namespace: metricNamespace,
    period: 300,
    statistic: 'Sum',
    threshold: apiKeyThreshold,
    treatMissingData: 'notBreaching',
    alarmActions: actions,
    okActions: actions,
    tags: {
      Application: 'Signup',
      Severity: 'High',
    },
  });

  // Same string as SIGNUP_GRANT_UNPROTECTED_LOG_MESSAGE in b4m-core/common/src/signupGrant.ts.
  new aws.cloudwatch.LogMetricFilter('signupGrantProtectionGapFilter', {
    name: `${$app.name}-${$app.stage}-signup-grant-protection-gap`,
    logGroupName: serverLogGroupName,
    pattern: messageFilterPattern('signup-grant-protections-off'),
    metricTransformation: {
      name: 'SignupGrantProtectionGaps',
      namespace: metricNamespace,
      value: '1',
      unit: 'Count',
    },
  });

  new aws.cloudwatch.MetricAlarm('signupGrantProtectionGap', {
    name: `${$app.name}-${$app.stage}-signup-grant-protection-gap`,
    alarmDescription:
      'A signup grant release was attempted while a large grant is configured and a signup protection setting is still off',
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    // Any occurrence in the last hour holds ALARM, so sparse signups under one standing misconfiguration
    // do not page an ALARM/OK pair each.
    evaluationPeriods: 12,
    datapointsToAlarm: 1,
    metricName: 'SignupGrantProtectionGaps',
    namespace: metricNamespace,
    period: 300,
    statistic: 'Sum',
    threshold: 1,
    treatMissingData: 'notBreaching',
    alarmActions: actions,
    okActions: actions,
    tags: {
      Application: 'Signup',
      Severity: 'High',
    },
  });
}
