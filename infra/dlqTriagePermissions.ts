export function dlqTriagePermissions() {
  const queueArn = $interpolate`arn:${aws.getPartitionOutput().partition}:sqs:${aws.getRegionOutput().name}:${aws.getCallerIdentityOutput().accountId}:${$app.name}-${$app.stage}-`;
  return {
    actions: ['sqs:GetQueueUrl', 'sqs:GetQueueAttributes', 'sqs:ListDeadLetterSourceQueues', 'sqs:ReceiveMessage'],
    resources: ['*DLQ*', '*Dlq*', '*-dlq-*'].map(pattern => $interpolate`${queueArn}${pattern}`),
  };
}
