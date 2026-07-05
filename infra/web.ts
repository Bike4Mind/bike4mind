import {
  appFilesBucket,
  fabFileBucket,
  generatedImagesBucket,
  publishedArtifactsBucket,
  historyImportBucket,
  whatsNewDistributionBucket,
  uploadCompleteFunction,
  notebookImportFunction,
} from './buckets';
import { DEFAULT_LAMBDA_ENVIRONMENT, PRODUCTION_STAGES } from './constants';
import { attackSimulationFunction } from './cron';
import { emailJobQueue, emailBatchQueue, emailBatchQueueDLQ, emailJobQueueDLQ } from './emailMarketing';
import {
  emailIngestionQueue,
  emailAnalysisQueue,
  emailIngestionQueueDLQ,
  emailAnalysisQueueDLQ,
} from './emailIngestion';
import { eventBus } from './eventBus';
import { slackEventBus } from './bus';
import { mcpHandler } from './mcp';
import { cliLlmHandler } from './cliLlmHandler';
import { cliWsCompletionHandler } from './cliWsCompletionHandler';
import {
  fabFileChunkQueue,
  fabFileVectorizeQueue,
  imageEditQueue,
  imageGenerationQueue,
  videoGenerationQueue,
  researchEngineQueue,
  agentProactiveMessageQueue,
  slackExportQueue,
  githubWebhookQueue,
  questExportQueue,
  whatsNewGenerationQueue,
  whatsNewHighlightsQueue,
  notebookCurationQueue,
  webhookDeliveryQueue,
  liveOpsTriageQueue,
  // DLQ exports used by the dlqUrls Linkable (not directly linked to avoid IAM bloat).
  fabFileChunkQueueDLQ,
  fabFileVectorizeQueueDLQ,
  imageGenerationDLQ,
  imageEditDLQ,
  videoGenerationDLQ,
  researchEngineQueueDLQ,
  whatsNewGenerationQueueDLQ,
  whatsNewHighlightsQueueDLQ,
  notebookCurationQueueDLQ,
  agentProactiveMessageQueueDLQ,
  slackExportQueueDLQ,
  githubWebhookQueueDLQ,
  webhookDeliveryQueueDLQ,
  questExportQueueDLQ,
  liveOpsTriageQueueDLQ,
  tavernHeartbeatQueue,
  tavernHeartbeatQueueDLQ,
  deepAgentWakeQueue,
  deepAgentWakeQueueDLQ,
  sreFixQueue,
  sreJobQueue,
  sreFixQueueDLQ,
  sreJobQueueDLQ,
  secopsTriageQueue,
  secopsTriageQueueDLQ,
  overwatchAnalyticsQueue,
  overwatchAnalyticsQueueDLQ,
  agentContinuationQueue,
  agentContinuationQueueDLQ,
  optihashiRunCompletionQueue,
  optihashiRunCompletionQueueDLQ,
} from './queues';
import { imageProcessor } from './functions';
import { questProcessorService } from './questProcessorService';
import { router, routerDistributionId, whatsNewDistributionId, cdnUrlForLambdaEnv } from './router';
import { secrets } from './secrets';
import { migratorInvocation } from './database';
import { websocketApi } from './websocket';
import { lambdaVpc } from './vpc';
import { wafWebAclArn } from './waf';

