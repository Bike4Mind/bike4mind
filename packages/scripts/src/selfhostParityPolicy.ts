import type { ParityPolicyEntry } from './selfhostParityInventory';

// `issue` is the capability's shared roadmap epic (schedules, or every other kind), not a per-gap issue.
function reviewed(
  id: string,
  fingerprint: string,
  disposition: ParityPolicyEntry['disposition'],
  hostedAwsSignals: string[],
  portable?: ParityPolicyEntry['portable']
): ParityPolicyEntry {
  const schedule = id.startsWith('schedule:');
  return {
    id,
    fingerprint,
    disposition,
    issue: `Bike4Mind/bike4mind#${schedule ? 2694 : 2693}`,
    reason:
      disposition === 'portable'
        ? 'Reviewed registration/route only. Configured resources/providers and actual outcome proof remain required.'
        : disposition === 'excluded'
          ? 'Dead-letter infrastructure, not a separate workflow. Associated consumer configuration and recovery remain tracked.'
          : schedule
            ? 'Hosted cadence retained, including disabled/conditional slots. Local mapping/capability and outcome acceptance remain tracked.'
            : 'Hosted target retained. Local consumer/routing, provider capability or outcome acceptance remains tracked.',
    hostedAwsSignals,
    ...(portable ? { portable } : {}),
  };
}

const gap = (id: string, fingerprint: string, signals: string[] = []): ParityPolicyEntry =>
  reviewed(id, fingerprint, 'pending', signals);
// A gap whose reason is specific to the entry: who reaches it on self-host and what wiring it needs.
// The registered-but-unconsumed ones must stay in sync with REGISTERED_WITHOUT_CONSUMER in
// b4m-core/resource/src/manifestCoverage.repo.test.ts.
const gapBecause = (id: string, fingerprint: string, reason: string, signals: string[] = []): ParityPolicyEntry => ({
  ...reviewed(id, fingerprint, 'pending', signals),
  reason,
});
const broker = (id: string, fingerprint: string, signals: string[] = []): ParityPolicyEntry =>
  reviewed(id, fingerprint, 'excluded', signals);
// Excluded because the capability only exists on the hosted deployment, so the reason is per entry.
const hostedOnly = (id: string, fingerprint: string, reason: string, signals: string[] = []): ParityPolicyEntry => ({
  ...reviewed(id, fingerprint, 'excluded', signals),
  reason,
});
const wired = (
  id: string,
  fingerprint: string,
  portable: NonNullable<ParityPolicyEntry['portable']>,
  signals: string[] = []
): ParityPolicyEntry => reviewed(id, fingerprint, 'portable', signals, portable);

