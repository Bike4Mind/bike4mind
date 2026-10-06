import { appFilesBucketNotification } from './buckets';
import {
  fabFileBucketNotification,
  fabFileChunkQueueSubscription,
  fabFileVectorizeQueueSubscription,
  imageEditQueueSubscription,
  imageGenerationQueueSubscription,
  githubWebhookQueueSubscription,
  webhookDeliveryQueueSubscription,
  generationCallbackQueueSubscription,
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
  driveDisconnectPurgeQueueSubscription,
  githubLakeIngestQueueSubscription,
  githubLakeRevokeQueueSubscription,
  dataLakeTaxonomyQueueSubscription,
  dataLakeResearchQueueSubscription,
  videoGenerationQueueSubscription,
  generationJobQueueSubscription,
  overwatchAnalyticsQueueSubscription,
  sreJobQueue,
} from './queues';
import { emailParserQueueSubscription, emailAnalyzerQueueSubscription } from './emailIngestion';
import { emailBatchQueueSubscription, emailJobQueueSubscription } from './emailMarketing';
import { agentContinuationQueueSubscription, agentExecutor } from './agentExecutor';
import { agentExecutionAbandonedSweepCron, questTimeoutSweepCron } from './cron';
import { chatCompletion } from './chatCompletion';
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
  handler: 'apps/workers/src/events/logToSlack.ingest',
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

// CloudWatch pattern for Lambda lines in the default `ts\treqId\tLEVEL\tjsonPayload`
// format. Matches ERROR-level lines only.
const DEFAULT_ERROR_PATTERN = '[,,w3=ERROR,w4]';
const DEFAULT_ERROR_SUFFIX = 'errors';

// Runtime kill signals carry no ERROR token, so the default pattern never matches
// them. One optional-term pattern (OR semantics) on the AgentExecutor groups and
// both sweep crons, which are how a stalled or killed agent run surfaces.
// `Runtime exited with error` covers
// non-zero exits; `"signal: killed"` covers the SIGKILL/OOM path a Lambda logs.
const KILLS_PATTERN = '?"Task timed out" ?"Runtime.OutOfMemory" ?"signal: killed" ?"Runtime exited with error"';

// Fargate containers do not write the Lambda runtime prefix; they emit the logger's
// raw JSON line (`{..., "severity":"error","message":...}`), so a positional Lambda
// filter never matches. Match the JSON severity field directly instead.
const FARGATE_ERROR_PATTERN = '{ $.severity = "error" }';

interface LogSubscriptionSpec {
  logGroup: string;
  pattern: string;
  suffix: string;
}

// Stable, index-independent name for a log group, used to derive the subscription
// resource id. Strips the prefixes SST/AWS prepend so the id stays short and human
// readable (`/aws/lambda/foo` -> `foo`, `/sst/cluster/.../ChatCompletion...` -> ...).
function sanitizeLogGroupName(logGroupName: string): string {
  return logGroupName
    .replace(/^\/aws\/lambda\//, '') // Remove AWS Lambda prefix
    .replace(/^\/sst\/cluster\//, '') // Remove SST Fargate cluster prefix
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 64); // Keep reasonable length
}

// Helper function to create log subscription filters with stable resource names
function createLogSubscriptions(specs: LogSubscriptionSpec[]) {
  const subscriptionFilters: aws.cloudwatch.LogSubscriptionFilter[] = [];

  specs.forEach(({ logGroup, pattern, suffix }) => {
    const sanitizedName = sanitizeLogGroupName(logGroup);

    // Resource name is stable per log group + filter kind (never the array index), so
    // adding or removing a log group does not recreate the others. The default ERROR
    // filter keeps its historical `logSub-<name>` resource name - renaming it would
    // recreate every existing subscription - while additional filters (kills, Fargate
    // JSON errors) carry their kind as a suffix.
    const resourceName =
      suffix === DEFAULT_ERROR_SUFFIX ? `logSub-${sanitizedName}` : `logSub-${sanitizedName}-${suffix}`;

    const filter = new aws.cloudwatch.LogSubscriptionFilter(
      resourceName,
      {
        logGroup,
        destinationArn: logHandler.arn,
        filterPattern: pattern,
        name: `${sanitizedName}-${suffix}`,
      },
      {
        dependsOn: [logHandler, logHandlerInvokePermission],
        deleteBeforeReplace: true, // Force deletion before creating new subscription to avoid hitting the 2-subscription limit
        retainOnDelete: false, // Ensure clean deletion when removed
      }
    );

    subscriptionFilters.push(filter);
  });

  console.log(`Created ${subscriptionFilters.length} log subscription filters for ${specs.length} log groups`);
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
  generationCallbackQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
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
  driveDisconnectPurgeQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  githubLakeIngestQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  githubLakeRevokeQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  dataLakeTaxonomyQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  dataLakeResearchQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  videoGenerationQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  generationJobQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  overwatchAnalyticsQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  emailParserQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  emailAnalyzerQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  emailBatchQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  emailJobQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  agentContinuationQueueSubscription.nodes.function.nodes.logGroup.apply(lg => lg?.name),
  // Agent runs that stall/crash and the sweeps that detect them previously had no
  // subscription, so LiveOps only heard about them if a user complained (GH #3228).
  agentExecutor.nodes.logGroup.apply(lg => lg?.name),
  questTimeoutSweepCron.nodes.function.apply(fn => fn.nodes.logGroup.apply(lg => lg?.name)),
  agentExecutionAbandonedSweepCron.nodes.function.apply(fn => fn.nodes.logGroup.apply(lg => lg?.name)),
]);

