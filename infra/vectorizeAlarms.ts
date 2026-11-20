import { isMonitoredStage } from '@bike4mind/infra';
import { dlqAlarmTopic } from './dlqAlarms';
import { messageFilterPattern } from './logMessageFilterPattern';
import { fabFileVectorizeQueueSubscription } from './queues';

if (isMonitoredStage($app.stage, ['dev', 'production'], process.env.ENABLE_MONITORING)) {
  if (!dlqAlarmTopic) throw new Error('embedding billing check alarm requires dlqAlarmTopic');

  const logGroupName = fabFileVectorizeQueueSubscription.nodes.function
    .apply(fn => fn.nodes.logGroup)
    .apply(logGroup => {
      if (!logGroup) throw new Error('vectorize subscriber function is missing its CloudWatch log group');
      return logGroup.name;
    });
  const namespace = `${$app.name}/${$app.stage}/Embedding`;

  new aws.cloudwatch.LogMetricFilter('embeddingBillingCheckRetriesFilter', {
    name: `${$app.name}-${$app.stage}-embedding-billing-check-retries`,
    logGroupName,
    pattern: messageFilterPattern('embedding-billing-check-retry'),
    metricTransformation: { name: 'EmbeddingBillingCheckRetries', namespace, value: '1', unit: 'Count' },
  });

  new aws.cloudwatch.MetricAlarm('embeddingBillingCheckRetries', {
    name: `${$app.name}-${$app.stage}-embedding-billing-check-retries`,
    alarmDescription: 'Embedding jobs deferred after a billing check failure in the last five minutes',
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    threshold: 1,
    metricName: 'EmbeddingBillingCheckRetries',
    namespace,
    period: 300,
    evaluationPeriods: 1,
    statistic: 'Sum',
    treatMissingData: 'notBreaching',
    alarmActions: [dlqAlarmTopic.arn],
    okActions: [dlqAlarmTopic.arn],
    tags: { Application: 'Embedding', Severity: 'High' },
  });
}