// SQS queue URLs bundled as Linkable resources. Stored in resource.enc at deploy
// time — no IAM statements generated, no env var size concerns. The wildcard SQS
// permission already grants runtime access to all queues.
const dlqUrls = new sst.Linkable('dlqUrls', {
  properties: {
    'fab-file-vectorize': fabFileVectorizeQueueDLQ.url,
    'fab-file-chunk': fabFileChunkQueueDLQ.url,
    'image-generation': imageGenerationDLQ.url,
    'image-edit': imageEditDLQ.url,
    'video-generation': videoGenerationDLQ.url,
    'research-engine': researchEngineQueueDLQ.url,
    'whats-new-generation': whatsNewGenerationQueueDLQ.url,
    'whats-new-highlights': whatsNewHighlightsQueueDLQ.url,
    'notebook-curation': notebookCurationQueueDLQ.url,
    'agent-proactive-message': agentProactiveMessageQueueDLQ.url,
    'slack-export': slackExportQueueDLQ.url,
    'github-webhook': githubWebhookQueueDLQ.url,
    'webhook-delivery': webhookDeliveryQueueDLQ.url,
    'quest-export': questExportQueueDLQ.url,
    'liveops-triage': liveOpsTriageQueueDLQ.url,
    'email-ingestion': emailIngestionQueueDLQ.url,
    'email-analysis': emailAnalysisQueueDLQ.url,
    'email-batch': emailBatchQueueDLQ.url,
    'email-job': emailJobQueueDLQ.url,
    'tavern-heartbeat': tavernHeartbeatQueueDLQ.url,
    'deep-agent-wake': deepAgentWakeQueueDLQ.url,
    'sre-fix': sreFixQueueDLQ.url,
    'sre-job': sreJobQueueDLQ.url,
    'secops-triage': secopsTriageQueueDLQ.url,
    'overwatch-analytics': overwatchAnalyticsQueueDLQ.url,
    'agent-continuation': agentContinuationQueueDLQ.url,
    'optihashi-run-completion': optihashiRunCompletionQueueDLQ.url,
  },
});

// Lambda function names exposed via sst.Linkable to avoid generating per-resource IAM
// statements when the frontend only needs the function *name* for invocation. The wildcard
// `lambda:InvokeFunction` permission below already grants runtime invocation access.
const lambdaFunctionNames = new sst.Linkable('lambdaFunctionNames', {
  properties: {
    attackSimulation: attackSimulationFunction.name,
  },
});

const sourceQueueUrls = new sst.Linkable('sourceQueueUrls', {
  properties: {
    emailJobQueue: emailJobQueue.url,
    fabFileChunkQueue: fabFileChunkQueue.url,
    fabFileVectorizeQueue: fabFileVectorizeQueue.url,
    imageGenerationQueue: imageGenerationQueue.url,
    imageEditQueue: imageEditQueue.url,
    videoGenerationQueue: videoGenerationQueue.url,
    researchEngineQueue: researchEngineQueue.url,
    agentProactiveMessageQueue: agentProactiveMessageQueue.url,
    slackExportQueue: slackExportQueue.url,
    githubWebhookQueue: githubWebhookQueue.url,
    questExportQueue: questExportQueue.url,
    whatsNewHighlightsQueue: whatsNewHighlightsQueue.url,
    whatsNewGenerationQueue: whatsNewGenerationQueue.url,
    liveOpsTriageQueue: liveOpsTriageQueue.url,
    notebookCurationQueue: notebookCurationQueue.url,
    webhookDeliveryQueue: webhookDeliveryQueue.url,
    emailBatchQueue: emailBatchQueue.url,
    emailIngestionQueue: emailIngestionQueue.url,
    emailAnalysisQueue: emailAnalysisQueue.url,
    tavernHeartbeatQueue: tavernHeartbeatQueue.url,
    deepAgentWakeQueue: deepAgentWakeQueue.url,
    sreFixQueue: sreFixQueue.url,
    sreJobQueue: sreJobQueue.url,
    secopsTriageQueue: secopsTriageQueue.url,
    overwatchAnalyticsQueue: overwatchAnalyticsQueue.url,
    agentContinuationQueue: agentContinuationQueue.url,
    optihashiRunCompletionQueue: optihashiRunCompletionQueue.url,
  },
});