let logSubscriptions: $util.Output<aws.cloudwatch.LogSubscriptionFilter[]> = $util.output([]);

// Do not create log subscriptions in local environments
if (!$dev) {
  // Additional filters that do not use the default Lambda ERROR pattern: a second
  // "kills" filter on the AgentExecutor groups and both sweep crons (AWS allows at most
  // 2 subscription filters per log group, and these now use both) and the ChatCompletion
  // Fargate group's JSON error filter.
  const agentExecutorLogGroup = agentExecutor.nodes.logGroup.apply(lg => lg?.name);
  const questTimeoutSweepLogGroup = questTimeoutSweepCron.nodes.function.apply(fn =>
    fn.nodes.logGroup.apply(lg => lg?.name)
  );
  const agentExecutionAbandonedSweepLogGroup = agentExecutionAbandonedSweepCron.nodes.function.apply(fn =>
    fn.nodes.logGroup.apply(lg => lg?.name)
  );
  const agentContinuationLogGroup = agentContinuationQueueSubscription.nodes.function.nodes.logGroup.apply(
    lg => lg?.name
  );
  // ChatCompletion's log group is not exposed as an SST node; read its name from the
  // task definition's awslogs configuration instead. SST derives that name from the
  // physical name (`physicalName(64, name)` adds a suffix), so a hard-coded string
  // would silently point at a non-existent group.
  const chatCompletionLogGroup = chatCompletion.nodes.taskDefinition
    .apply(taskDefinition => taskDefinition.containerDefinitions)
    .apply(json => {
      const containerDefinitions = JSON.parse(json) as Array<{
        logConfiguration?: { options?: Record<string, string> };
      }>;
      const logGroupName = containerDefinitions[0]?.logConfiguration?.options?.['awslogs-group'];
      if (!logGroupName) {
        throw new Error('Could not resolve the ChatCompletion container log group from its task definition');
      }
      return logGroupName;
    });

  const extraLogGroups = $util
    .all([
      agentExecutorLogGroup,
      agentContinuationLogGroup,
      questTimeoutSweepLogGroup,
      agentExecutionAbandonedSweepLogGroup,
    ])
    .apply(([agentExecutorGroup, continuationGroup, questSweepGroup, abandonedSweepGroup]) => {
      const specs: LogSubscriptionSpec[] = [];
      if (agentExecutorGroup) specs.push({ logGroup: agentExecutorGroup, pattern: KILLS_PATTERN, suffix: 'kills' });
      if (continuationGroup) specs.push({ logGroup: continuationGroup, pattern: KILLS_PATTERN, suffix: 'kills' });
      if (questSweepGroup) specs.push({ logGroup: questSweepGroup, pattern: KILLS_PATTERN, suffix: 'kills' });
      if (abandonedSweepGroup) specs.push({ logGroup: abandonedSweepGroup, pattern: KILLS_PATTERN, suffix: 'kills' });
      return specs;
    });

  const chatCompletionSubscriptions = chatCompletionLogGroup.apply(group =>
    createLogSubscriptions([{ logGroup: group, pattern: FARGATE_ERROR_PATTERN, suffix: DEFAULT_ERROR_SUFFIX }])
  );

  // Combine all log groups when ready - simplified approach
  const allLogGroups = $util.all([
    individualLogGroups,
    appFilesBucketLogGroups,
    fabFileBucketLogGroups,
    webServerLogGroup,
    extraLogGroups,
  ]);

  const sharedSubscriptions = allLogGroups.apply(([individual, appFilesBucket, fabFileBucket, webServer, extras]) => {
    // Flatten all log group names into a single array, filtering out undefined values
    const logGroups = [...individual, ...appFilesBucket, ...fabFileBucket, ...(webServer ? [webServer] : [])].filter(
      logGroupName => logGroupName !== undefined
    );

    const defaultSpecs: LogSubscriptionSpec[] = logGroups.map(logGroup => ({
      logGroup,
      pattern: DEFAULT_ERROR_PATTERN,
      suffix: DEFAULT_ERROR_SUFFIX,
    }));

    return createLogSubscriptions([...defaultSpecs, ...extras]);
  });

  logSubscriptions = $util
    .all([sharedSubscriptions, chatCompletionSubscriptions])
    .apply(([shared, chat]) => [...shared, ...chat]);
}

export { logHandler, logSubscriptions };
