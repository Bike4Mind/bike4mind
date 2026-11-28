/**
 * Monitoring and the reachability probe for the secrets-at-rest key (infra/secretsAtRestKey.ts). A
 * shared preview key is owned and alarmed outside this stack, so only the probe exists there. The
 * rules need a CloudTrail trail that logs management events, which this stack does not create.
 */

import { secrets } from './secrets';
import { lambdaVpc } from './vpc';
import { dlqAlarmTopic, oobAlarmTopic } from './dlqAlarms';
import {
  secretsAtRestDecryptDeniedEventPattern,
  secretsAtRestKey,
  secretsAtRestKeyChangeEventPattern,
  secretsAtRestLogsPolicy,
} from './secretsAtRestKey';

function createMonitoring(key: aws.kms.Key) {
  const alarmActions = [dlqAlarmTopic, oobAlarmTopic].flatMap(topic => (topic ? [topic.arn] : []));
  const prefix = `${$app.name}-${$app.stage}`;

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
      description: 'A Decrypt on the secrets-at-rest key was refused',
      // Decrypt is a read-only management event, which reaches a rule only in this state.
      state: 'ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS',
      pattern: key.arn.apply(arn => JSON.stringify(secretsAtRestDecryptDeniedEventPattern({ keyArn: arn }))),
    },
    {
      id: 'KeyChange',
      name: `${prefix}-secrets-at-rest-key-change`,
      description: 'The secrets-at-rest KMS key policy, grants or lifecycle changed',
      state: undefined,
      pattern: $resolve([key.keyId, key.arn]).apply(([keyId, arn]) =>
        JSON.stringify(secretsAtRestKeyChangeEventPattern({ keyId, keyArn: arn }))
      ),
    },
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
}

function createAccess() {
  if (!secretsAtRestKey) return;
  if (secretsAtRestKey.key) createMonitoring(secretsAtRestKey.key);

  // Manual invoke only, no schedule: shows a VPC-attached function reaches KMS and records Decrypt latency.
  new sst.aws.Function('SecretsAtRestUnwrapProbe', {
    handler: 'apps/workers/src/security/secretsAtRestUnwrapProbe.handler',
    runtime: 'nodejs24.x',
    vpc: lambdaVpc,
    timeout: '10 seconds',
    link: [secrets.SECRET_DATA_KEY_WRAPPED],
  });
}

createAccess();
