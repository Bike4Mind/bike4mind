import { isMonitoredStage } from '@bike4mind/infra';
import {
  accountCreationAlarmArgs,
  accountCreationAlarmThreshold,
  emailRateQueries,
  emailRateThreshold,
  NEW_ACCOUNT_API_KEY_ALARM_PER_HOUR_DEFAULT,
  SIGNUP_ALARM_PER_HOUR_DEFAULT,
} from './accountCreationAlarmConfig';
import { DEFAULT_LAMBDA_ENVIRONMENT, runsScheduledJobs } from './constants';
import { dlqAlarmTopic } from './dlqAlarms';
import { allSecrets } from './secrets';
import { lambdaVpc } from './vpc';
import { otcEmailConfigurationSet } from './otcEmailMetrics';

const signals = [
  {
    metric: 'SuccessfulSignups',
    env: 'SIGNUP_ALARM_PER_HOUR',
    raw: process.env.SIGNUP_ALARM_PER_HOUR,
    fallback: SIGNUP_ALARM_PER_HOUR_DEFAULT,
  },
  {
    metric: 'NewAccountApiKeys',
    env: 'NEW_ACCOUNT_API_KEY_ALARM_PER_HOUR',
    raw: process.env.NEW_ACCOUNT_API_KEY_ALARM_PER_HOUR,
    fallback: NEW_ACCOUNT_API_KEY_ALARM_PER_HOUR_DEFAULT,
  },
].map(signal => ({ ...signal, threshold: accountCreationAlarmThreshold(signal.raw, signal.env, signal.fallback) }));

if (runsScheduledJobs && isMonitoredStage($app.stage, ['dev', 'production'], process.env.ENABLE_MONITORING)) {
  if (!dlqAlarmTopic) throw new Error('account creation alarms require dlqAlarmTopic');
  const namespace = `${$app.name}/${$app.stage}/AccountCreation`;
  const failures = new aws.sqs.Queue('AccountCreationMetricsDlq', { messageRetentionSeconds: 14 * 24 * 3600 });
  const metrics = new sst.aws.Function('AccountCreationMetrics', {
    handler: 'apps/workers/src/cron/accountCreationMetrics.handler',
    runtime: 'nodejs24.x',
    vpc: lambdaVpc,
    timeout: '3 minutes',
    transform: { function: { deadLetterConfig: { targetArn: failures.arn } } },
    link: [...allSecrets],
    environment: { ...DEFAULT_LAMBDA_ENVIRONMENT },
    permissions: [
      {
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: [{ test: 'StringEquals', variable: 'cloudwatch:namespace', values: [namespace] }],
      },
      { actions: ['sqs:SendMessage'], resources: [failures.arn] },
    ],
  });
  const schedule = new aws.cloudwatch.EventRule('AccountCreationMetricsSchedule', {
    scheduleExpression: 'cron(5 * * * ? *)',
  });
  new aws.lambda.Permission('AccountCreationMetricsSchedulePermission', {
    action: 'lambda:InvokeFunction',
    function: metrics.name,
    principal: 'events.amazonaws.com',
    sourceArn: schedule.arn,
  });
  new aws.sqs.QueuePolicy('AccountCreationMetricsDlqPolicy', {
    queueUrl: failures.url,
    policy: $util.all([failures.arn, schedule.arn]).apply(([queueArn, ruleArn]) =>
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'events.amazonaws.com' },
            Action: 'sqs:SendMessage',
            Resource: queueArn,
            Condition: { ArnEquals: { 'aws:SourceArn': ruleArn } },
          },
        ],
      })
    ),
  });
  new aws.cloudwatch.EventTarget('AccountCreationMetricsTarget', {
    rule: schedule.name,
    arn: metrics.arn,
    deadLetterConfig: { arn: failures.arn },
    retryPolicy: { maximumEventAgeInSeconds: 3600, maximumRetryAttempts: 2 },
  });
  for (const signal of signals) {
    new aws.cloudwatch.MetricAlarm(`AccountCreation${signal.metric}`, {
      ...accountCreationAlarmArgs(signal.metric, signal.threshold),
      name: `${$app.name}-${$app.stage}-${signal.metric}`,
      namespace,
      alarmActions: [dlqAlarmTopic.arn],
      okActions: [dlqAlarmTopic.arn],
    });
  }
  new aws.cloudwatch.MetricAlarm('AccountCreationMetricsMissing', {
    name: `${$app.name}-${$app.stage}-account-creation-metrics-missing`,
    namespace,
    metricName: 'CensusCompleted',
    comparisonOperator: 'LessThanThreshold',
    threshold: 1,
    period: 3600,
    evaluationPeriods: 3,
    datapointsToAlarm: 2,
    statistic: 'Maximum',
    treatMissingData: 'breaching',
    alarmActions: [dlqAlarmTopic.arn],
  });
  new aws.cloudwatch.MetricAlarm('AccountCreationMetricsFailed', {
    name: `${$app.name}-${$app.stage}-account-creation-metrics-failed`,
    namespace: 'AWS/SQS',
    metricName: 'ApproximateNumberOfMessagesVisible',
    dimensions: { QueueName: failures.name },
    comparisonOperator: 'GreaterThanThreshold',
    threshold: 0,
    period: 300,
    evaluationPeriods: 1,
    statistic: 'Maximum',
    treatMissingData: 'ignore',
    alarmActions: [dlqAlarmTopic.arn],
  });
}

const emailSignals = [
  { metric: 'Bounce', name: 'OTC_SES_BOUNCE_ALARM_PERCENT', raw: process.env.OTC_SES_BOUNCE_ALARM_PERCENT },
  { metric: 'Complaint', name: 'OTC_SES_COMPLAINT_ALARM_PERCENT', raw: process.env.OTC_SES_COMPLAINT_ALARM_PERCENT },
] as const;

for (const { metric, name, raw } of emailSignals) {
  const threshold = emailRateThreshold(raw, name);
  if (threshold === undefined) continue;
  if (!isMonitoredStage($app.stage, ['dev', 'production'], process.env.ENABLE_MONITORING)) continue;
  if (!otcEmailConfigurationSet) throw new Error(`${name} requires ENABLE_OTC_SES_METRICS on a monitored stage`);
  if (!dlqAlarmTopic) throw new Error('OTC email alarms require dlqAlarmTopic');
  new aws.cloudwatch.MetricAlarm(`OtcEmail${metric}Rate`, {
    name: `${$app.name}-${$app.stage}-otc-email-${metric.toLowerCase()}-rate`,
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    threshold,
    evaluationPeriods: 1,
    treatMissingData: 'notBreaching',
    metricQueries: otcEmailConfigurationSet.name.apply(name => emailRateQueries(metric, name)),
    alarmActions: [dlqAlarmTopic.arn],
    okActions: [dlqAlarmTopic.arn],
  });
}
