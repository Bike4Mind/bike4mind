import { allSecrets } from './secrets';
import { websocketApi } from './websocket';
import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { lambdaVpc } from './vpc';
import { fabFileBucket, generatedImagesBucket, appFilesBucket } from './buckets';
import { eventBus } from './bus';
import { notebookCurationQueue, sreFixQueue, sreFixQueueDLQ } from './queues';
import { createEventBusDeadLetter } from './eventBusDeadLetter';

// Stripe events
const billingEventsDLQ = new sst.aws.Queue('billingEventsDLQ', {
  transform: {
    queue: {
      messageRetentionSeconds: 1209600, // 14 days for forensics investigation
    },
  },
});
const billingEventsDeadLetter = createEventBusDeadLetter('billingEventsDLQ', billingEventsDLQ);

const stripeInvoicePaymentSucceededSubscription = eventBus.subscribe(
  'stripe-invoice-payment-succeeded',
  {
    handler: 'apps/workers/src/events/stripe/invoicePaymentSucceeded.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, websocketApi, eventBus],
    vpc: lambdaVpc,
    timeout: '1 minute',
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    // Lumina5/Entitlements skip metrics (emitMetric in the handler + plan-lookup miss
    // in handleUserSubscriptionInvoice).
    permissions: [
      {
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      },
      billingEventsDeadLetter.sendPermission,
    ],
    transform: billingEventsDeadLetter.functionTarget,
  },
  {
    pattern: {
      detailType: ['stripe.invoice.payment_succeeded'],
    },
    transform: billingEventsDeadLetter.ruleTarget,
  }
);

const stripeCustomerSubscriptionUpdatedSubscription = eventBus.subscribe(
  'stripe-customer-subscription-updated',
  {
    handler: 'apps/workers/src/events/stripe/customerSubscriptionUpdated.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, websocketApi, eventBus],
    vpc: lambdaVpc,
    timeout: '1 minute',
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    // Lumina5/Entitlements reconcile metrics (emitMetric in the handler).
    permissions: [
      {
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      },
      billingEventsDeadLetter.sendPermission,
    ],
    transform: billingEventsDeadLetter.functionTarget,
  },
  {
    pattern: {
      detailType: ['stripe.cus.sub.updated'],
    },
    transform: billingEventsDeadLetter.ruleTarget,
  }
);

billingEventsDeadLetter.allowRules([
  stripeInvoicePaymentSucceededSubscription,
  stripeCustomerSubscriptionUpdatedSubscription,
]);

// Email events
const emailEventsDLQ = new sst.aws.Queue('emailEventsDLQ', {
  transform: {
    queue: {
      messageRetentionSeconds: 1209600, // 14 days for forensics investigation
    },
  },
});
const emailEventsDeadLetter = createEventBusDeadLetter('emailEventsDLQ', emailEventsDLQ);

const emailSendSubscription = eventBus.subscribe(
  'email-send',
  {
    handler: 'apps/workers/src/events/sendEmail.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, websocketApi, eventBus],
    vpc: lambdaVpc,
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [emailEventsDeadLetter.sendPermission],
    transform: emailEventsDeadLetter.functionTarget,
  },
  {
    pattern: {
      detailType: ['email.send'],
    },
    transform: emailEventsDeadLetter.ruleTarget,
  }
);

emailEventsDeadLetter.allowRules([emailSendSubscription]);

// Session events
//
// Shared DLQ for the session enrichment handlers. EventBridge invokes these Lambdas
// asynchronously, so a failure can be lost on either side of the invoke:
// - the rule-target DLQ (sessionEnrichmentRuleDLQ) only sees events EventBridge could not
//   hand to Lambda at all;
// - once Lambda accepts the invoke, a thrown error, timeout or init crash is retried by
//   Lambda (2 retries) and then dropped unless the FUNCTION has a dead-letter target
//   (sessionEnrichmentFunctionDLQ). This is the side a real handler failure lands on.
// Alarm-only (no source queue to replay into; recovery is re-emitting the event), see
// infra/dlqAlarms.ts. Guarded by infra/__tests__/eventBusDlq.test.ts.
const sessionEnrichmentDLQ = new sst.aws.Queue('sessionEnrichmentDLQ', {
  transform: {
    queue: {
      messageRetentionSeconds: 1209600, // 14 days for forensics investigation
    },
  },
});

