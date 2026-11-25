/**
 * Access policy and monitoring for the secrets-at-rest key (infra/secretsAtRestKey.ts). Loaded after
 * the ECS services so their task role ARNs can go into the key policy and the alarm pattern.
 */

import { chatCompletion } from './chatCompletion';
import { secrets } from './secrets';
import { lambdaVpc } from './vpc';
import { dlqAlarmTopic, oobAlarmTopic } from './dlqAlarms';
import {
  secretsAtRestDecryptOutsideAppEventPattern,
  secretsAtRestKey,
  secretsAtRestKeyChangeEventPattern,
  secretsAtRestKeyPolicy,
  secretsAtRestLogsPolicy,
} from './secretsAtRestKey';

function createAccess() {
  if (!secretsAtRestKey) return;
  // Previews have no alarm topics: the alarm still exists and shows ALARM, it just notifies no one.
  const alarmActions = [dlqAlarmTopic, oobAlarmTopic].flatMap(topic => (topic ? [topic.arn] : []));

  const prefix = `${$app.name}-${$app.stage}`;
  const partition = aws.getPartitionOutput().partition;
  const accountId = aws.getCallerIdentityOutput().accountId;
  const region = aws.getRegionOutput().name;
  const ecsRoleArns = $output([chatCompletion.nodes.taskRole.arn]);
  const keyArn = $output(secretsAtRestKey.arn);

  if (secretsAtRestKey.key) {
    new aws.kms.KeyPolicy('SecretsAtRestKeyPolicy', {
      keyId: secretsAtRestKey.key.keyId,
      policy: $resolve([partition, accountId, region, ecsRoleArns]).apply(([p, account, r, roles]) =>
        JSON.stringify(
          secretsAtRestKeyPolicy({
            partition: p,
            accountId: account,
            region: r,
            appName: $app.name,
            stage: $app.stage,
            ecsRoleArns: roles,
            pinStage: true,
          })
        )
      ),
    });
  }

  const logGroup = new aws.cloudwatch.LogGroup('SecretsAtRestKeyLogs', {
    name: `/aws/events/${prefix}-secrets-at-rest-key`,
    retentionInDays: 365,
  });
  new aws.cloudwatch.LogResourcePolicy('SecretsAtRestKeyLogsPolicy', {
    policyName: `${prefix}-secrets-at-rest-key`,
    policyDocument: logGroup.arn.apply(arn => JSON.stringify(secretsAtRestLogsPolicy(arn))),
  });

  const rules = [
    {
      id: 'Decrypt',
      name: `${prefix}-secrets-at-rest-decrypt`,
      description: 'The secrets-at-rest key was used to Decrypt by a caller that is not this stage app',
      // Decrypt is a read-only management event, which reaches a rule only in this state.
      state: 'ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS',
      pattern: $resolve([keyArn, ecsRoleArns]).apply(([arn, roles]) =>
        JSON.stringify(
          secretsAtRestDecryptOutsideAppEventPattern({
            keyArn: arn,
            appName: $app.name,
            stage: $app.stage,
            ecsRoleArns: roles,
          })
        )
      ),
    },
    // A shared key is changed by its owner, outside this stack.
    ...(secretsAtRestKey.key
      ? [
          {
            id: 'KeyChange',
            name: `${prefix}-secrets-at-rest-key-change`,
            description: 'The secrets-at-rest KMS key policy, grants or lifecycle changed',
            state: undefined,
            pattern: $resolve([secretsAtRestKey.key.keyId, keyArn]).apply(([keyId, arn]) =>
              JSON.stringify(secretsAtRestKeyChangeEventPattern({ keyId, keyArn: arn }))
            ),
          },
        ]
      : []),
  ];

  for (const rule of rules) {
    const eventRule = new aws.cloudwatch.EventRule(`SecretsAtRest${rule.id}Rule`, {
      name: rule.name,
      description: rule.description,
      state: rule.state,
      eventPattern: rule.pattern,
    });
    new aws.cloudwatch.EventTarget(`SecretsAtRest${rule.id}Target`, {
      rule: eventRule.name,
      arn: logGroup.arn,
    });
    new aws.cloudwatch.MetricAlarm(`SecretsAtRest${rule.id}Alarm`, {
      name: rule.name,
      alarmDescription: rule.description,
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName: 'MatchedEvents',
      namespace: 'AWS/Events',
      dimensions: { RuleName: rule.name },
      period: 300,
      statistic: 'Sum',
      threshold: 1,
      treatMissingData: 'notBreaching',
      alarmActions,
      tags: { Application: 'SecretsAtRest', Severity: 'Critical' },
    });
  }

  // Manual invoke only, no schedule: shows a VPC-attached function reaches KMS and records Decrypt latency.
  new sst.aws.Function('SecretsAtRestUnwrapProbe', {
    handler: 'apps/workers/src/security/secretsAtRestUnwrapProbe.handler',
    runtime: 'nodejs24.x',
    vpc: lambdaVpc,
    timeout: '10 seconds',
    link: [secrets.SECRET_ENCRYPTION_KEY_WRAPPED],
  });
}

createAccess();