export const web = new sst.aws.Nextjs(
  'frontend',
  {
    path: 'apps/client',
    openNextVersion: '3.9.16',

    vpc: lambdaVpc,
    router: router ? { instance: router } : undefined,
    server: {
      timeout: '60 seconds',
      runtime: 'nodejs24.x',
      // Lambda CPU scales linearly with memory (1769 MB = 1 full vCPU). The default
      // 1024 MB (~0.58 vCPU) makes the cold start parse-bound: booting Next + parsing
      // the ~5-6 MB server bundle dominates INIT. Bumping to 2048 MB (~1.16 vCPU) ~2x
      // CPU to cut cold-start latency. Applied to all stages so staging is a faithful
      // cold-start proxy for prod. See docs/perf/mobile-startup-latency.md (M1.1).
      memory: '2048 MB',
    },
    link: [
      ...Object.values(secrets),
      websocketApi,
      historyImportBucket,
      // Linked so the frontend can resolve Resource.QuestProcessorService.url to POST quests.
      questProcessorService,
      imageProcessor,
      mcpHandler,
      cliLlmHandler,
      cliWsCompletionHandler,
      fabFileBucket,
      generatedImagesBucket,
      appFilesBucket,
      publishedArtifactsBucket,
      eventBus,
      slackEventBus,
      uploadCompleteFunction,
      notebookImportFunction,
      lambdaFunctionNames,
      routerDistributionId,
      // WafWebAclArn is a Linkable (not a direct SST resource link) to avoid generating
      // per-resource IAM statements that could push the frontend Lambda over the 10KB limit.
      ...(wafWebAclArn ? [wafWebAclArn] : []),
      // SQS queue URLs passed via sst.Linkable to avoid IAM inline policy bloat.
      // Linkable stores properties in resource.enc without generating IAM statements.
      // Wildcard SQS permission (below) already grants access to all queues.
      dlqUrls,
      sourceQueueUrls,
      ...(whatsNewDistributionBucket ? [whatsNewDistributionBucket] : []),
      ...(whatsNewDistributionId ? [whatsNewDistributionId] : []),
    ],
    permissions: [
      {
        actions: ['bedrock:*'],
        resources: ['*'],
      },
      {
        // Image content moderation (#9776): /api/chat?wait=true and /api/opti run the tool loop
        // inline in this Lambda, so the image_generation/edit_image tools' moderation gate calls
        // DetectModerationLabels here. Without this the gate fails closed and breaks image gen.
        actions: ['rekognition:DetectModerationLabels'],
        resources: ['*'],
      },
      {
        actions: [
          'transcribe:StartTranscriptionJob',
          'transcribe:GetTranscriptionJob',
          'transcribe:ListTranscriptionJobs',
          'transcribe:DeleteTranscriptionJob',
        ],
        resources: ['*'],
      },
      {
        actions: [
          'cloudtrail:LookupEvents',
          'cloudtrail:GetTrail',
          'cloudtrail:DescribeTrails',
          'cloudtrail:GetTrailStatus',
          'cloudtrail:GetEventSelectors',
          'config:DescribeConfigRules',
          'config:GetComplianceSummaryByConfigRule',
          'config:GetComplianceDetailsByConfigRule',
          'config:DescribeConfigurationRecorders',
          'config:DescribeDeliveryChannels',
          'lambda:InvokeFunction',
        ],
        resources: ['*'],
      },
      {
        actions: ['events:PutEvents'],
        resources: ['*'],
      },
      {
        // Read-only account-level summary used by CloudSecurityScan to verify root MFA status.
        actions: ['iam:GetAccountSummary'],
        resources: ['*'],
      },
      {
        // Cloud Security Scan — S3 baseline controls (public access block + encryption check).
        actions: ['s3:ListAllMyBuckets', 's3:GetBucketPublicAccessBlock', 's3:GetEncryptionConfiguration'],
        resources: ['*'],
      },
      {
        // Cloud Security Scan — open security group detection.
        actions: ['ec2:DescribeSecurityGroups'],
        resources: ['*'],
      },
      {
        // Cloud Security Scan — IAM users without MFA (credential report) + wildcard policy detection.
        actions: [
          'iam:GenerateCredentialReport',
          'iam:GetCredentialReport',
          'iam:ListPolicies',
          'iam:GetPolicyVersion',
        ],
        resources: ['*'],
      },
      {
        // Cloud Security Scan — Secrets Manager rotation check.
        actions: ['secretsmanager:ListSecrets'],
        resources: ['*'],
      },
      {
        // Explicit SQS permissions for GitHub webhook queue
        // (not relying on SST implicit linking permissions)
        actions: ['sqs:SendMessage'],
        resources: [githubWebhookQueue.arn],
      },
      {
        // CloudWatch metrics for What's New modal sync and generation
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      },
      {
        // SQS permissions for admin DLQ replay: receive from DLQs, send to source queues, get attributes
        actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:SendMessage'],
        resources: ['*'],
      },
      {
        // CloudFront cache invalidation for What's New modal edit/delete
        actions: ['cloudfront:CreateInvalidation'],
        resources: [
          $interpolate`arn:aws:cloudfront::${aws.getCallerIdentityOutput().accountId}:distribution/${router.distributionID}`,
        ],
      },
      {
        // Read-only CloudFront GetDistribution access used by WAF Traffic/Logs Insights
        // to retrieve the WebACL ARN attached to the Router distribution.
        // Scoped to the Router distribution specifically — the only distribution queried for WebACL ARN discovery.
        actions: ['cloudfront:GetDistribution'],
        resources: [
          $interpolate`arn:aws:cloudfront::${aws.getCallerIdentityOutput().accountId}:distribution/${router.distributionID}`,
        ],
      },
      {
        // Read-only CloudWatch metrics access used by the WAF Traffic Overview panel.
        // Scoped to AWS/WAFV2 namespace metrics only.
        actions: ['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics'],
        resources: ['*'],
      },
      {
        // Read-only WAF logging config discovery used by the WAF Logs Insights panels.
        // Scoped to CloudFront-scope WebACLs in us-east-1 only, further restricted to
        // bike4mind-api-protection-* WebACLs to enforce least privilege.
        actions: ['wafv2:GetLoggingConfiguration'],
        resources: [
          $interpolate`arn:aws:wafv2:us-east-1:${aws.getCallerIdentityOutput().accountId}:global/webacl/bike4mind-api-protection-*`,
        ],
      },
      {
        // CloudWatch Logs Insights query permissions for WAF log analysis.
        // Scoped to us-east-1 (CloudFront-scope WAF always logs to us-east-1) and
        // bike4mind-specific log groups to enforce least privilege.
        actions: ['logs:StartQuery', 'logs:GetQueryResults', 'logs:StopQuery'],
        resources: [
          $interpolate`arn:aws:logs:us-east-1:${aws.getCallerIdentityOutput().accountId}:log-group:aws-waf-logs-bike4mind-*`,
        ],
      },
    ],
    environment: {
      ...DEFAULT_LAMBDA_ENVIRONMENT,
      NEXT_PUBLIC_WEBSOCKET_URL: websocketApi.url,
      NEXT_PUBLIC_SERVER_DOMAIN: process.env.SERVER_DOMAIN || '',
      APP_URL: $dev ? 'http://localhost:3000' : router.url,
      // Brand name + marketing URL inlined into the client bundle at build time; no brand
      // fallback (issue #9310). Empty == client renders without a product name / external links.
      NEXT_PUBLIC_APP_NAME: process.env.APP_NAME || '',
      NEXT_PUBLIC_WEBSITE_URL: process.env.WEBSITE_URL || '',
      // Operator blog host for the optional blog-integration feature (open-core #9392). Inlined
      // into the client bundle AND read by the proxy CSP (apps/client/proxy.ts) at runtime; no
      // brand fallback. Empty == blog integration ships without a default host and the CSP omits it.
      NEXT_PUBLIC_BLOG_HOST: process.env.BLOG_HOST || '',
      // Share-footer theming (open-core #9392). SHARE_BUILTIN_LOGO=true opts into the project's own
      // inline wordmark on published share pages; a fork leaves it unset and gets a text wordmark of
      // its brand name. The SHARE_BRAND_* colors are optional palette overrides (default in source).
      NEXT_PUBLIC_SHARE_BUILTIN_LOGO: process.env.SHARE_BUILTIN_LOGO || '',
      NEXT_PUBLIC_SHARE_BRAND_NAVY: process.env.SHARE_BRAND_NAVY || '',
      NEXT_PUBLIC_SHARE_BRAND_LIME: process.env.SHARE_BRAND_LIME || '',
      NEXT_PUBLIC_SHARE_BRAND_ORANGE: process.env.SHARE_BRAND_ORANGE || '',
      // Account-tied brand logo for transactional emails; no brand fallback (issue #9306).
      // Empty == emails render without a logo. See getLogoUrl() in mailer/emailHelpers.
      LOGO_URL: process.env.LOGO_URL || '',
      // Personal `sst dev` stages serve files from the local dev proxy
      // (apps/client/pages/api/app-files/serve) instead of the shared CloudFront
      // router — this avoids the shared router's KVS routing-table growth. The
      // relative base resolves same-origin (localhost:3000). Deployed stages keep
      // the real distribution URL.
      NEXT_PUBLIC_CDN_URL: cdnUrlForLambdaEnv(),
      // GA4 only enabled on production — staging and preview environments are excluded to prevent
      // test traffic from polluting production analytics. The measurement ID is account-tied, so it
      // comes from the GA_MEASUREMENT_ID env var with no brand fallback (empty == analytics disabled).
      ...($app.stage === 'production' && process.env.GA_MEASUREMENT_ID
        ? { NEXT_PUBLIC_GA_MEASUREMENT_ID: process.env.GA_MEASUREMENT_ID }
        : {}),
      // Reddit ads pixel: production-only for the same reason as GA4 above, and account-tied with
      // no brand fallback (empty == pixel disabled). Consent-deferred loading + the signup
      // conversion event live in apps/client/app/utils/redditPixel.ts / signupConversion.ts.
      ...($app.stage === 'production' && process.env.REDDIT_PIXEL_ID
        ? { NEXT_PUBLIC_REDDIT_PIXEL_ID: process.env.REDDIT_PIXEL_ID }
        : {}),
    },
    // warm pings invoke the handler, keeping the lazy OpenNext bundle resident — the lever for
    // the #8985 cold-open tail (provisioned concurrency only pre-runs the ~165ms init, not the
    // in-handler bundle load). 10 ≈ one page-load fan-out (~12 concurrent calls), ~$0.30/mo. (#9148)
    warm: process.env.ENABLE_WARMING === 'true' || PRODUCTION_STAGES.includes($app.stage) ? 10 : 0,
    transform: {
      // Reserved concurrency on `dev` only. Reserved is also a hard ceiling; prod peaks ~319
      // concurrent with 0 throttles today, so capping at 150 would throttle into 429s. A sized
      // prod reservation needs an account-limit increase — deferred to a follow-up. (#9148)
      // `concurrency` is not exposed on the Nextjs `server` prop (a narrow FunctionArgs subset),
      // so it must be applied via `transform.server`, which takes full FunctionArgs.
      server: args => {
        if ($app.stage === 'dev') {
          args.concurrency = { reserved: 150 };
        }
      },
    },
    // Order the frontend deploy strictly AFTER the database migration Invocation (CI only). The P0-B
    // consent gate (#9775) is fail-closed, so it must not serve traffic until the grandfather backfill
    // has run — otherwise existing users are transiently trapped on the /accept-policies interstitial.
    // migratorInvocation is undefined outside CI (no migration runs → nothing to wait on).
  },
  { dependsOn: migratorInvocation ? [migratorInvocation] : [] }
);