// Lambda delivers async-invoke failures to the DLQ with the function's own execution role.
const sessionEnrichmentDLQSendPermission = {
  actions: ['sqs:SendMessage'],
  resources: [sessionEnrichmentDLQ.arn],
};

// sst.aws.Function has no first-party async-invoke DLQ prop, so the underlying
// aws.lambda.Function's deadLetterConfig is set directly (same as fabFileModerationDLQ in
// infra/queues.ts).
const sessionEnrichmentFunctionDLQ = {
  function: {
    deadLetterConfig: { targetArn: sessionEnrichmentDLQ.arn },
  },
};

const sessionEnrichmentRuleDLQ = {
  target: {
    deadLetterConfig: { arn: sessionEnrichmentDLQ.arn },
  },
};

const sessionAutoNamingSubscription = eventBus.subscribe(
  'session-auto-name',
  {
    handler: 'apps/workers/src/events/sessionAutoNaming.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, fabFileBucket, generatedImagesBucket, appFilesBucket, eventBus],
    vpc: lambdaVpc,
    timeout: '1 minute',
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:*'],
        resources: ['*'],
      },
      sessionEnrichmentDLQSendPermission,
    ],
    transform: sessionEnrichmentFunctionDLQ,
  },
  {
    pattern: {
      detailType: ['session.auto_name'],
    },
    transform: sessionEnrichmentRuleDLQ,
  }
);

const sessionSummarizationSubscription = eventBus.subscribe(
  'session-summarize',
  {
    handler: 'apps/workers/src/events/sessionSummarization.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, websocketApi, eventBus, fabFileBucket, generatedImagesBucket, appFilesBucket],
    vpc: lambdaVpc,
    timeout: '1 minute',
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:*'],
        resources: ['*'],
      },
      sessionEnrichmentDLQSendPermission,
    ],
    transform: sessionEnrichmentFunctionDLQ,
  },
  {
    pattern: {
      detailType: ['session.summarize'],
    },
    transform: sessionEnrichmentRuleDLQ,
  }
);

const sessionContextSummarizationSubscription = eventBus.subscribe(
  'session-context-summarize',
  {
    handler: 'apps/workers/src/events/sessionContextSummarization.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, eventBus],
    vpc: lambdaVpc,
    timeout: '2 minutes',
    environment: { ...DEFAULT_LAMBDA_ENVIRONMENT },
    permissions: [{ actions: ['bedrock:*'], resources: ['*'] }, sessionEnrichmentDLQSendPermission],
    transform: sessionEnrichmentFunctionDLQ,
  },
  { pattern: { detailType: ['session.context_summarize'] }, transform: sessionEnrichmentRuleDLQ }
);

const sessionTaggingSubscription = eventBus.subscribe(
  'session-tag',
  {
    handler: 'apps/workers/src/events/sessionTagging.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, fabFileBucket, generatedImagesBucket, appFilesBucket, eventBus],
    vpc: lambdaVpc,
    timeout: '2 minutes',
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:*'],
        resources: ['*'],
      },
      sessionEnrichmentDLQSendPermission,
    ],
    transform: sessionEnrichmentFunctionDLQ,
  },
  {
    pattern: {
      detailType: ['session.tag'],
    },
    transform: sessionEnrichmentRuleDLQ,
  }
);

const sessionEnrichmentSubscriptions = [
  sessionAutoNamingSubscription,
  sessionSummarizationSubscription,
  sessionContextSummarizationSubscription,
  sessionTaggingSubscription,
];

// EventBridge delivers to a rule-target DLQ as the events.amazonaws.com service principal,
// so the queue needs a resource policy granting SendMessage, scoped to the session rules.
new aws.sqs.QueuePolicy('sessionEnrichmentDLQPolicy', {
  queueUrl: sessionEnrichmentDLQ.url,
  policy: $util
    .all([sessionEnrichmentDLQ.arn, $util.all(sessionEnrichmentSubscriptions.map(sub => sub.nodes.rule.arn))])
    .apply(([dlqArn, ruleArns]) =>
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'events.amazonaws.com' },
            Action: 'sqs:SendMessage',
            Resource: dlqArn,
            Condition: { ArnEquals: { 'aws:SourceArn': ruleArns } },
          },
        ],
      })
    ),
});

