import { appFilesBucketNotification } from './buckets';
import {
  fabFileBucketNotification,
  fabFileChunkQueueSubscription,
  fabFileVectorizeQueueSubscription,
  imageEditQueueSubscription,
  imageGenerationQueueSubscription,
  githubWebhookQueueSubscription,
  webhookDeliveryQueueSubscription,
  liveOpsTriageQueueSubscription,
  secopsTriageQueueSubscription,
  notebookCurationQueueSubscription,
  agentProactiveMessageQueueSubscription,
  whatsNewGenerationQueueSubscription,
  whatsNewHighlightsQueueSubscription,
  researchEngineQueueSubscription,
  slackExportQueueSubscription,
  questExportQueueSubscription,
  dataLakeCleanupQueueSubscription,
  videoGenerationQueueSubscription,
  overwatchAnalyticsQueueSubscription,
  sreJobQueue,
} from './queues';
import { emailParserQueueSubscription, emailAnalyzerQueueSubscription } from './emailIngestion';
import { emailBatchQueueSubscription, emailJobQueueSubscription } from './emailMarketing';
import { agentContinuationQueueSubscription } from './agentExecutor';
import {
  sessionAutoNamingSubscription,
  sessionSummarizationSubscription,
  sessionTaggingSubscription,
  stripeInvoicePaymentSucceededSubscription,
  stripeCustomerSubscriptionUpdatedSubscription,
} from './eventBus';
import { allSecrets } from './secrets';
import { web } from './web';
import { mcpHandler } from './mcp';
import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { lambdaVpc } from './vpc';
import { imageProcessor } from './functions';

// Log handler function for processing CloudWatch logs and sending to Slack
const logHandler = new sst.aws.Function('logHandler', {
  handler: 'apps/client/server/events/logToSlack.ingest',
  runtime: 'nodejs24.x',
  link: [...allSecrets, sreJobQueue],
  vpc: lambdaVpc,
  logging: {
    retention: '3 days',
  },
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  dev: false, // Disable live dev for log handler to avoid recursion
});

// Grant CloudWatch Logs permissions to invoke the log handler function
const logHandlerInvokePermission = new aws.lambda.Permission(
  'logHandlerInvokePermission',
  {
    action: 'lambda:InvokeFunction',
    function: logHandler.arn,
    principal: 'logs.amazonaws.com',
    sourceArn: $interpolate`arn:aws:logs:${aws.config.region}:${aws.getCallerIdentity().then(id => id.accountId)}:*`,
  },
  {
    dependsOn: [logHandler],
  }
);

// Helper function to create log subscription filters with stable resource names
function createLogSubscriptions(logGroups: string[]) {
  const subscriptionFilters: aws.cloudwatch.LogSubscriptionFilter[] = [];

  logGroups.forEach(logGroupName => {
    // Create stable resource names based on log group name (not index)
    // This prevents recreation when lambdas are added/removed from the array
    const sanitizedName = logGroupName
      .replace(/^\/aws\/lambda\//, '') // Remove AWS prefix
      .replace(/[^a-zA-Z0-9]/g, '-')
      .replace(/-+/g, '-')
      .substring(0, 64); // Keep reasonable length

    // Create traditional error filter
    const traditionalFilter = new aws.cloudwatch.LogSubscriptionFilter(
      `logSub-${sanitizedName}`,
      {
        logGroup: logGroupName,
        destinationArn: logHandler.arn,
        filterPattern: '[,,w3=ERROR,w4]',
        name: `${sanitizedName}-errors`,
      },
      {
        dependsOn: [logHandler, logHandlerInvokePermission],
        deleteBeforeReplace: true, // Force deletion before creating new subscription to avoid hitting the 2-subscription limit
        retainOnDelete: false, // Ensure clean deletion when removed
      }
    );

    subscriptionFilters.push(traditionalFilter);
  });

  console.log(`Created ${subscriptionFilters.length} log subscription filters for ${logGroups.length} log groups`);
  return subscriptionFilters;
}

// First, collect bucket notification functions separately
const appFilesBucketLogGroups = appFilesBucketNotification.nodes.functions.apply(functions =>
  $util.all(functions.map(f => f.nodes.logGroup.apply(lg => lg?.name)))
);
// const historyImportBucketLogGroups = historyImportBucketNotification.nodes.functions.apply(functions =>
//   $util.all(functions.map(f => f.nodes.logGroup.apply(lg => lg?.name)))
// );
const fabFileBucketLogGroups = fabFileBucketNotification.nodes.functions.apply(functions =>
  $util.all(functions.map(f => f.nodes.logGroup.apply(lg => lg?.name)))
);

// Handle optional web server log group
const webServerLogGroup = web.nodes.server ? web.nodes.server.nodes.logGroup.apply(lg => lg?.name) : undefined;

// Collect all individual log group outputs
const individualLogGroups = $util.all([
  fabFileChunkQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  fabFileVectorizeQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  imageGenerationQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  imageEditQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  imageProcessor.nodes.logGroup.apply(lg => lg?.name),
  mcpHandler.nodes.logGroup.apply(lg => lg?.name),
  sessionAutoNamingSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  sessionSummarizationSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  sessionTaggingSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  stripeInvoicePaymentSucceededSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  stripeCustomerSubscriptionUpdatedSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  // Queue handlers not previously monitored — gaps exposed by prod incident 2026-05-09
  githubWebhookQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  webhookDeliveryQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  liveOpsTriageQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  secopsTriageQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  notebookCurationQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  agentProactiveMessageQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  whatsNewGenerationQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  whatsNewHighlightsQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  researchEngineQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  slackExportQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  questExportQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  dataLakeCleanupQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  videoGenerationQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  overwatchAnalyticsQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  emailParserQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  emailAnalyzerQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  emailBatchQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  emailJobQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  agentContinuationQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
]);

let logSubscriptions: $util.Output<aws.cloudwatch.LogSubscriptionFilter[]> = $util.output([]);

// Do not create log subscriptions in local environments
if (!$dev) {
  // Combine all log groups when ready - simplified approach
  const allLogGroups = $util.all([
    individualLogGroups,
    appFilesBucketLogGroups,
    fabFileBucketLogGroups,
    webServerLogGroup,
  ]);

  logSubscriptions = allLogGroups.apply(([individual, appFilesBucket, fabFileBucket, webServer]) => {
    // Flatten all log group names into a single array, filtering out undefined values
    const logGroups = [...individual, ...appFilesBucket, ...fabFileBucket, ...(webServer ? [webServer] : [])].filter(
      logGroupName => logGroupName !== undefined
    );

    // Create log subscriptions and return them
    return createLogSubscriptions(logGroups);
  });
}

export { logHandler, logSubscriptions };
