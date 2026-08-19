/**
 * Long-Running Service Health Monitoring
 *
 * Covers the gap that let a dead ECS service go unnoticed: nothing alarmed on
 * "running task count is below desired". The utilization alarms that Application
 * Auto Scaling creates per service cannot do it, because a service at zero tasks
 * stops emitting utilization metrics entirely and those alarms park in
 * INSUFFICIENT_DATA rather than ALARM.
 *
 * Two complementary signals, both landing on one SNS topic -> Slack:
 *
 *  - TaskFailedToStart events (EventBridge): fires within seconds of ECS failing to
 *    start a task, and carries the reason (denied image pull, missing secret).
 *    Silent while nothing is being started, so it cannot stand alone.
 *  - No-running-tasks alarms (CloudWatch): fires after 10 minutes of total metric
 *    silence per service, whatever the cause. The backstop.
 *
 * Alarm shapes come from buildEcsServiceHealthAlarmSpec in @bike4mind/infra, which
 * documents why the threshold is 0 and why treatMissingData is 'breaching'.
 *
 * Stage-gated: only deployed to `dev` and `production` stages.
 * Set ENABLE_MONITORING=true to opt in for other stages.
 */

import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { chatCompletion } from './chatCompletion';
import { secrets } from './secrets';
import { subscriberFanout } from './subscriberFanout';
import { cluster } from './vpc';
import {
  buildEcsServiceHealthAlarmSpec,
  isMonitoredStage as _isMonitoredStage,
  type EcsServiceHealthAlarmDescriptor,
} from '@bike4mind/infra';

const MONITORED_STAGES = ['dev', 'production'] as const;
const isMonitoredStage = _isMonitoredStage($app.stage, MONITORED_STAGES, process.env.ENABLE_MONITORING);

/**
 * Shared SNS topic for every long-running-service health signal. Subscribe once to
 * receive both the no-tasks alarms and the TaskFailedToStart events.
 */
export const serviceHealthAlarmTopic = isMonitoredStage ? new sst.aws.SnsTopic('ServiceHealthAlarmTopic') : undefined;

/**
 * The ECS services monitored here. `serviceName` must match the ECS service name,
 * which SST sets to the component name verbatim - keep each entry in sync with the
 * string passed to the corresponding `new sst.aws.Service(...)` call.
 *
 * Referencing the service components (rather than only their names) keeps this list
 * honest: deleting a service breaks this file at compile time instead of leaving a
 * dead alarm that silently never fires.
 */
const MONITORED_SERVICES: (EcsServiceHealthAlarmDescriptor & { service: sst.aws.Service })[] = [
  {
    label: 'subscriber-fanout',
    displayName: 'Subscriber Fanout',
    application: 'RealtimeFanout',
    serviceName: 'subscriberFanoutV2',
    service: subscriberFanout,
  },
  {
    label: 'chat-completion',
    displayName: 'Chat Completion',
    application: 'ChatCompletion',
    serviceName: 'ChatCompletion',
    service: chatCompletion,
  },
];

if (isMonitoredStage) {
  // Mirrors the DLQ alarm topic wiring: a redrive target so a Slack outage parks the
  // notification for forensics instead of dropping it.
  const serviceHealthHandlerDlq = new aws.sqs.Queue('ServiceHealthAlarmHandlerDlq', {
    messageRetentionSeconds: 14 * 24 * 3600,
  });

  new aws.sqs.QueuePolicy('ServiceHealthAlarmHandlerDlqPolicy', {
    queueUrl: serviceHealthHandlerDlq.url,
    policy: $util.all([serviceHealthHandlerDlq.arn, serviceHealthAlarmTopic!.arn]).apply(([dlqArn, topicArn]) =>
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'sns.amazonaws.com' },
            Action: 'sqs:SendMessage',
            Resource: dlqArn,
            Condition: { ArnEquals: { 'aws:SourceArn': topicArn } },
          },
        ],
      })
    ),
  });

  serviceHealthAlarmTopic!.subscribe(
    {
      handler: 'apps/client/server/events/serviceHealthAlarmToSlack.handler',
      link: [secrets.SLACK_ERROR_REPORTING_WEBHOOK_URL],
      environment: { ...DEFAULT_LAMBDA_ENVIRONMENT },
      logging: { retention: '3 days' },
    },
    {
      transform: {
        subscription: {
          redrivePolicy: serviceHealthHandlerDlq.arn.apply(arn => JSON.stringify({ deadLetterTargetArn: arn })),
        },
      },
    }
  );

  // --- Signal 1: a task ECS could not start, with the reason ---

  // EventBridge publishes directly to SNS, so the topic must accept it. Scoped to
  // this topic so the grant cannot be reused by another rule in the account.
  new aws.sns.TopicPolicy('ServiceHealthAlarmTopicPolicy', {
    arn: serviceHealthAlarmTopic!.arn,
    policy: serviceHealthAlarmTopic!.arn.apply(topicArn =>
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'events.amazonaws.com' },
            Action: 'sns:Publish',
            Resource: topicArn,
          },
        ],
      })
    ),
  });

  // Scoped to this stage's cluster ARN. Preview stages share an account, so an
  // unscoped rule would cross-report every other stage's task failures.
  const taskFailedToStartRule = new aws.cloudwatch.EventRule('EcsTaskFailedToStartRule', {
    name: `${$app.name}-${$app.stage}-ecs-task-failed-to-start`,
    description: 'ECS task could not start (image pull denied, missing secret) - notifies service health Slack',
    eventPattern: cluster.nodes.cluster.arn.apply(clusterArn =>
      JSON.stringify({
        source: ['aws.ecs'],
        'detail-type': ['ECS Task State Change'],
        detail: {
          clusterArn: [clusterArn],
          stopCode: ['TaskFailedToStart'],
        },
      })
    ),
  });

  new aws.cloudwatch.EventTarget('EcsTaskFailedToStartTarget', {
    rule: taskFailedToStartRule.name,
    arn: serviceHealthAlarmTopic!.arn,
  });

  // --- Signal 2: the backstop, per service ---

  for (const monitored of MONITORED_SERVICES) {
    const spec = buildEcsServiceHealthAlarmSpec(monitored, { appName: $app.name, stage: $app.stage });
    new aws.cloudwatch.MetricAlarm(spec.resourceName, {
      ...spec.args,
      dimensions: {
        ClusterName: cluster.nodes.cluster.name,
        ServiceName: spec.serviceName,
      },
      alarmActions: [serviceHealthAlarmTopic!.arn],
      okActions: [serviceHealthAlarmTopic!.arn],
    });
  }
}