// Notebook Curation and Spider events share one dead letter (see infra/eventBusDeadLetter.ts).
const notebookEventsDLQ = new sst.aws.Queue('notebookEventsDLQ', {
  transform: {
    queue: {
      messageRetentionSeconds: 1209600, // 14 days for forensics investigation
    },
  },
});
const notebookEventsDeadLetter = createEventBusDeadLetter('notebookEventsDLQ', notebookEventsDLQ);

const notebookCurationStartSubscription = eventBus.subscribe(
  'notebook-curation-start',
  {
    handler: 'apps/workers/src/events/notebookCuration.handler',
    runtime: 'nodejs24.x',
    link: [
      ...allSecrets,
      websocketApi,
      eventBus,
      fabFileBucket,
      generatedImagesBucket,
      appFilesBucket,
      notebookCurationQueue,
    ],
    vpc: lambdaVpc,
    timeout: '1 minute',
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:*'],
        resources: ['*'],
      },
      notebookEventsDeadLetter.sendPermission,
    ],
    transform: notebookEventsDeadLetter.functionTarget,
  },
  {
    pattern: {
      detailType: ['notebook.curation.start'],
    },
    transform: notebookEventsDeadLetter.ruleTarget,
  }
);

// Notebook Curation Analytics - logs analytics when curation completes
const notebookCurationAnalyticsSubscription = eventBus.subscribe(
  'notebook-curation-complete-analytics',
  {
    handler: 'apps/workers/src/events/notebookCurationAnalytics.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, eventBus],
    vpc: lambdaVpc,
    timeout: '1 minute',
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [notebookEventsDeadLetter.sendPermission],
    transform: notebookEventsDeadLetter.functionTarget,
  },
  {
    pattern: {
      detailType: ['notebook.curation.complete'],
    },
    transform: notebookEventsDeadLetter.ruleTarget,
  }
);

// [DELETION-FOOTPRINT] Pi + Jira history-analysis EventBridge subscriptions
// ('pi-history-analysis-start', 'jira-history-analysis-start') moved to
// @bike4mind/premium-pi (contributeInfra in packages/premium/pi/src/infra.ts)
// during the Pi open-core carve. They attach to this same shared eventBus by
// reference (passed into contributeInfra), with byte-identical logical names for
// URN continuity. The `pi.*` event DEFINITIONS remain in
// apps/client/server/utils/eventBus.ts (referenced via the @server/* alias) —
// re-home'd at M2. The detailType wire strings are unchanged.

// Telemetry Alert events - sends Slack alerts and creates GitHub issues for context telemetry anomalies
// Processes alerts asynchronously so main Lambda can terminate without blocking
// Includes fingerprinting, deduplication, regression detection, and LLM priority determination
//
// Rule-target DLQ: EventBridge silently DROPS an event once the target's delivery retries
// are exhausted and no DLQ is configured - a failed alert delivery would vanish without
// trace. The deadLetterConfig on the rule target (set via transform.target below) captures
// those undeliverable events instead; the function's deadLetterConfig captures handler failures
// after Lambda's async retries (see infra/eventBusDeadLetter.ts). Alarmed in infra/dlqAlarms.ts.
const telemetryAlertRuleDLQ = new sst.aws.Queue('telemetryAlertRuleDLQ', {
  transform: {
    queue: {
      messageRetentionSeconds: 1209600, // 14 days for forensics investigation
    },
  },
});

