import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { eventBus } from './eventBus';
import { slackQuestProcessor } from './functions';
import { allSecrets } from './secrets';
import { lambdaVpc } from './vpc';

// Web-originated completions ('completion.started') are no longer handled by a Lambda.
// They are processed by the always-on ChatCompletion (see infra/chatCompletion.ts),
// which the frontend reaches directly over HTTP. Slack-originated completions still route
// through EventBridge -> slackQuestProcessor below, matched by their own detail type.

// Rule-target DLQs: see telemetryAlertRuleDLQ in infra/eventBus.ts for why EventBridge needs one.
// Guarded by infra/__tests__/eventBusRuleDlq.test.ts.
const slackCompletionStartRuleDLQ = new sst.aws.Queue('slackCompletionStartRuleDLQ', {
  transform: {
    queue: {
      messageRetentionSeconds: 1209600, // 14 days for forensics investigation
    },
  },
});

const slackCompletionStartSubscription = eventBus.subscribe('slack-completion-start', slackQuestProcessor.arn, {
  pattern: {
    detailType: ['slack.completion.started'],
  },
  transform: {
    target: {
      deadLetterConfig: {
        arn: slackCompletionStartRuleDLQ.arn,
      },
    },
  },
});

new aws.sqs.QueuePolicy('slackCompletionStartRuleDLQPolicy', {
  queueUrl: slackCompletionStartRuleDLQ.url,
  policy: $util
    .all([slackCompletionStartRuleDLQ.arn, slackCompletionStartSubscription.nodes.rule.arn])
    .apply(([dlqArn, ruleArn]) =>
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'events.amazonaws.com' },
            Action: 'sqs:SendMessage',
            Resource: dlqArn,
            Condition: { ArnEquals: { 'aws:SourceArn': ruleArn } },
          },
        ],
      })
    ),
});

const createMementoRuleDLQ = new sst.aws.Queue('createMementoRuleDLQ', {
  transform: {
    queue: {
      messageRetentionSeconds: 1209600, // 14 days for forensics investigation
    },
  },
});

const createMementoSubscription = eventBus.subscribe(
  'create-memento',
  {
    handler: 'apps/workers/src/events/createMemento.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, eventBus],
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:*'],
        resources: ['*'],
      },
    ],
    vpc: lambdaVpc,
  },
  {
    pattern: {
      detailType: ['completion.completed'],
    },
    transform: {
      target: {
        deadLetterConfig: {
          arn: createMementoRuleDLQ.arn,
        },
      },
    },
  }
);

new aws.sqs.QueuePolicy('createMementoRuleDLQPolicy', {
  queueUrl: createMementoRuleDLQ.url,
  policy: $util.all([createMementoRuleDLQ.arn, createMementoSubscription.nodes.rule.arn]).apply(([dlqArn, ruleArn]) =>
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'events.amazonaws.com' },
          Action: 'sqs:SendMessage',
          Resource: dlqArn,
          Condition: { ArnEquals: { 'aws:SourceArn': ruleArn } },
        },
      ],
    })
  ),
});

export { slackCompletionStartRuleDLQ, createMementoRuleDLQ };
