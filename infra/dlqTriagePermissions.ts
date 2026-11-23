export const dlqTriageRoleNames: $util.Input<string>[] = [];

export function dlqTriagePermissions() {
  const queueArn = $interpolate`arn:${aws.getPartitionOutput().partition}:sqs:${aws.getRegionOutput().name}:${aws.getCallerIdentityOutput().accountId}:${$app.name}-${$app.stage}-`;
  return {
    actions: ['sqs:GetQueueUrl', 'sqs:GetQueueAttributes', 'sqs:ListDeadLetterSourceQueues', 'sqs:ReceiveMessage'],
    resources: ['*DLQ*', '*Dlq*', '*-dlq-*'].map(pattern => $interpolate`${queueArn}${pattern}`),
  };
}

export function dlqTriageEvidencePermissions() {
  const scope = $interpolate`arn:${aws.getPartitionOutput().partition}`;
  const region = aws.getRegionOutput().name;
  const account = aws.getCallerIdentityOutput().accountId;
  const prefix = `${$app.name}-${$app.stage}-`;
  return [
    { actions: ['lambda:ListEventSourceMappings'], resources: ['*'] },
    { actions: ['sqs:GetQueueAttributes'], resources: [$interpolate`${scope}:sqs:${region}:${account}:${prefix}*`] },
    {
      actions: ['logs:FilterLogEvents'],
      resources: [$interpolate`${scope}:logs:${region}:${account}:log-group:/aws/lambda/${prefix}*:*`],
    },
  ];
}