// Reviewed snapshots, never automatically refreshed by CI. Portable means wiring only.
export const selfhostParityPolicy: readonly ParityPolicyEntry[] = [
  broker(
    'queue:infra/dlqTriageSweepDeadLetter.ts:dlqTriageSweepDlq',
    '8f974196323d71a6029e7255756ddbdb5aa7d14e75e50a745de4d75a1fdff72d'
  ),
  hostedOnly(
    'schedule:infra/cron.ts:dlqTriageSweep',
    '8c353c2b1713c580d01f4faaac7374b02b0dffc6f32f4da70ccdfcfb5d291dd2',
    'Hosted CloudWatch alarm and SQS dead-letter sampling; portable deployments do not run the hosted alarm sweep.',
    ['cloudwatch:DescribeAlarms', 'import:@aws-sdk/client-cloudwatch', 'lambda:ListEventSourceMappings']
  ),
  broker(
    'queue:infra/organizationRetention.ts:organizationRetentionDlq',
    'ac4a28905799e117ee2ab119fd37de18b424e94ff7d5cdad2a86d248d914f5cf'
  ),
  wired(
    'schedule:infra/organizationRetention.ts:organizationRetention',
    '0fb306579a0b977f7ee58ca8e26fb88e205497e7c705c4b22088fc48510088e4',
    {
      source: 'apps/workers/src/selfhost/organizationRetention.ts',
      symbol: 'registerOrganizationRetention',
      fingerprint: '0690084e4c9c0d8804272a8837ccf4775a4551c65f0388c2850cf02569b82a3b',
    }
  ),
  broker(
    'queue:infra/adminMorningBrief.ts:adminMorningBriefDlq',
    '02f77874c10969d8ede24d54d660f8722b34b4826b403446b8a06ca17bceae54'
  ),
  gapBecause(
    'schedule:infra/adminMorningBrief.ts:adminMorningBrief',
    '8b04cc470d7a155f76bd9a6dab0591f8e4b8abef60be3ee972e62ed60fa8b834',
    'Opt-in admin brief uses hosted CloudWatch alarms and the LiveOps destination; self-host scheduling and alternate alarm capability are not wired.',
    ['cloudwatch:DescribeAlarms']
  ),
  hostedOnly(
    'eventRule:infra/accountCreationAlarms.ts:AccountCreationMetricsSchedule',
    '9ecd499546afefc96b5204f91ccaa0292f7eaf73bce58d0bf91a30adda3497e7',
    'Hosted CloudWatch account census on monitored stages; no local notification destination is configured.',
    ['cloudwatch:PutMetricData', 'cloudwatch:namespace', 'import:@aws-sdk/client-cloudwatch']
  ),
  broker(
    'queue:infra/accountDeletionSweepDeadLetter.ts:accountDeletionSweepDlq',
    '981813c22390623a538fe68a3b6bd1445b4a6aad7164a0485c95a687bad287a5'
  ),
  broker(
    'queue:infra/accountCreationAlarms.ts:AccountCreationMetricsDlq',
    'aa48c95e91e528e37c56987140eb2432dc050caa462b4c8f28e9043bf22d4a77'
  ),
  hostedOnly(
    'eventRule:infra/analyticsRollup.ts:AnalyticsRollupSchedule',
    'ed227e7eb331eab93a361fb1ed64533da7ec06fe7e659b7adf747e794bab7abe',
    'Hosted nightly product-analytics rollup; the self-host worker runner does not schedule it yet.'
  ),
  broker(
    'queue:infra/analyticsRollup.ts:AnalyticsRollupDlq',
    'ed51b5ae85080c544b6e72f1d517d7c42a55271b0cc262036b31cc42a2669c39'
  ),
  broker(
    'queue:infra/businessMetricAlerts.ts:businessMetricAlertsDLQ',
    '673c6f139ed9d3c3cb6695ec42bdf0f2da000f8d79e5ed17a00060cdc353549e'
  ),
  hostedOnly(
    'schedule:infra/businessMetricAlerts.ts:businessMetricAlerts',
    'adefc948b7d3d294130f0779b41459e704613218450a612f4f424d4f7ddcf97e',
    'Hosted business analytics and Stripe receipts; not applicable to a portable deployment.'
  ),
  broker(
    'queue:infra/sideAppHealthAlerts.ts:sideAppHealthAlertsDLQ',
    'fb350c04edf256a7f3dbdd2e2897229530d8ecd9fda5e7d251f9a6f8e9f7ea8e'
  ),
  hostedOnly(
    'schedule:infra/sideAppHealthAlerts.ts:sideAppHealthAlerts',
    '18f792d2b462b13828669cb6c228fc81357bd0fd1e8942de644488d1ddd60401',
    'Hosted operator alerting on connected-app traffic; not applicable to a portable deployment.'
  ),
  wired(
    'event:infra/eventBus.ts:brief-compose',
    '0f16644c119df424cd402aacc1d5d2555431124b9a76de5b27333ae4486498b5',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:brief.compose',
      fingerprint: 'ea0c848c3a5ab33205828c86daa343c861e9870d848d27ebe37ea571ffcf5a5b',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:delegation-process',
    '991a20385f2f5cec6d9964eb37680b8d5da15440c3514c6475d6537ebc77364e',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:delegation.process',
      fingerprint: 'fe26655906a5ee7f0c34fb0217931ab014a959978e199404af1db6366df8a1d0',
    },
    ['bedrock:*']
  ),
  gap('event:infra/eventBus.ts:email-send', 'eff6a03a091efa68ad9d1ba70e8635b7604c2f33ebb57f307db27b70d8940314'),
  gap(
    'event:infra/eventBus.ts:moderation-escalation-alert',
    'f4299c61eaf67b9ece980f6321d71fa95378cba3efb8def5e95c279e4b5bb9a7',
    ['ssm:GetParameter']
  ),
  gap(
    'event:infra/eventBus.ts:notebook-curation-complete-analytics',
    'edb3c20d2fa6c4458775d9ce778381de6df19f4b599315630b954d34757f97d1'
  ),
  wired(
    'event:infra/eventBus.ts:notebook-curation-start',
    '620f735868e93844621860f9eaec1d76ffa9c9fd1b0f35d5bdba18110a26adb7',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:notebook.curation.start',
      fingerprint: '13f4af25b4f9fd230d32db0d114ccc974fbc69fa23f49da6f53f1512ca9fd912',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:notification-push',
    '9519e9e215d2cb081c5045d865c7f1e1cec1176b2c167edbb5d72b13aee4743f',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:notification.push',
      fingerprint: '69bb11478b79cf26dc283f1d7d33e39453a4d9a9c4bb5ad4a7c09bcae4ce5249',
    }
  ),
  wired(
    'event:infra/eventBus.ts:RiskEvidenceCompletion',
    '4c061c91603a4206bb0f27ee214d9da78c94c628f5826975077f50a2ea6b77f6',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:completion.completed',
      fingerprint: 'c0ac369d7d2401651a598cc4ac6ea604ffd220693026038d38799be04a9f52f8',
    }
  ),
  wired(
    'event:infra/eventBus.ts:session-auto-name',
    '13f4575da5f844ed716606723e68feffa8b43dacff844d3b0585954df6a0bc62',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:session.auto_name',
      fingerprint: 'e8d113fe481e3278c8fbcc2a19766a80b213e7e2d0320754b5e8537a00c9300a',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:session-context-summarize',
    '21c3122839f1ec7fae9bfd35d32f9bf533ce187c6695f5aaba441a51d07e360e',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:session.context_summarize',
      fingerprint: '90cbf2926796ba816d8a629551133c65c120299a06adf380e7fc60648ac30af6',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:session-summarize',
    '6c58dbef5f5b0c3c5fd3abc21a926091d9f538bb1e0ab18f479e8ee0b9e20da6',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:session.summarize',
      fingerprint: '10e91ee72728446510951ddff24d5d837edb97c35839502fc53a0a6aa466b6f6',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:session-tag',
    'de364abf492c03e7c7cdc146858e4c967e9e38748bff6d03c169a806a246e438',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:session.tag',
      fingerprint: '703f157442db801169e5f9b492680818fcff5ef1e9f7eab5526a362f170760a1',
    },
    ['bedrock:*']
  ),
  gap('event:infra/eventBus.ts:spider-start', '4e7fd24c48425f1e501280414b3fc4d2f595733652d7f0e356e1cb0ab3d61d18', [
    'bedrock:*',
  ]),
  gap('event:infra/eventBus.ts:SreFixDispatch', 'fa1122e45e2de82ee4a61c73ce860a679f2f5ce735bc628dd56a35c82977a648'),
  wired(
    'event:infra/eventBus.ts:stripe-customer-subscription-updated',
    '44bf45830bf653949d90bdbd9bbfb5f5a81a5c0ad65542caeecf34292af61904',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:stripe.cus.sub.updated',
      fingerprint: 'd90193ad176754a1c4dd233b8226ed83f31271f96d0560ce005893fc5c46505a',
    },
    ['cloudwatch:PutMetricData']
  ),
  wired(
    'event:infra/eventBus.ts:stripe-invoice-payment-succeeded',
    'ccfae9478ec73f70417a3dcca9ebcbf8a313e901c7602efccb06a87447aad16c',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:stripe.invoice.payment_succeeded',
      fingerprint: '9900e1b970c970efcd8bae97566d735b7a9195c51e46ca958069863945ff8902',
    },
    ['cloudwatch:PutMetricData']
  ),
  wired(
    'event:infra/eventBus.ts:studio-job-completed',
    'e7beedb18fcf2c36291fb67fe8d8ec21c1a82a090c5f38da6e72ffdce458ce93',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:studio.job.completed',
      fingerprint: '2bfca4af51020b41347de4b897420245d732369f68cdabb23818b4620ab363d6',
    }
  ),
  gap('event:infra/eventBus.ts:telemetry-alert', 'def925f78cc4e8633002a7696fe56a7e2e075a2e420f0bb8099ee9d2e8b327c0', [
    'bedrock:*',
  ]),
  gap(
    'schedule:infra/imageModerationReviewSweep.ts:imageModerationReviewSweep',
    '788cdc3161acdbdfcd3223d138849e9106fa61c7f7b185b4a64b43a1b2a7c5b9',
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  broker(
    'queue:infra/imageModerationReviewSweepDeadLetter.ts:imageModerationReviewSweepDlq',
    'b037ad8cb00f13fbfcf4e7f6b014898d1b338a2227839f59f3fe8811d5fb8e75'
  ),
  wired(
    'event:infra/llm.ts:create-memento',
    '5b17c92749a15d48ede31049684581cea9f72aaa98f0c3e0892a67b281c0e84a',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:completion.completed',
      fingerprint: 'c0ac369d7d2401651a598cc4ac6ea604ffd220693026038d38799be04a9f52f8',
    },
    ['bedrock:*']
  ),
  gap('event:infra/llm.ts:slack-completion-start', '7cfedef3ce297637f3f09f3a7a26f9a50b8494dab8c1d6444f41ca43aad263df', [
    'bedrock:*',
    'cloudwatch:PutMetricData',
    'events:PutEvents',
  ]),
  gapBecause(
    'event:infra/llm.ts:slack-quick-ask',
    '20e58bb73110c033f97509a353aaf0430ef5740745d1dd562ccc0052942823b7',
    'Slack DM completions are not wired on self-host; see slack-completion-start.'
  ),
  gap(
    'eventRule:infra/serviceHealthAlarms.ts:EcsTaskFailedToStartRule',
    '2b68b75cf6843e937ae8e8686a3eb7d2a5b68a5f3ff785b117d5cab8364b0a2f'
  ),
  hostedOnly(
    'eventRule:infra/providerSpend.ts:ProviderAdminKeyChangeRule',
    '4ad2a9c06c430743b7ea5dfd109510fd24fa948cfce64597f74096b5127e62cd',
    'Records access to the provider admin key store, which exists only on hosted stages that run scheduled jobs; self-host reads the keys from its own configuration.',
    ['cloudwatch:PutMetricData']
  ),
  hostedOnly(
    'eventRule:infra/providerSpend.ts:ProviderAdminKeyKmsChangeRule',
    'ea7836c85a2e65eaef391a4ff35cde8708bcc7ba1edff3f35077801fba7f36ca',
    'Records access to the provider admin key store, which exists only on hosted stages that run scheduled jobs; self-host reads the keys from its own configuration.',
    ['cloudwatch:PutMetricData']
  ),
  hostedOnly(
    'eventRule:infra/providerSpend.ts:ProviderAdminKeyReadRule',
    'a8d4ca3aacaa82b9fc18b4b0b1c246a6d09000acc10144e1a7031c5880fd9043',
    'Records access to the provider admin key store, which exists only on hosted stages that run scheduled jobs; self-host reads the keys from its own configuration.',
    ['cloudwatch:PutMetricData']
  ),
  gap(
    'function:infra/agentExecutor.ts:AgentExecutor',
    '06cbb7b563bc2d64ca374dfa3d53dcc23f96bc95c80084c9f00eca29967a4796',
    [
      'bedrock:InvokeModel',
      'bedrock:InvokeModelWithResponseStream',
      'cloudwatch:PutMetricData',
      'events:PutEvents',
      'lambda:InvokeFunction',
    ]
  ),
  hostedOnly(
    'function:infra/callableFunctionSourceFetch.ts:callableFunctionSourceFetch',
    '1509db58716ac7ef24d43c1a3f1bee9334f5ea9f18403fc1815ce458a8a2d0b5',
    'Isolates hosted callable function source fetches outside the VPC with no secrets; self-host runs the same pinned fetch in-process when no fetch function is named.'
  ),
  gap('function:infra/database.ts:DatabaseCleaner', 'e52f8c2f59b621e25176f06917724c82cd678c213de7325e2d9ad064c2971b70'),
  gap(
    'function:infra/database.ts:DatabaseMigrator',
    'deaa5e5949f03f6a05443336a28fecd2d822df40c28258a52384de92a29b8d71'
  ),
  gap('function:infra/database.ts:DatabaseSeeder', '6efe8fb05923a55b4e32d30847250969d87bd367292b12e893ba9fcd6c4aa7f4', [
    'ssm:GetParameter',
  ]),
  gap('function:infra/dataSyncer.ts:DataSyncer', '3c215ebb7ff8e4c86aef66974ee68f921878325b54610d1c5774f18da50ef5bb'),
  gap(
    'function:infra/imageProcessor.ts:ImageProcessor',
    'f7bbbefdca6ac5807469cafe56cb856206b6ffdfe08dcb2ba2bd16bb4937ea15'
  ),
  gap('function:infra/mcp.ts:mcpHandler', 'b106329f68d1d3225ec735b12aff58943f1bdf1ae1b87d2c21fb8b2ac57d921e'),
  hostedOnly(
    'function:infra/remoteMcp.ts:remoteMcpHandler',
    '69d7d937077e31281f43012e903c58d74513036fd50296b764855fc6c90e1b70',
    'Isolates hosted custom-MCP egress outside the VPC; self-host runs the same RemoteMcpClient in-process by design.'
  ),
  hostedOnly(
    'function:infra/queues.ts:PublishThumbnailRenderer',
    'a250460c0bc75a4ff9c0176e6dd4655883ec598578667051d5ae2de9c911d441',
    'Renders publish thumbnails for the hosted-only publishThumbnailQueue, invoked synchronously by its handler; it packages a Lambda-only headless Chromium the self-host worker image does not ship.'
  ),
  gap(
    'logSubscription:infra/logMonitor.ts:forwardErrorLogs()',
    '9212883df5ec6e0a3f1a1ce73c5fd24cb37ab67ac51d1b966d48306d142840a0',
    ['lambda:InvokeFunction']
  ),
  gap(
    'notification:infra/buckets.ts:appFilesBucket.uploadComplete',
    '473f2f1a55c650ff22780d274eb8cee26c2358527d9d53e14f07efa465b5ac60'
  ),
  gap(
    'notification:infra/buckets.ts:historyImportBucket.notebookImportCompleted',
    'f98dd31eb2e21830384bf361ac1bd4d7cc5d9de6e4c094a16bd65c4f5a219ac2'
  ),
  gap(
    'notification:infra/buckets.ts:historyImportBucket.uploadComplete',
    'bff5a3458c45157d822d9f024567909a59363aae663deff22d3a248313a53834'
  ),
  gap(
    'notification:infra/emailIngestion.ts:emailIngestionBucket.emailReceived',
    '312fd4c0cde9c76be43efba5d0649ec3b8e1be04f5fc2e5484fa0ec6082bca03'
  ),
  gap(
    'notification:infra/queues.ts:fabFileBucket.uploadComplete',
    '3a9ff85b25c7ca1d977e78f699d80bf29b54f6a6e4a9d1c3385cbecaa12637f2'
  ),
  broker(
    'queue:infra/dlqAlarmHandlerDeadLetter.ts:DlqAlarmHandlerDlq',
    '1f154dd82d798f8212508c571b43a3326554ae0b9c1946887a067df54d053c17'
  ),
  gapBecause(
    'queue:infra/emailIngestion.ts:emailAnalysisQueue',
    'a02abd3f0b12c1f4057875aa1658668ce997a6c09d95ca632a9bd9a36ed55b87',
    'Enqueued only by the inbound-email parser, which consumes emailIngestionQueue, so nothing produces it on self-host. Wire both together if inbound email is ever supported.',
    ['bedrock:InvokeModel']
  ),
  broker(
    'queue:infra/emailIngestion.ts:emailAnalysisQueueDLQ',
    '3293f56dff623e68c9514a4305754db7930dabcab9adbc52eb71e63ccecc7c7b'
  ),
  gapBecause(
    'queue:infra/emailIngestion.ts:emailIngestionQueue',
    '470d3dc2f83160742089dc27032ae07782edd97ccd48bad12006e3514a789f5b',
    'Filled only by the SES inbound-mail bucket notification, which self-host has no equivalent of. Registered in the manifest, but nothing produces or consumes it locally.',
    ['bedrock:*']
  ),
  broker(
    'queue:infra/emailIngestion.ts:emailIngestionQueueDLQ',
    'f44858b26f2ee8f4fb254d41d172e76694252114fb45ab805e510e34c3897f1a'
  ),
  gapBecause(
    'queue:infra/emailMarketing.ts:emailBatchQueue',
    '5bf17f11c35d5235b8f6b504a61b4ad231aeae08614ecd4f0c325be098a1642d',
    'Fed only by the email job orchestrator (the emailJobQueue consumer), so it stays empty until emailJobQueue is wired. Wire the two together.'
  ),
  broker(
    'queue:infra/emailMarketing.ts:emailBatchQueueDLQ',
    'ff7a3dc9d711600848964bb4825fac5af480800f91d5018d6e02b08064a17d73'
  ),
  gapBecause(
    'queue:infra/emailMarketing.ts:emailJobQueue',
    'b2c76c1b7a98c20402863db9c1b25502526341372920d9a07e8b39f6cf9b966a',
    'The admin email-job start and send routes enqueue here, but no self-host consumer runs the email job orchestrator, so a started job never sends. Needs a consumer and an outbound mail provider decision.'
  ),
  broker(
    'queue:infra/emailMarketing.ts:emailJobQueueDLQ',
    '6d6a3df0afbdc622c4cac46865a7875da157e26a9f0d4295a491faf9ec1d2968'
  ),
  broker(
    'queue:infra/eventBus.ts:billingEventsDLQ',
    '26fa49be8bc393fcf3f9a55544b329a8cd750d920cade399bac04c8f662adc5f'
  ),
  broker(
    'queue:infra/eventBus.ts:completionEventsDLQ',
    '11ef24fc602f2961d178ba5a11d9e77451952305f129f4023a8d5b33882eedeb'
  ),
  broker('queue:infra/eventBus.ts:emailEventsDLQ', '89640933adf55a7c4b2f652b0af642da349c22f08b15a76086b9526925b2b277'),
  broker('queue:infra/eventBus.ts:pushEventsDLQ', '9675205f30ba0e4475576666a8df72743d21b4a07d58fc35474bdded3ac4ecbe'),
  broker(
    'queue:infra/eventBus.ts:moderationAlertsDLQ',
    '122aa6633fc75c70c1e6ade17d4ccf2eb13159ee43723a49ad48c4e805a29a46'
  ),
  broker(
    'queue:infra/eventBus.ts:notebookEventsDLQ',
    '6d141bd0d7ffdd58bd3868b5b89ce62a6aa5d3b2102ff88ae5a09215d74ec9ce'
  ),
  broker(
    'queue:infra/eventBus.ts:sessionEnrichmentDLQ',
    'afb741bc0a0d45baea9c5c3f0665664c72d01869c76cb22c2c1cdae9ff47035a'
  ),
  broker(
    'queue:infra/eventBus.ts:telemetryAlertRuleDLQ',
    '65f5b9e522854e4e0dc8eab7245b7e37acfc5ad1be8139a52be0d75d981b46a0'
  ),
  gap(
    'queue:infra/queues.ts:agentContinuationQueue',
    '946cf9f4952fb9a59bdec62d3600b7c8a59c04ea951bcc9631a5627e624d277b',
    [
      'bedrock:InvokeModel',
      'bedrock:InvokeModelWithResponseStream',
      'cloudwatch:PutMetricData',
      'events:PutEvents',
      'lambda:InvokeFunction',
    ]
  ),
  broker(
    'queue:infra/queues.ts:agentContinuationQueueDLQ',
    '6a36ae54a4e5ea35b9c34a06d407cee8281bcd6284eeeecf35d7c530dd0c6ffb'
  ),
  gapBecause(
    'queue:infra/queues.ts:agentProactiveMessageQueue',
    'b99fc057b49f1a93842d2d146f1aa50145b4f9edae9b3f0b35fabfcf90df0f33',
    'The session trigger-proactive-messages route enqueues here and no self-host consumer drains it, so triggered messages are never sent. The handler is in open core: candidate to wire.',
    ['bedrock:*', 'cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:agentProactiveMessageQueueDLQ',
    '1990fa893bed28bef2523e156f10d9e0a787552590a76489415b59814359c2a9'
  ),
  gap('queue:infra/queues.ts:bobRunQueue', '6bd402d264994779792034bcdd606330585468567fb62b716abdea14f849afba', [
    'cloudwatch:PutMetricData',
    'execute-api:ManageConnections',
  ]),
  broker('queue:infra/queues.ts:bobRunQueueDLQ', '992ea82e88afb9edee954915d02a11a851268dc0059930f226609026a42b34aa'),
  wired(
    'queue:infra/queues.ts:dataLakeCleanupQueue',
    'd5ed8a1649f322b1e9b5e015588f2ed033a1f24d893737feb798cb407602dfed',
    {
      source: 'apps/workers/src/selfhost/dataLakeCleanupQueue.ts',
      symbol: 'registerDataLakeCleanupQueue',
      fingerprint: 'ac1bc0d0eb7e60650420fcafa0c8cc1ac44874cb0132365c3c41510631bca8a7',
    }
  ),
  broker(
    'queue:infra/queues.ts:dataLakeCleanupQueueDLQ',
    '501479ddcbfc73c175688c2151a627de14d2e3b900234a9c74d299f1fc75b7f2'
  ),
  wired(
    'queue:infra/queues.ts:dataLakeResearchQueue',
    '4e84877452a06b0b9cafb657703e0a791e8930eed20357ccd8b2ba687d36cab3',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:dataLakeResearchQueue',
      fingerprint: 'c6cc49f18bb919ae9e396c6b2cff1659d8fe3434ec21016a43803d144122f27b',
    }
  ),
  broker(
    'queue:infra/queues.ts:dataLakeResearchQueueDLQ',
    '282597bb81f72e340915441f8a2556c94f86bc43be0eb76db1f625d2d052a5ec'
  ),
  wired(
    'queue:infra/queues.ts:dataLakeTaxonomyQueue',
    '11448d0703ae18f0100557d8459c01ef342d9a6feff42e0b4320c9d436f3aacf',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:dataLakeTaxonomyQueue',
      fingerprint: '1739fd90defe91eae3c52824b9ba883e488ddc3386540e71e719341a992993d2',
    }
  ),
  broker(
    'queue:infra/queues.ts:dataLakeTaxonomyQueueDLQ',
    '09d613eb6bffdc733600b1b2dbb9a68496671babcfb7a2b8769c84b5d65d9bbd'
  ),
  gapBecause(
    'queue:infra/queues.ts:deepAgentWakeQueue',
    '69126f266075c0909904ac978dc8455577bc679ccaedfaf6a5826b4cf6fabbca',
    'Deep agent enrollment (/api/deep-agent/spin) enqueues wakes, and self-host runs neither this consumer nor the wake cron, so an enrolled agent never wakes. The handler is in open core: candidate to wire.',
    ['bedrock:InvokeModel', 'cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:deepAgentWakeQueueDLQ',
    '2daf534b0ed080ebdbaf3f323032db39f5ab06e345ebc0df5a73babd0f8c1bb8'
  ),
  wired(
    'queue:infra/queues.ts:driveDisconnectPurgeQueue',
    '2f0cfde1581ba6382ce839ae51ae11a3ea783f1e28435d474018bab2cf4536bd',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:driveDisconnectPurgeQueue',
      fingerprint: 'ccf40dcfb92ddb7bfbcc75eb3056f1273be0ddc9336fb05569b1e54a98cd7f7b',
    }
  ),
  broker(
    'queue:infra/queues.ts:driveDisconnectPurgeQueueDLQ',
    'd72d0b74a0ba0a11eb344d09ea5e3a85f5d0ae99bb78d541f24e07b2bf1615c5'
  ),
  wired(
    'queue:infra/queues.ts:driveLakeIngestQueue',
    '8841bbefd901daffa2b2c9d69c0562b9800c3322fea89f623743780cdeecbc5f',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:driveLakeIngestQueue',
      fingerprint: '107c41da6dee4f6ba0293a18f7845b7ae23c4d6f51ebafce96568447f404aa65',
    }
  ),
  broker(
    'queue:infra/queues.ts:driveLakeIngestQueueDLQ',
    '936a38165a1530a6e2300096213886ea50250a8cc9d8f192e5877234d74ea18f'
  ),
  wired(
    'queue:infra/queues.ts:fabFileChunkQueue',
    '03d7a4aec250e5c2c7c9fb00ec695b28a0263762acddca9db258f4b790701942',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:fabFileChunkQueue',
      fingerprint: '897a485f265f7fd4c782c224a4e04d4178ec4aeca0318ecfc3d1f2ad15b351fa',
    },
    ['cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:fabFileChunkQueueDLQ',
    '2b6aa012fc0a6d78c33596eefa58420843fca1e3b9ded9937bd135741417e309'
  ),
  broker(
    'queue:infra/queues.ts:fabFileModerationDLQ',
    'ce56033be57c51e8824401b6f70e0dd04eba17a5255d6dc4214d69650a7f7a00'
  ),
  wired(
    'queue:infra/queues.ts:fabFileVectorizeQueue',
    '0bac1fdf98538cddbcb124db2ea6181f29f3cc9ed08897230624776fdfe4528a',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:fabFileVectorizeQueue',
      fingerprint: 'b1e2ccd43b423e136f09376a690e1f2070fd40493c7717abe8b40314ad4617f1',
    },
    ['bedrock:InvokeModel', 'cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:fabFileVectorizeQueueDLQ',
    '2e3862991aa93a6c5edc3d625cb53fdf125b408f1b85d204208d5d5531b04195'
  ),
  wired(
    'queue:infra/queues.ts:generationCallbackQueue',
    '0a07c4175a2e9407483a75962577ed64429a317a6ded0f023e1e7d05c85c8d51',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:generationCallbackQueue',
      fingerprint: '0ab11e57b1bb4b30c5ff918b1158392970afb67da256bfbe8db70924ac87cf83',
    },
    ['cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:generationCallbackQueueDLQ',
    '607e33a0f2ca754239ec84faade9a017944a9a5cae23c90311bd349400107770'
  ),
  broker('queue:infra/queues.ts:generationJobDLQ', '0eb29387a6952921e713298ba6acf3cd1aef5f60d84e67cffe177843b714f38f'),
  wired(
    'queue:infra/queues.ts:generationJobQueue',
    '13d966d1e0c14eb72f2b8cfab3505d975e7602c70375551e58f45cc0e9bb5bf9',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:generationJobQueue',
      fingerprint: 'ea0d61421db2f82f29cf9cec649d9b685ccdefffd910d6f8d75d96d7539162fc',
    }
  ),
  wired(
    'queue:infra/queues.ts:githubLakeIngestQueue',
    'd5bf9dcf09ef16cf0bea531a9d03eceb4e58f8c7a35e95e219f94cdabd59236c',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:githubLakeIngestQueue',
      fingerprint: '1aa0aed02bda3f3d30e1ed4a85c5a9ea8333a227b38d833488da427fc87ab0db',
    }
  ),
  broker(
    'queue:infra/queues.ts:githubLakeIngestQueueDLQ',
    '85d47c076cbe0cbf6f649423831607793f7c8e014bb946603b1252de412abf4c'
  ),
  wired(
    'queue:infra/queues.ts:githubLakeRevokeQueue',
    '70755d8fb0016af113da6842cc1335e83461923fedffb0ef0835501f6ed90e54',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:githubLakeRevokeQueue',
      fingerprint: 'fe423a08a34dba667c034126aa24ab5f9647e62b2982eaf477abf45e7ec4ef8d',
    }
  ),
  broker(
    'queue:infra/queues.ts:githubLakeRevokeQueueDLQ',
    '4491856037e8f9226cdeb137466706aa7bc84abb90e191d01aef7f42424825d1'
  ),
  gapBecause(
    'queue:infra/queues.ts:generatedMediaPurgeQueue',
    '88d7e61becc82c064bd8cd57edf3f171a1f2c810534b623961e1b1dadce88276',
    'Optional. Notebook and message deletes hand it the generated media their request budget did not reach; with no URL set the leftovers are logged and dropped. The self-host templates declare it with a URL, as queue parity requires, but no self-host consumer is wired yet, so leftovers wait in the broker until one is.'
  ),
  broker(
    'queue:infra/queues.ts:generatedMediaPurgeQueueDLQ',
    'c2d58c32249e95e85b54c27855e71c6dc8512ff1fc4965a78013fd5eee539abc'
  ),
  gap('queue:infra/queues.ts:githubWebhookQueue', '6fed8fe8e418c474e7615d1a3090ec7344536e15f8864f1c86479c63d18620e9', [
    'import:@aws-sdk/client-cloudwatch',
  ]),
  broker(
    'queue:infra/queues.ts:githubWebhookQueueDLQ',
    'a2822aee5a83e5452e0217169125d1a7788fe9a5f4c78dada41fb6e4aa412fb9'
  ),
  broker('queue:infra/queues.ts:imageEditDLQ', '10c1a0580567d9b39e1c9547b6edccdbf9e9e6a71ea74c050e73f8da63190074'),
  wired(
    'queue:infra/queues.ts:imageEditQueue',
    'd2a31074b8c1cf356db896a58290649f278e7542f91b81e2e622a7b19bb202d4',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:imageEditQueue',
      fingerprint: 'ccb4df2f650f35ceea3ba6ddc6aca1417bc641d32e37fbf622f74c12e36bdffe',
    },
    ['bedrock:*']
  ),
  broker(
    'queue:infra/queues.ts:imageGenerationDLQ',
    'e5555dbe58ec90c0fe40c11b46fab25d491c21b2e0e4db14a8bd75bb24684051'
  ),
  wired(
    'queue:infra/queues.ts:imageGenerationQueue',
    'ff941a4b38d70a60d3bc4bbe2e28936dd32df2baf7500727e565fe53dc50b0f8',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:imageGenerationQueue',
      fingerprint: '6a995e6afe3bdf7dc3cde09b1ac0b8d4d367ba2f4fa4009d422f028802ed3226',
    },
    ['bedrock:*']
  ),
  gapBecause(
    'queue:infra/queues.ts:lakeInconsistencyModelQueue',
    'b9b68e4035cfa152983a37c7507f735e7497bbdfee2c5ba5fc7df5a26a6320d1',
    'Optional. Reached only from the inconsistencies route behind the off-by-default EnableLakeModelInconsistencyDetection flag, which refuses the run when no URL is set. Leave it unset on self-host until a consumer is wired.'
  ),
  broker(
    'queue:infra/queues.ts:lakeInconsistencyModelQueueDLQ',
    'cd3631e1e06de7bbf8bef82bac2e6c518b0f9a2cedd0881211fad77de5b969f7'
  ),
  wired('queue:infra/queues.ts:lakeMemoryQueue', '35e0dcaa10684e6d3956da990b8f30a4ef0467fd14d0fac09d9fe9e4b3c3230f', {
    source: 'apps/workers/src/selfhost/lakeMemoryQueue.ts',
    symbol: 'registerLakeMemoryQueue',
    fingerprint: 'f98f5ba76b35cde5bd0bf1761073dbe768a4d2fece50367293e1b6fee8fe2ea1',
  }),
  broker(
    'queue:infra/queues.ts:lakeMemoryQueueDLQ',
    'a5535487412403460d4967339946bd72fac438a859cb10bc0d71ea3a8c24d256'
  ),
  gap(
    'queue:infra/queues.ts:libreoncologyAudioRenderQueue',
    '08339b274b3dfb667e2ec7747bec95ff084ea38f2108f9e06d3a423ea716c205'
  ),
  broker(
    'queue:infra/queues.ts:libreoncologyAudioRenderQueueDLQ',
    '2ee2385d94d02b314ad0029cadb2c26a937f5a674ff43eb5a82816c228b00b6c'
  ),
  wired(
    'queue:infra/queues.ts:notebookCurationQueue',
    'e373b5d8e5bc82b36c1bcf964226289fdca8ccfd82b23a5826d7f816d810ac4c',
    {
      source: 'apps/workers/src/selfhost/notebookCurationQueue.ts',
      symbol: 'registerNotebookCurationQueue',
      fingerprint: '4d8e7102f761fcacab16d9b9c059643b39ad36f1732c1af9ea90babe1f9abe4e',
    },
    ['bedrock:*']
  ),
  broker(
    'queue:infra/queues.ts:notebookCurationQueueDLQ',
    '5ec9eb83c70f34e66f4239d3a8366d9d6d0133d012e3d194d2131078a9721bec'
  ),
  gap(
    'queue:infra/queues.ts:optihashiRunCompletionQueue',
    '22030c6b30647690914a99ed325f112dbccad064066f394778eea81a0c7ef4ce',
    [
      'bedrock:InvokeModel',
      'bedrock:InvokeModelWithResponseStream',
      'cloudwatch:PutMetricData',
      'execute-api:ManageConnections',
    ]
  ),
  broker(
    'queue:infra/queues.ts:optihashiRunCompletionQueueDLQ',
    '37a2dc491c730c2bc828b7b2d5b578d986d6bd4d6f8ae22f14115fa2d7795402'
  ),
  gap(
    'queue:infra/queues.ts:overwatchAnalyticsQueue',
    '9cb823c8171933b2ca00cd9023fde24c5bcb4faa73db7965b29d60bed7737b22',
    ['cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:overwatchAnalyticsQueueDLQ',
    '48d2eb528668fa78a4afbc6df9740bd92ac527dc969f20966da54ac373072e04'
  ),
  hostedOnly(
    'queue:infra/queues.ts:publishThumbnailQueue',
    'cd0a21e4bdc25554952cb0936950b08f620f25d0780273ca7ffde985c2a209b4',
    'Owner-only publish thumbnails render in a Lambda-packaged headless Chromium; the self-host worker image ships no browser, so publish skips the enqueue and cards keep their generated cover.',
    ['lambda:InvokeFunction']
  ),
  broker(
    'queue:infra/queues.ts:publishThumbnailQueueDLQ',
    'a1b84e4b8d1c2da1390507f0e1bdd7a567c77e5390ede903ca583acdfdbe87d2'
  ),
  gapBecause(
    'queue:infra/queues.ts:callableFunctionCallQueue',
    '3a4962ab3bd5c171403f265dd43d7d0e0775752b9ceaa320d6fa0f706189f38c',
    'Asynchronous function calls are not wired on self-host: the broker declares the queue but nothing consumes it, so an async invoke answers 503 and a synchronous call still runs.',
    ['lambda:InvokeFunction']
  ),
  gapBecause(
    'queue:infra/queues.ts:callableFunctionCallQueueDLQ',
    'f939d07fd88701b31fed10da4b2388692f410bd56fa4884c4711c95514c92140',
    'Dead-letter queue of callableFunctionCallQueue, which is not wired on self-host.'
  ),
  wired(
    'queue:infra/queues.ts:questExportQueue',
    'f400bd268ecb6064015ec5c99a1e93e90c91c5bc02bc8768aa3daef45d252ed0',
    {
      source: 'apps/workers/src/selfhost/questExportQueue.ts',
      symbol: 'registerQuestExportQueue',
      fingerprint: '3dddcce0b838668ed665ee39483b2082294bd14b98c70fddee91736b638147bd',
    },
    ['bedrock:InvokeModel']
  ),
  wired(
    'queue:infra/queues.ts:accountDataExportQueue',
    'd5f1b02a432b3df3ba1699234547a7654213bcb9f67308ae90dbe9b31e50f356',
    {
      source: 'apps/workers/src/selfhost/accountDataExportQueue.ts',
      symbol: 'registerAccountDataExportQueue',
      fingerprint: 'de56c6ae60e8ab28932b6554f84f5ff06d4e4ee1558c9bff95592c25fee263fb',
    }
  ),
  broker(
    'queue:infra/queues.ts:accountDataExportQueueDLQ',
    '8234bb46aa2d71c0b2303134eb96ad2918c4735483c21631faa46b1b27736d60'
  ),
  // The erasure also deletes callable function data: the data bucket when hosted, the files bucket on self-host.
  wired(
    'queue:infra/queues.ts:accountErasureQueue',
    '6592ca979ba828be45ab32a65f80719b001971c31f416d43c2f2d19e7f7f1c5e',
    {
      source: 'apps/workers/src/selfhost/accountErasureQueue.ts',
      symbol: 'registerAccountErasureQueue',
      fingerprint: '68698ad5077ecc9136ef3aecb7aa9ccf78d47607ed2c5cb832ce8dd873551668',
    }
  ),
  broker(
    'queue:infra/queues.ts:accountErasureQueueDLQ',
    'da82b9fa7a98f66e46005d88d97905d0c836e11b20ff2a737e08aa3b948594b6'
  ),
  broker(
    'queue:infra/queues.ts:questExportQueueDLQ',
    '25de3f067cc3dbb3aa93798220af65df41849f0baad7ef6cd008e56706335966'
  ),
  broker('queue:infra/queues.ts:renderJobDLQ', 'e1f19aaf06fd6c17528906c2932480b7f10810779ba40ac2bad84885cd2c40f6'),
  gapBecause(
    'queue:infra/queues.ts:renderJobQueue',
    '7c16ef5e8436376ea6e5b246f1965979fe7c60e0034b0d5db07c7cb0a4093e41',
    'Drained by the render worker (apps/workers/src/render/main.ts) as its own process: the hosted RenderWorker Fargate service, the render-worker compose profile or the chart renderWorker Deployment, not the self-host worker.'
  ),
  wired(
    'queue:infra/queues.ts:researchEngineQueue',
    '7f50a7a5a03ac7ec1b2ce387d08e4592374370c29622efa3389921aaf07d90dc',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:researchEngineQueue',
      fingerprint: '3b7e917a66306ed0d6f45ec7091632360da305dae25fdf0759a55d1f22bdf040',
    },
    ['bedrock:*']
  ),
  broker(
    'queue:infra/queues.ts:researchEngineQueueDLQ',
    'fc9787d34e6471af94a399dd6b53d266f1dd1d037fb591d7731ef8edec35d78d'
  ),
  wired(
    'queue:infra/queues.ts:riskEvidenceQueue',
    '744a05c568e64c7906e08892f3738cb30eb4511f45007108e4bb2f14dbb46fd8',
    {
      source: 'apps/workers/src/selfhost/riskEvidenceQueue.ts',
      symbol: 'registerRiskEvidenceQueue',
      fingerprint: '50eb5a8edbe03609e3a1c82a890052768effa06caf7cdac531dc833eafd1f8d3',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  broker(
    'queue:infra/queues.ts:riskEvidenceQueueDLQ',
    'c0f2898d8395eaa08e1c942c2697bdb2180b5d7ea4ce4cb969ae1411db1659fc'
  ),
  gapBecause(
    'queue:infra/queues.ts:secopsTriageQueue',
    'fea6f0e8a658e19e6e59e7ba9a6bf4369acb6d8f5220c0367839422cf4d4a14c',
    'Not registered. The admin security-dashboard ingest routes enqueue here; triage works on Prowler and AWS security findings that self-host does not produce.',
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  broker(
    'queue:infra/queues.ts:secopsTriageQueueDLQ',
    '5dae60c15cdbc4e123e5ffaafcfdfecbe658a3ac123be20c976beab0dd4f3c2a'
  ),
  gap('queue:infra/queues.ts:slackExportQueue', '68f38e363a04f80f675d884ee4a292ff84353add86a6efc0018ebcff9ea5cc29'),
  broker(
    'queue:infra/queues.ts:slackExportQueueDLQ',
    'e6f709c7a77ad92a6420578b8802c7199d3580045da4a245ec379dca2b2f2a84'
  ),
  gapBecause(
    'queue:infra/queues.ts:sreFixQueue',
    '64900b939f9aa0cd7b750efeb1cdda2e374a2aeef2e08aaffd8f23dc4cd20aa2',
    'Reached from the SRE Slack approval path and, on hosted, an EventBridge rule. Part of the SRE pipeline with sreJobQueue, which self-host does not run; decide the two together.'
  ),
  broker('queue:infra/queues.ts:sreFixQueueDLQ', '209afa13455584e3d213f4664f8bb372f97c4047b441a13c140c10a2d3b9950c'),
  gapBecause(
    'queue:infra/queues.ts:sreJobQueue',
    'dcedce8d2a640076d0a90810734ad6368f78257b091c93fcf76e0b8eb20e8096',
    'Not registered. The admin SRE rerun/retry routes and the GitHub SRE webhook enqueue here; the handler needs Bedrock and CloudWatch, which self-host does not provide.',
    ['bedrock:InvokeModel', 'cloudwatch:PutMetricData']
  ),
  broker('queue:infra/queues.ts:sreJobQueueDLQ', '37a9ace9b78c31a34324c565734ddad57f611e999c69c55b2052ed020cca1435'),
  gap('queue:infra/queues.ts:tavernHeartbeatQueue', '5ece4ce114a9900aeb8e5ce9f67c415d42d1623c8a3bdf99098e93ee613294f4'),
  broker(
    'queue:infra/queues.ts:tavernHeartbeatQueueDLQ',
    '3f2e2017042d9cc8ad66385424a377b2e04b2f1d137b3fcd2b229f1d277966b7'
  ),
  gapBecause(
    'queue:infra/queues.ts:webhookDeliveryQueue',
    'e81661d58bda4809d7f7ec3c594958d0c666c67be6691b0ee50ca0bf0cbd9704',
    'Not registered, so the webhook retry and replay-dlq admin routes answer 503. The handler is in open core: it needs a self-host consumer before the queue is registered.',
    ['cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:webhookDeliveryQueueDLQ',
    '489b16bdceaf15867423fcbfab9344b5e36cefcdbd6473c595f6604d440ad271'
  ),
  gapBecause(
    'queue:infra/queues.ts:whatsNewGenerationQueue',
    '235245848c15e940229884146d1cb811139d034deb10813936101c0435ff8ce5',
    'Not registered. whatsNewJob.dispatch consumes release notes and admin-triggered highlights; self-host has no release-notes pipeline or highlights consumer.',
    [
      'bedrock:InvokeModel',
      'bedrock:InvokeModelWithResponseStream',
      'cloudwatch:PutMetricData',
      'import:@aws-sdk/client-cloudwatch',
    ]
  ),
  broker(
    'queue:infra/queues.ts:whatsNewGenerationQueueDLQ',
    'e57a7345766ccd52531a45ce89ad2c994bc132aae123cf9664c62a15dad70b47'
  ),
  broker(
    'queue:infra/revenueSnapshotDeadLetter.ts:revenueSnapshotDlq',
    'fd103df5f8b6caa0d4d0e1b4397e7324565612ed1e7ac29cc5c7facecb6fdec9'
  ),
  broker(
    'queue:infra/subscriptionReconciliationDeadLetter.ts:subscriptionReconciliationDlq',
    'b84252bf5bb727b63bc13381e878d877e2d33ce431c80243b0ba479c90fcb8c4'
  ),
  broker(
    'queue:infra/serviceHealthAlarms.ts:ServiceHealthAlarmHandlerDlq',
    'e4bb21872791c985702b536156f97761b31bd8076566645850b9e6d87646ab6f'
  ),
  broker(
    'queue:infra/waf.ts:WafAlarmSlackHandlerDlq',
    'f2961ff5df989be1ef7ddf10631fe2499d4458ea709faca15171de84142a2fd5',
    ['ssm:GetParameter']
  ),
  broker(
    'queue:infra/youngAccountSpendAlertDeadLetter.ts:youngAccountSpendAlertDlq',
    '7c55bfdeaea409d972ba757cc5e3c8d50a5a0d1e8fd8629afab3473284bbbd6e'
  ),
  broker(
    'queue:infra/cloudScanDeadLetter.ts:cloudSecurityScanDlq',
    'ebb4d665a7729e8eeb32f3e0230f05cdc2ed1a459808e761e14f28e85502fa83'
  ),
  broker(
    'queue:infra/apiProbeDetectorDeadLetter.ts:apiProbeDetectorDlq',
    'f353ac779308cb585b976a6bd5e80854661ced29c7569618b666faf1fb7e6d61'
  ),
  broker(
    'queue:infra/spendMonitorDeadLetter.ts:spendMonitorDlq',
    '1cf26770977879e377a4c62a5d06cc22ad09892a0a144d012deb4070368f2223'
  ),
  broker(
    'queue:infra/signupGrantHeldReleaseDeadLetter.ts:signupGrantHeldReleaseDlq',
    '1856afc8013710101dc260617d02b2feca7f30a05c0a2444f823a5e1ae6b21c8'
  ),
  gap(
    'schedule:infra/cron.ts:accountCampaignSweep',
    'fbf102bff1f9fb5a03579c16cfb667e3fa6ac242a68535d2e33de491e50def17',
    ['cloudwatch:PutMetricData']
  ),
  wired('schedule:infra/cron.ts:adminAuditAlerts', 'affe75eb1ea58ec7de19131925c6c8907a82f258f187996331f5df4183eb3ab0', {
    source: 'apps/workers/src/selfhost/adminAuditAlerts.ts',
    symbol: 'registerAdminAuditAlerts',
    fingerprint: 'c3d09ab1645e180de73018af05a50b748c27dffcb699ccd1535be774c1359ab6',
  }),
  wired(
    'schedule:infra/cron.ts:oauthAbuseAutoBlockCron',
    '2a10f226e089ea8c82d6b54acf304b96fc0b8bc860a7dc699382095311a55b18',
    {
      source: 'apps/workers/src/selfhost/oauthAbuseAutoBlock.ts',
      symbol: 'registerOauthAbuseAutoBlock',
      fingerprint: 'f421e8a8e1984b196879bc7706dd98c72e4e4f181c08d64f0a6cee857fb5c304',
    }
  ),
  wired(
    'schedule:infra/cron.ts:agentExecutionAbandonedSweep',
    '231133ed8a07a894c6302ef73e91f887c3fe15d0f6440ce1ff7646802b1dea68',
    {
      source: 'apps/workers/src/selfhost/abandonedExecutionSweep.ts',
      symbol: 'registerAbandonedExecutionSweep',
      fingerprint: '2d305238c11a974e7bed4c70116beab12108402fa7dc0320906e99e3949d9ebc',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  gap(
    'schedule:infra/cron.ts:agentProactiveMessageCron',
    'a3a4b54741874e42badb485d6e9a0d412375149b86f6dc7289327a318470c46e'
  ),
  wired(
    'schedule:infra/cron.ts:apiKeyBaselineCalculation',
    'ca680d8a038544620ab0bbdc9570ed2d42f55fae714c495c6c279f6d0019bca0',
    {
      source: 'apps/workers/src/selfhost/apiKeyBaselineCalculation.ts',
      symbol: 'registerApiKeyBaselineCalculation',
      fingerprint: '0c849457ddc4e06c07e6ad9a52d4098359838ad885f25824720da1795e75e606',
    }
  ),
  hostedOnly(
    'schedule:infra/cron.ts:attackSimulationCron',
    '7d81c82a55e65d4d9869afed1fc3edfee51f467023b30f305c45009b4fffa731',
    'Inspects the hosted cloud account or dispatches hosted CI; not applicable to a portable deployment.'
  ),
  hostedOnly(
    'schedule:infra/cron.ts:CloudSecurityScan',
    '4f2fd97b93060d4477a8e915dc58c8f4f98695c0fc12ee678afa94122657ef55',
    'Inspects the hosted cloud account or dispatches hosted CI; not applicable to a portable deployment.'
  ),
  gap(
    'schedule:infra/cron.ts:completionSequenceSweep',
    'afd282ecb4669d8158a19fd9cb3a8f2fd9d43f4ffa5e5a7b632b79aa15ed2cc2'
  ),
  wired(
    'schedule:infra/cron.ts:creditHoldSweep',
    'bc1661185b11bb9dcdd5ef519bf44716500ce9de4e669b5123025dad85086c84',
    {
      source: 'apps/workers/src/selfhost/creditHoldSweep.ts',
      symbol: 'registerCreditHoldSweep',
      fingerprint: 'd5a06717fc21aeaaabc32cfbb3bd759dffe2f779c877d2c12481a13e5c007e2a',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  wired('schedule:infra/cron.ts:creditLotSweep', '988f2cffba7c1ae6c5c1394aa26f0fa09058d09f0a191847c24eed6bcd326eff', {
    source: 'apps/workers/src/selfhost/creditLotSweep.ts',
    symbol: 'registerCreditLotSweep',
    fingerprint: 'a8c89b47317a1c5821c18a6b5769c2bb20b64c1bafe69660994db5827757c7bd',
  }),
  wired(
    'schedule:infra/cron.ts:creditPurchaseReconciliation',
    '8455f96cc2ce815f18eab081597232ffd8b01ab372d4c04fa6a8d19fcbe3aef3',
    {
      source: 'apps/workers/src/selfhost/creditPurchaseReconciliation.ts',
      symbol: 'registerCreditPurchaseReconciliation',
      fingerprint: 'c22db348c12bb6a0d38bf36e8568a868cc26baa9cc64a4e5cb68fda52aa87124',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  hostedOnly(
    'schedule:infra/cron.ts:dailyUserActivityReport',
    'c8a18208501187549670f14edb67aea76c2c5dced73c8595ffc5749407c7c0b0',
    'Hosted production analytics report; not applicable to a portable deployment.'
  ),
  wired(
    'schedule:infra/cron.ts:dataLakeBatchReconcile',
    '823b7825df5b342867ef933b8b86c569b2521f9022d9196da88073835750bb48',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'schedule:dataLakeBatchReconcile',
      fingerprint: '28d228e8c7fef991c0fbac8f0c1ee984a021c898c0113e154e956eefcbd294fb',
    },
    ['cloudwatch:PutMetricData']
  ),
  wired(
    'schedule:infra/cron.ts:dataLakeResearchScheduleCron',
    'efd5553c06745990f5b45129ea61538c9cf20bd35a1850bb2345a154f931d5d3',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'schedule:dataLakeResearchSchedule',
      fingerprint: 'a1feb2ba8de9a1b89c6742ef764fe9cfda09652d298a575e73c777e1f4ee2059',
    }
  ),
  gap('schedule:infra/cron.ts:deepAgentWakeCron', 'b05e0f009dc9cacd227b7fc7a75120981412ec2ba9273c1717f1a175411dbed7'),
  wired(
    'schedule:infra/cron.ts:driveLakeResyncPoll',
    '4a57ab417b18829b4b1806e6f4a1dc4485de044404647b3ca108dac020552bd7',
    {
      source: 'apps/workers/src/selfhost/driveLakeResyncPoll.ts',
      symbol: 'registerDriveLakeResyncPoll',
      fingerprint: 'c64f9756d199dc8adebf0f39e59614318deb2b456bf65c929b3f73268b1c3ad3',
    }
  ),
  gap(
    'schedule:infra/cron.ts:emailCampaignScheduler',
    'ee247038b12ce49f0d07d034f5133583aa94a27246159b623fa2101184eaecd8'
  ),
  wired(
    'schedule:infra/cron.ts:generationJobSweep',
    '271a3c910b238b8cb993ab8105a7cb6b3b4bf1e03fd88ef58013d8513f1e5c22',
    {
      source: 'apps/workers/src/selfhost/generationJobSweep.ts',
      symbol: 'registerGenerationJobSweep',
      fingerprint: '687b207c61a761f05b0b3b4fff8fc14f3458f119071153de2fd2723979f119f8',
    }
  ),
  wired(
    'schedule:infra/cron.ts:githubLakeReconcile',
    '20ca232bfee1e87547ce919a334890dee7dbaf0b2cf3b19286d5a0364e720a96',
    {
      source: 'apps/workers/src/selfhost/githubLakeReconcile.ts',
      symbol: 'registerGitHubLakeReconcile',
      fingerprint: '28fa72e17231df491e249d4e4d5fd0d19023022e7e4e52fde5f9f16e1781cecd',
    }
  ),
  wired(
    'schedule:infra/cron.ts:helpDatalakeIngest',
    '730ccd34ff9f62c9a9d40425c834c4a409a0710624664f18d2b27e97faac0a7e',
    {
      source: 'apps/workers/src/selfhost/helpDatalakeIngest.ts',
      symbol: 'registerHelpDatalakeIngest',
      fingerprint: 'ca737f233283cb1a64a2bddd0baad7bc5b2f47b6eb1cdd1e5f0cee226e01c2dc',
    },
    ['bedrock:InvokeModel']
  ),
  wired(
    'schedule:infra/cron.ts:integrationHealthCheck',
    'e32811bfe25a37db6f804d58dca89956b809c85ba1cd48b8ad8ae057f520bb54',
    {
      source: 'apps/workers/src/selfhost/integrationHealthCheck.ts',
      symbol: 'registerIntegrationHealthCheck',
      fingerprint: '8db42864301d582151bd835a485f99e2d3c5a5a48241e198a9d7e09089f07523',
    },
    ['cloudwatch:PutMetricData']
  ),
  wired(
    'schedule:infra/cron.ts:lakeConnectorOrphanReap',
    '552a7fe36d0a43a890f868d3168c3bf8ce4ef66625f3473b153db88fc87a2a14',
    {
      source: 'apps/workers/src/selfhost/lakeConnectorOrphanReap.ts',
      symbol: 'registerLakeConnectorOrphanReap',
      fingerprint: '2f90eb27924b7d29b3d80505ff3c393740947f1dcc92ff289dec31aba793f335',
    }
  ),
  wired(
    'schedule:infra/cron.ts:lakeHealthSweep',
    '049b7f3c434102e26e045a9c303edeb1a1ec1c965369eeecc596de8cddd32825',
    {
      source: 'apps/workers/src/selfhost/lakeHealthSweep.ts',
      symbol: 'registerLakeHealthSweep',
      fingerprint: '7b707156b4804bef2a829d784bbdfd104cef6765680ebd323909880c82456e34',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  wired(
    'schedule:infra/cron.ts:lakeInconsistencySweep',
    'db78ff28482aa8e97c37f84077e902059b4b2f686b4d1c26574286a9e078dd9d',
    {
      source: 'apps/workers/src/selfhost/lakeInconsistencySweep.ts',
      symbol: 'registerLakeInconsistencySweep',
      fingerprint: 'd1e27a485506840b87ec42b02a47573e744ca7e02c5a28316506a2d57dcdf816',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  wired(
    'schedule:infra/cron.ts:modelDiscoveryCron',
    '7f54c87d76d28adbb51b23f078e98f3a064f2d7fca9c4017ced0b640f4c018bf',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'schedule:modelDiscovery',
      fingerprint: '7bb8572e582e2ead0c777271c9b9c41c51001d2ce2f358b19ecde4c4345226e0',
    },
    ['bedrock:GetFoundationModelAvailability', 'bedrock:ListFoundationModels', 'cloudwatch:PutMetricData']
  ),
  gap(
    'schedule:infra/cron.ts:dataLakeVectorIndexKeepWarm',
    'e52a55016d4e296fad2509ece2c328abb3a75afb574308f221762ab2049e8d45'
  ),
  gap(
    'schedule:infra/cron.ts:disposableDomainRefresh',
    'd4acc4d47d84373b51e0aaf008c3f5e4a263bd3a1d99510c1f42628710ca99a0',
    ['cloudwatch:PutMetricData']
  ),
  // Works the holds the refresh above makes possible (rule, then the advisory assessment), so it ports with it.
  gap(
    'schedule:infra/cron.ts:signupDomainHoldTriage',
    '56a0ed993d2dc81d57c25b4702f9a884eddce8577c7a873638f2d5691c7bf3c8'
  ),
  gap(
    'schedule:infra/cron.ts:modelDiscoveryStalenessCron',
    'f906894c42c72f63c47bff4cd0214d9803e241702098291f3a30a67204b0da99',
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  hostedOnly(
    'schedule:infra/cron.ts:providerUsagePoll',
    '245d08b5ccee4a98d3261e769cb8f0c409bfd1d6ada0fc1cde7b87eacaeeb5c7',
    'Publishes provider-reported spend to hosted CloudWatch alarms on monitored stages; no local metric or alarm destination is configured.',
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch', 'ssm:GetParameter']
  ),
  wired(
    'schedule:infra/cron.ts:questTimeoutSweep',
    'd139c008ae202db6723c79bce5a00857e3ef35cde2c7a7501e52ce7846456889',
    {
      source: 'apps/workers/src/selfhost/questTimeoutSweep.ts',
      symbol: 'registerQuestTimeoutSweep',
      fingerprint: 'd51aeb7871d0b24b9fe6052862370e617e4d16b8f660adf0f5fd81e2d5465a7d',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  wired(
    'schedule:infra/cron.ts:realtimeConnectionSweep',
    'bf66e36c3cbd4db57c4a212cee8521ba98d9fc3baf15c168560229e045209f7d',
    {
      source: 'apps/workers/src/selfhost/realtimeConnectionSweep.ts',
      symbol: 'registerRealtimeConnectionSweep',
      fingerprint: '786cca0d3f334531b90d437cb49f4e4335b24989be24bfead1845eda9fb0e380',
    },
    ['execute-api:ManageConnections']
  ),
  wired(
    'schedule:infra/cron.ts:referralRewardRelease',
    '656f40b737d457721ff3a417c7711858a608eb7f462d408e0f37ae534c6a0cf9',
    {
      source: 'apps/workers/src/selfhost/referralRewardRelease.ts',
      symbol: 'registerReferralRewardRelease',
      fingerprint: 'f09c7a4636a708ef49fae2c8166825ab51457c5abf7a5b017b216b4c458e3200',
    }
  ),
  gap('schedule:infra/cron.ts:revenueSnapshot', '7362008fcc90113d2b09beb4abced26b05b1bb41a3e933cb5d2535ac7e07f6cd'),
  gap(
    'schedule:infra/cron.ts:subscriptionReconciliation',
    '5ecf7b3d61f56bc8e5713af17065c9c7b48b1a66ca5688f6ad0d5b7c72d16f19',
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  wired('schedule:infra/cron.ts:scheduleTaskCron', 'e54147287d6495b6bd8026e41cc0ff88788bdbceb50c22dbc1365671f2381007', {
    source: 'apps/workers/src/selfhost/taskScheduler.ts',
    symbol: 'registerTaskScheduler',
    fingerprint: 'f394d8b0c0847bf801d80443d57e8f46a220a037cc7a0484d9f9d39365c5206e',
  }),
  gap(
    'schedule:infra/cron.ts:secretRotationNotifier',
    'e113c8515bc8c5b1a38928a22e4d50fb139855e8d2b5b2ec55fa93c1696a2971'
  ),
  hostedOnly(
    'schedule:infra/cron.ts:securityScanScheduler',
    '5088f620c550e6393774f65106df2b3d6fec646c913d92434b6d0e33ed5ff734',
    'Inspects the hosted cloud account or dispatches hosted CI; not applicable to a portable deployment.'
  ),
  gap('schedule:infra/cron.ts:signupRiskSweep', '0605877b1fee8aca08729e2137c078eb36f8b21b4fb20549761d5b60c151e6fe', [
    'cloudwatch:PutMetricData',
    'import:@aws-sdk/client-cloudwatch',
  ]),
  wired(
    'schedule:infra/cron.ts:skillMarketReviewSla',
    '697ac5832f8ddde3e173f89d1b8dde98f233da8187f3babf59abe26f215867c9',
    {
      source: 'apps/workers/src/selfhost/skillMarketReviewSla.ts',
      symbol: 'registerSkillMarketReviewSla',
      fingerprint: 'ae0a54d14fe11d85386d43d6724cd8b56cb98f3639f1433ae32e24561e0dabdd',
    }
  ),
  wired(
    'schedule:infra/cron.ts:spendReconciliation',
    '56a292793783e8a4c1463f31d9606391eee1e6a999ce1fcc5f7f55bc483a521d',
    {
      source: 'apps/workers/src/selfhost/spendReconciliation.ts',
      symbol: 'registerSpendReconciliation',
      fingerprint: 'ca9cbea76249daab2f0359e7faecad3f4dcd80c3269a0481a74e9a69a41a6d8b',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch', 'ssm:GetParameter']
  ),
  wired(
    'schedule:infra/cron.ts:storageReconciliation',
    '5d1eb362eae9f41ec77081db00b41f18e7af165448331a564ad5634f09e9932f',
    {
      source: 'apps/workers/src/selfhost/storageReconciliation.ts',
      symbol: 'registerStorageReconciliation',
      fingerprint: 'da6c5ac52b4df8ea3674b0f3c367e1e367ccc43dc282edea6730a2cca21d68de',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  hostedOnly(
    'schedule:infra/apiProbeDetector.ts:apiProbeDetector',
    'a1ce4a578e7e46c5a53e3e9bbceafcc7e2c76e93a435a1b28e8da355d0303abd',
    'Queries the hosted server function CloudWatch log group; a portable deployment has none.',
    [
      'bedrock:*',
      'cloudwatch:DescribeAlarms',
      'cloudwatch:GetMetricData',
      'cloudwatch:ListMetrics',
      'cloudwatch:PutMetricData',
      'events:PutEvents',
      'lambda:InvokeFunction',
      'lambda:ListEventSourceMappings',
    ]
  ),
  hostedOnly(
    'schedule:infra/youngAccountSpendAlert.ts:youngAccountSpendAlert',
    'c7844fc8ec21721907300874349c2c0677aef7cb092f3041136af6b32f9bf2e9',
    'Hosted production abuse alert to Slack and hosted CloudWatch alarm threshold sync; not applicable to a portable deployment.',
    ['cloudwatch:DescribeAlarms', 'cloudwatch:PutMetricAlarm', 'import:@aws-sdk/client-cloudwatch', 'ssm:GetParameter']
  ),
  hostedOnly(
    'schedule:infra/cron.ts:spendMonitor',
    'd9b098e7dc3e30b070b148a13625050b057541918960ed8259c2901866c22096',
    'Hosted spend alerting to Slack; not applicable to a portable deployment.',
    ['ssm:GetParameter']
  ),
  hostedOnly(
    'schedule:infra/cron.ts:signupBaselineReport',
    '23843dfc0cbc0e87175ddce54aa8f3a5779ced62846f39daedf56b322f03ee08',
    'Hosted production analytics report; not applicable to a portable deployment.'
  ),
  hostedOnly(
    'schedule:infra/cron.ts:SreStaleDispatchCron',
    '91bbf43d2f4288d039b17b5258fb32e0998597ed586df3b174b32311ee131ad6',
    'Hosted error triage and auto-fix dispatch; not applicable to a portable deployment.'
  ),
  gap('schedule:infra/cron.ts:personaExpirySweep', '6994be0fdcb6a4252ee07d551f5bed1b35ddef6a986b68bd49b1c7736bc5d2cd'),
  wired(
    'schedule:infra/cron.ts:signupIpRetention',
    'b90d6f8f8b7bdc5640a0de6c90b64dcdc176e9170da8d595b5aa6a52328cb312',
    {
      source: 'apps/workers/src/selfhost/signupIpRetention.ts',
      symbol: 'registerSignupIpRetention',
      fingerprint: '969bed6cde6dafb23b320883c779caff4c30686bce073f671c27da06190f92a6',
    }
  ),
  // The sweep also deletes callable function data: the data bucket when hosted, the files bucket on self-host.
  wired(
    'schedule:infra/cron.ts:accountDeletionSweep',
    'f17522d8779b0a87c5e15914ac358c662109fafa58ad839818f92175c42d400e',
    {
      source: 'apps/workers/src/selfhost/accountDeletionSweep.ts',
      symbol: 'registerAccountDeletionSweep',
      fingerprint: '066c963d8fc050105d384918d3f371392af41fbf65dcc1bc653ed65e72023146',
    },
    // Hosted-only overdue-deletion metric; the self-host runner passes emitMetrics: false.
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  wired(
    'schedule:infra/cron.ts:signupGrantHeldRelease',
    '690cb86f66b18eb610e50cfa052ee0e4da2b5b86f6bd7a9803dd62c56f4848be',
    {
      source: 'apps/workers/src/selfhost/signupGrantHeldRelease.ts',
      symbol: 'registerSignupGrantHeldRelease',
      fingerprint: 'd219f930b821a44c4a28c40e3ac31f890b387145fbdeb3176ea0cda1a5eb8bc2',
    }
  ),
  wired('schedule:infra/cron.ts:telemetryCleanup', 'acff554d296fc87f3f7725212e16ba2c11d5490fd1cdc7251b95b6e78c51c140', {
    source: 'apps/workers/src/selfhost/telemetryCleanup.ts',
    symbol: 'registerTelemetryCleanup',
    fingerprint: 'da6450a4a59ea6ac4f91f4b6adc5e7c54586164f920952bb76654f03b4b0e228',
  }),
  gap(
    'schedule:infra/cron.ts:abuseAssessmentSweep',
    'd6e32f3fbe83d61fe3b30767b34354f69c92ec481e30bc81c02b6d2f1c1f8b45',
    ['cloudwatch:PutMetricData']
  ),
  gap('schedule:infra/cron.ts:usagePatternSignals', '066edef1ae0b959ca2c6049626beb3c8630d5c22f99aed2b3bca1430f1f05766'),
  wired(
    'schedule:infra/cron.ts:briefScheduleReconcile',
    '6dd141487c31b6bdafe7341f833f13f1b19b28f5700694c4660cddffc89b0a95',
    {
      source: 'apps/workers/src/selfhost/briefScheduleReconcile.ts',
      symbol: 'registerBriefScheduleReconcile',
      fingerprint: 'b1f618f6a89c1a4d0923de630873242781fd0154b7cf94527d59daae981ea065',
    }
  ),
  wired(
    'schedule:infra/cron.ts:voiceHoldSweep',
    '595f6930f39b7886ff6aeef3816bbb8acf214f81f330b3ece125304ca9908328',
    {
      source: 'apps/workers/src/selfhost/voiceHoldSweep.ts',
      symbol: 'registerVoiceHoldSweep',
      fingerprint: '736ef108898650ecdd41332d5ae49e3c3be864687111b57dd122e431a0b54b5b',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  hostedOnly(
    'schedule:infra/cron.ts:weeklyUserActivityReport',
    '02a3fe8ea7ca78f392c4bb41313cbf98cbbd98f8da7d085761e1c7b33131e30f',
    'Hosted production analytics report; not applicable to a portable deployment.'
  ),
  gap(
    'schedule:infra/securityAlerts.ts:SecurityAlertsSchedule',
    'f6d1104ad23019a998cff839ce029a6e0736637cf62587efb351826e0a9fc778',
    ['events:PutEvents']
  ),
  gap(
    'service:infra/chatCompletion.ts:ChatCompletion',
    '9255c6433e28841ef412bd76bf1fcde5031a63b7c0ab25d89750098c7db41a9c',
    [
      'bedrock:*',
      'cloudwatch:PutMetricData',
      'events:PutEvents',
      'execute-api:ManageConnections',
      'lambda:InvokeFunction',
    ]
  ),
  gapBecause(
    'service:infra/renderWorker.ts:RenderWorker',
    '45dc01b107b094d7b2b7a3f5e2490002b0083b7cc20f2fdb0e8cb2dc7365d355',
    'Hosted Fargate twin of the render worker; self-host runs the same image through the chart renderWorker Deployment or the render-worker compose profile (both opt-in).'
  ),
  gap('service:infra/searxng.ts:Searxng', 'fef5f4ce5e094d32525bb4a13828a34b67ba75a38ab72c70e526ba908c31f049'),
  gap(
    'service:infra/subscriberFanout.ts:subscriberFanoutV2',
    '93a5312a4a0ff8b50927169d7801ec022068b8f1c7aa5f6b75afff7f1c3451ba'
  ),
  gap(
    'sesRule:infra/emailIngestion.ts:emailReceiptRule',
    '05b3592ffe98bceb32dc139bdfd95f5ecde2d2f3d5b1f8eca9b51e78c28c68dd'
  ),
  gap(
    'snsSubscription:infra/dlqAlarms.ts:DlqAlarmTopic',
    '5e2b51e155fca8780f1b5a2b76d04559750bb1aca7bbe0a8b14384fe97bf8ce3',
    [
      'cloudwatch:DescribeAlarms',
      'cloudwatch:GetInsightRuleReport',
      'lambda:ListEventSourceMappings',
      'ssm:GetParameter',
    ]
  ),
  gap(
    'snsSubscription:infra/dlqAlarms.ts:OobAlarmTopicEmailSub',
    '74a62b4123aa86855c94deee69bae3c79722c4f170f78ff0b06e2a45c43d6644'
  ),
  gap(
    'snsSubscription:infra/serviceHealthAlarms.ts:ServiceHealthAlarmTopic',
    '236d9e12c4b910de67db48aac7c6cd3b3d208f78b378c167a33f48c9f90c63d0',
    ['ssm:GetParameter']
  ),
  gap(
    'snsSubscription:infra/waf.ts:WafAlarmSlackHandlerSubscription',
    'cc4e60428fac88be1d07e98d03a3c7db89cb6c48f8ee7d61df00a2a336817381',
    ['lambda:InvokeFunction', 'ssm:GetParameter']
  ),
  gap(
    'snsSubscription:infra/waf.ts:WafOobAlarmTopicEmailSub',
    '7ec141237e2361d750e23d941542e3370946c5f9a835bdc2f5ca6b0413256dc9',
    ['ssm:GetParameter']
  ),
];