const telemetryAlertSubscription = eventBus.subscribe(
  'telemetry-alert',
  {
    handler: 'apps/workers/src/events/telemetryAlert.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, websocketApi, eventBus],
    vpc: lambdaVpc,
    timeout: '60 seconds', // Increased from 30s to handle GitHub + LLM + Slack operations
    memory: '512 MB', // Increased memory for LLM operations
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:*'],
        resources: ['*'],
      },
      // Lambda delivers async-invoke failures to the DLQ with the function's own role.
      { actions: ['sqs:SendMessage'], resources: [telemetryAlertRuleDLQ.arn] },
    ],
    transform: {
      function: {
        deadLetterConfig: { targetArn: telemetryAlertRuleDLQ.arn },
      },
    },
  },
  {
    pattern: {
      detailType: ['telemetry.alert'],
    },
    transform: {
      target: {
        deadLetterConfig: {
          arn: telemetryAlertRuleDLQ.arn,
        },
      },
    },
  }
);

// EventBridge delivers to a rule-target DLQ as the events.amazonaws.com service principal,
// so the queue needs a resource policy granting SendMessage, scoped to this rule's ARN.
new aws.sqs.QueuePolicy('telemetryAlertRuleDLQPolicy', {
  queueUrl: telemetryAlertRuleDLQ.url,
  policy: $util.all([telemetryAlertRuleDLQ.arn, telemetryAlertSubscription.nodes.rule.arn]).apply(([dlqArn, ruleArn]) =>
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

// Spider events - comprehensive notebook grooming
const spiderSubscription = eventBus.subscribe(
  'spider-start',
  {
    handler: 'apps/workers/src/events/spider.handler',
    link: [...allSecrets, websocketApi, eventBus, fabFileBucket, generatedImagesBucket, appFilesBucket],
    vpc: lambdaVpc,
    timeout: '15 minutes', // Longer timeout for processing many notebooks
    memory: '1024 MB',
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:*'],
        resources: ['*'],
      },
      notebookEventsDeadLetter.sendPermission,
    ],
    transform: notebookEventsDeadLetter.functionTarget,
  },
  {
    pattern: {
      detailType: ['spider.start'],
    },
    transform: notebookEventsDeadLetter.ruleTarget,
  }
);

notebookEventsDeadLetter.allowRules([
  notebookCurationStartSubscription,
  notebookCurationAnalyticsSubscription,
  spiderSubscription,
]);

// Completion events. Defined here rather than in infra/llm.ts, which owns the rules, because
// SlackQuestProcessor (infra/functions.ts) needs the function side too and llm.ts imports it.
const completionEventsDLQ = new sst.aws.Queue('completionEventsDLQ', {
  transform: {
    queue: {
      messageRetentionSeconds: 1209600, // 14 days for forensics investigation
    },
  },
});
const completionEventsDeadLetter = createEventBusDeadLetter('completionEventsDLQ', completionEventsDLQ);

// SRE Diagnostician -> Surgeon handoff. The analysis handler emits
// sre.analysis.completed (apps/client/server/utils/eventBus.ts) and this rule
// routes it to sreFixQueue, replacing the former direct SQS dispatch. Gives a
// single seam for replay/inspection, and future consumers (audit, metrics)
// attach here without touching the analysis Lambda. Failed deliveries go to
// the existing sreFixQueueDLQ via the target's dead-letter config.
const sreFixDispatchSubscription = eventBus.subscribeQueue('SreFixDispatch', sreFixQueue, {
  pattern: {
    detailType: ['sre.analysis.completed'],
  },
  transform: {
    target: targetArgs => {
      targetArgs.deadLetterConfig = { arn: sreFixQueueDLQ.arn };
    },
  },
});

// EventBridge needs SendMessage on the DLQ to deliver failed events (the rule
// target's policy created by subscribeQueue only covers the main queue).
sst.aws.Queue.createPolicy('SreFixQueueDLQEventsPolicy', sreFixQueueDLQ.arn);

export {
  eventBus,
  telemetryAlertRuleDLQ,
  billingEventsDeadLetter,
  emailEventsDeadLetter,
  notebookEventsDeadLetter,
  completionEventsDeadLetter,
  sessionEnrichmentDLQ,
  sreFixDispatchSubscription,
  sessionAutoNamingSubscription,
  sessionSummarizationSubscription,
  sessionContextSummarizationSubscription,
  sessionTaggingSubscription,
  stripeInvoicePaymentSucceededSubscription,
  stripeCustomerSubscriptionUpdatedSubscription,
  spiderSubscription,
  telemetryAlertSubscription,
};
