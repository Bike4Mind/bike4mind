import { allSecrets } from './secrets';
import { websocketApi } from './websocket';
import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { lambdaVpc } from './vpc';
import { fabFileBucket, generatedImagesBucket, appFilesBucket } from './buckets';
import { eventBus } from './bus';
import { notebookCurationQueue, sreFixQueue, sreFixQueueDLQ } from './queues';

// Stripe events
const stripeInvoicePaymentSucceededSubscription = eventBus.subscribe(
  'stripe-invoice-payment-succeeded',
  {
    handler: 'apps/client/server/events/stripe/invoicePaymentSucceeded.handler',
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
    ],
  },
  {
    pattern: {
      detailType: ['stripe.invoice.payment_succeeded'],
    },
  }
);

const stripeCustomerSubscriptionUpdatedSubscription = eventBus.subscribe(
  'stripe-customer-subscription-updated',
  {
    handler: 'apps/client/server/events/stripe/customerSubscriptionUpdated.handler',
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
    ],
  },
  {
    pattern: {
      detailType: ['stripe.cus.sub.updated'],
    },
  }
);

// Email events
eventBus.subscribe(
  'email-send',
  {
    handler: 'apps/client/server/events/sendEmail.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, websocketApi, eventBus],
    vpc: lambdaVpc,
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
  },
  {
    pattern: {
      detailType: ['email.send'],
    },
  }
);

// Session events
const sessionAutoNamingSubscription = eventBus.subscribe(
  'session-auto-name',
  {
    handler: 'apps/client/server/events/sessionAutoNaming.handler',
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
    ],
  },
  {
    pattern: {
      detailType: ['session.auto_name'],
    },
  }
);

const sessionSummarizationSubscription = eventBus.subscribe(
  'session-summarize',
  {
    handler: 'apps/client/server/events/sessionSummarization.handler',
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
    ],
  },
  {
    pattern: {
      detailType: ['session.summarize'],
    },
  }
);

const sessionContextSummarizationSubscription = eventBus.subscribe(
  'session-context-summarize',
  {
    handler: 'apps/client/server/events/sessionContextSummarization.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, eventBus],
    vpc: lambdaVpc,
    timeout: '2 minutes',
    environment: { ...DEFAULT_LAMBDA_ENVIRONMENT },
    permissions: [{ actions: ['bedrock:*'], resources: ['*'] }],
  },
  { pattern: { detailType: ['session.context_summarize'] } }
);

const sessionTaggingSubscription = eventBus.subscribe(
  'session-tag',
  {
    handler: 'apps/client/server/events/sessionTagging.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, fabFileBucket, generatedImagesBucket, appFilesBucket, eventBus],
    vpc: lambdaVpc,
    timeout: '2 minutes',
    logging: {
      retention: '1 day',
    },
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
    permissions: [
      {
        actions: ['bedrock:*'],
        resources: ['*'],
      },
    ],
  },
  {
    pattern: {
      detailType: ['session.tag'],
    },
  }
);

// Notebook Curation events
eventBus.subscribe(
  'notebook-curation-start',
  {
    handler: 'apps/client/server/events/notebookCuration.handler',
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
    ],
  },
  {
    pattern: {
      detailType: ['notebook.curation.start'],
    },
  }
);

// Notebook Curation Analytics - logs analytics when curation completes
eventBus.subscribe(
  'notebook-curation-complete-analytics',
  {
    handler: 'apps/client/server/events/notebookCurationAnalytics.handler',
    runtime: 'nodejs24.x',
    link: [...allSecrets, eventBus],
    vpc: lambdaVpc,
    timeout: '1 minute',
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
    },
  },
  {
    pattern: {
      detailType: ['notebook.curation.complete'],
    },
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
// those undeliverable events instead. Alarmed in infra/dlqAlarms.ts.
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
    handler: 'apps/client/server/events/telemetryAlert.handler',
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
    ],
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
    handler: 'apps/client/server/events/spider.handler',
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
    ],
  },
  {
    pattern: {
      detailType: ['spider.start'],
    },
  }
);

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
