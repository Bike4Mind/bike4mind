import { DEFAULT_LAMBDA_ENVIRONMENT, runsScheduledJobs } from './constants';
import { dlqAlarmTopic } from './dlqAlarms';
import { allSecrets } from './secrets';
import { lambdaVpc } from './vpc';

if (runsScheduledJobs) {
  const failures = new aws.sqs.Queue('AnalyticsRollupDlq', { messageRetentionSeconds: 14 * 24 * 3600 });
  const rollup = new sst.aws.Function('AnalyticsRollup', {
    handler: 'apps/workers/src/cron/analyticsRollup.handler',
    runtime: 'nodejs24.x',
    vpc: lambdaVpc,
    timeout: '15 minutes',
    memory: '1024 MB',
    transform: { function: { deadLetterConfig: { targetArn: failures.arn } } },
    link: [...allSecrets],
    environment: { ...DEFAULT_LAMBDA_ENVIRONMENT },
    permissions: [{ actions: ['sqs:SendMessage'], resources: [failures.arn] }],
  });
  const schedule = new aws.cloudwatch.EventRule('AnalyticsRollupSchedule', {
    scheduleExpression: 'cron(0 4 * * ? *)',
  });
  new aws.lambda.Permission('AnalyticsRollupSchedulePermission', {
    action: 'lambda:InvokeFunction',
    function: rollup.name,
    principal: 'events.amazonaws.com',
    sourceArn: schedule.arn,
  });
  new aws.sqs.QueuePolicy('AnalyticsRollupDlqPolicy', {
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
  new aws.cloudwatch.EventTarget('AnalyticsRollupTarget', {
    rule: schedule.name,
    arn: rollup.arn,
    deadLetterConfig: { arn: failures.arn },
    retryPolicy: { maximumEventAgeInSeconds: 3600, maximumRetryAttempts: 2 },
  });
  if (dlqAlarmTopic) {
    new aws.cloudwatch.MetricAlarm('AnalyticsRollupFailed', {
      name: `${$app.name}-${$app.stage}-analytics-rollup-failed`,
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
}
