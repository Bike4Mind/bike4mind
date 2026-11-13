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
// b4m-core/resource/src/manifestCoverage.test.ts.
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
    'queue:infra/adminMorningBrief.ts:adminMorningBriefDlq',
    '02f77874c10969d8ede24d54d660f8722b34b4826b403446b8a06ca17bceae54'
  ),
  gapBecause(
    'schedule:infra/adminMorningBrief.ts:adminMorningBrief',
    '1b5ed24c369a01d8495f89deb746b27f0e9d34463bf8cc1c035b7e6fcedefe5c',
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
    'c8f7a1da54367bdfacb6ccdf02843f4bca8200dfd493942452a3a402dab910c4',
    'Hosted business analytics and Stripe receipts; not applicable to a portable deployment.'
  ),
  gap('event:infra/eventBus.ts:email-send', 'b19f0525b465da453fa0fa04023bdcac4b3b57e706ed181099baea524d661f80'),
  gap(
    'event:infra/eventBus.ts:notebook-curation-complete-analytics',
    'cb7bc46a17716134f82299540bcff81030e1d4ef64e17f7a924d154f5d28c44a'
  ),
  wired(
    'event:infra/eventBus.ts:notebook-curation-start',
    'b6742dbc92edf5e0bf7fb308e1e0e80836895f15a9a1251de4adca31c7339c64',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:notebook.curation.start',
      fingerprint: '9b247a06b54f9b7cd6d62055a9cc632b77f7e2ea7eb35812a6e26b3a285d2d42',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:notification-push',
    '1d4f0749b60c697060403170a0c9b990b3a8e7bf3fa78b6e478d678fbaf7e81e',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:notification.push',
      fingerprint: 'dc9829cc0587b4bcbe226a51338fb9571274d421bb4bfe9f6f908cb11306f732',
    }
  ),
  wired(
    'event:infra/eventBus.ts:RiskEvidenceCompletion',
    '4c061c91603a4206bb0f27ee214d9da78c94c628f5826975077f50a2ea6b77f6',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:completion.completed',
      fingerprint: '0649aaa852f49eca1576ecebbeecbdedf22592c9e8e26f4d08560b3c84e08bcc',
    }
  ),
  wired(
    'event:infra/eventBus.ts:session-auto-name',
    'ea1b77be7b230d115c567ae9d10c4a1d68b4ddcb211438334d946996baed5a06',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:session.auto_name',
      fingerprint: 'c43dc539a5ec4d5714d199b857e5678c18cc0a861de45ed029aca162dd543e83',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:session-context-summarize',
    '2144e217cbfc1bee2e633628e68c2abee7360f7ed57f4baa7b7acbe6d8c52969',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:session.context_summarize',
      fingerprint: 'bb4245247ac7394880952238b76dee7a81b3eea730dada39c7478fb990480dfd',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:session-summarize',
    '05c5dd655f6bf4e78873dd5318fb9a6c10797b8ac8cf7cdb0f2fa455c4fb0f4c',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:session.summarize',
      fingerprint: '555c30a8e488e9062b3175dd993a9df47b5fe3c33e8a85337e888a331cafb041',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:session-tag',
    '9a69365990af9ff3201e90703ac96ab3690d55e206990c6cfa80d119fc780387',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:session.tag',
      fingerprint: '85ec09d7fbb4ce7f47372286bb90ff8106d4ccd5e7e6c0e47a4747a280d9e6eb',
    },
    ['bedrock:*']
  ),
  gap('event:infra/eventBus.ts:spider-start', 'bc8132dcb30dd30537ff5c71cd847ac6f05cace412185cdad912192670244920', [
    'bedrock:*',
  ]),
  gap('event:infra/eventBus.ts:SreFixDispatch', 'fa1122e45e2de82ee4a61c73ce860a679f2f5ce735bc628dd56a35c82977a648'),
  wired(
    'event:infra/eventBus.ts:stripe-customer-subscription-updated',
    '70968c5cdd6676c98cc717c705b0bbbf0e7a580141bf661e6056e03d317e61d6',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:stripe.cus.sub.updated',
      fingerprint: '0532bab1720ac525ac742d2bae613bbd781e874bed17b32d2435a35d68ee59f4',
    },
    ['cloudwatch:PutMetricData']
  ),
  wired(
    'event:infra/eventBus.ts:stripe-invoice-payment-succeeded',
    '7b1494fe3c29577a1e97155abf4aef839594d4068983540249ea70798d56a872',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:stripe.invoice.payment_succeeded',
      fingerprint: '8feeee6f9d613fa31c9e2d515882697227f6099f09500aa4ba65c68d051f2c1d',
    },
    ['cloudwatch:PutMetricData']
  ),
  gap('event:infra/eventBus.ts:telemetry-alert', 'b3bbf20605b8bd590f762748345e3b8b45aae64d1abf14003a1ed98a9f69d1e1', [
    'bedrock:*',
  ]),
  gap(
    'schedule:infra/imageModerationReviewSweep.ts:imageModerationReviewSweep',
    'efe33b9933a43713e7431275d8ad017b36a52e0055494e11877cbf3d48a2d708',
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
      fingerprint: '0649aaa852f49eca1576ecebbeecbdedf22592c9e8e26f4d08560b3c84e08bcc',
    },
    ['bedrock:*']
  ),
  gap('event:infra/llm.ts:slack-completion-start', 'c4c9338cee5583d247b03a72c2d4c36182ad25d515465dbd00f9c3617909c608', [
    'bedrock:*',
    'cloudwatch:PutMetricData',
    'events:PutEvents',
  ]),
  gap(
    'eventRule:infra/serviceHealthAlarms.ts:EcsTaskFailedToStartRule',
    '01f62b8ab1bf553612fc628bc26d6241b1c4eafcb75c213306a47abc62679d7e'
  ),
  gap(
    'function:infra/agentExecutor.ts:AgentExecutor',
    '2fd40549c54518a28a38bfdc250df5269720c41921f278c1949775403c9bbfaf',
    ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'cloudwatch:PutMetricData', 'events:PutEvents']
  ),
  gap('function:infra/database.ts:DatabaseCleaner', 'e52f8c2f59b621e25176f06917724c82cd678c213de7325e2d9ad064c2971b70'),
  gap(
    'function:infra/database.ts:DatabaseMigrator',
    'cc63c4c32c4af36109af99b1f044d2c47c3e712170872410087168fa8ac48ed6'
  ),
  gap('function:infra/database.ts:DatabaseSeeder', '653abf813d7a9c59d9a6d53bf9d9be0a6c5e36669cc53860b896b9cee574cc5a', [
    'ssm:GetParameter',
  ]),
  gap('function:infra/dataSyncer.ts:DataSyncer', '6b34c84dc682604d934700c4c8156e0127c4779ea369a3de7a3d02649fae6b9b'),
  gap(
    'function:infra/imageProcessor.ts:ImageProcessor',
    'c5e9f27f05e17f199f30caf0c9d784d11c16095ef237b4ebd8df1fa2a68f8b47'
  ),
  gap('function:infra/mcp.ts:mcpHandler', '8f95aa9d3422dccc02308adb7da5500afa9582d09351477574a7e4f2331b814f'),
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
    'logSubscription:infra/logMonitor.ts:createLogSubscriptions()',
    'bbad157840d9254be64aef4e45143a82514a3aa5caf069c96a019ea1b46a4e09',
    ['lambda:InvokeFunction']
  ),
  gap(
    'notification:infra/buckets.ts:appFilesBucket.uploadComplete',
    '473f2f1a55c650ff22780d274eb8cee26c2358527d9d53e14f07efa465b5ac60'
  ),
  gap(
    'notification:infra/buckets.ts:historyImportBucket.notebookImportCompleted',
    '038477bf6725480f4648201ff0ee3640423f78bb39f3c04d9b45a8cdcd3d434a'
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
    'ff40f8f4a4fe713d167b5ac7effedde8d28ea1c423883b73116070145968a506'
  ),
  broker(
    'queue:infra/dlqAlarmHandlerDeadLetter.ts:DlqAlarmHandlerDlq',
    '1f154dd82d798f8212508c571b43a3326554ae0b9c1946887a067df54d053c17'
  ),
  gapBecause(
    'queue:infra/emailIngestion.ts:emailAnalysisQueue',
    '8d9530e6a23e006c53e48ac9cb08ac1e75a823c9945541299b073514202756ff',
    'Enqueued only by the inbound-email parser, which consumes emailIngestionQueue, so nothing produces it on self-host. Wire both together if inbound email is ever supported.',
    ['bedrock:InvokeModel']
  ),
  broker(
    'queue:infra/emailIngestion.ts:emailAnalysisQueueDLQ',
    '3293f56dff623e68c9514a4305754db7930dabcab9adbc52eb71e63ccecc7c7b'
  ),
  gapBecause(
    'queue:infra/emailIngestion.ts:emailIngestionQueue',
    '83064348d61e40b8846828284fa9dce1613c827ff01746b55ffd5c87d2c08d36',
    'Filled only by the SES inbound-mail bucket notification, which self-host has no equivalent of. Registered in the manifest, but nothing produces or consumes it locally.',
    ['bedrock:*']
  ),
  broker(
    'queue:infra/emailIngestion.ts:emailIngestionQueueDLQ',
    'f44858b26f2ee8f4fb254d41d172e76694252114fb45ab805e510e34c3897f1a'
  ),
  gapBecause(
    'queue:infra/emailMarketing.ts:emailBatchQueue',
    'aa64be1ebe1de1e4f53641229d69e6a6d8319c553e0af6f5ed8df9faea717b24',
    'Fed only by the email job orchestrator (the emailJobQueue consumer), so it stays empty until emailJobQueue is wired. Wire the two together.'
  ),
  broker(
    'queue:infra/emailMarketing.ts:emailBatchQueueDLQ',
    'ff7a3dc9d711600848964bb4825fac5af480800f91d5018d6e02b08064a17d73'
  ),
  gapBecause(
    'queue:infra/emailMarketing.ts:emailJobQueue',
    '95ca3d63d4c4950608d7e94b9c04318ae0bde26e7f38f786f1fdc654f119a32b',
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
    '51d69b6319f8c98b58aafdb2d3039a8137e75b9fc69697075d819898dd0b99d4',
    ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'cloudwatch:PutMetricData', 'events:PutEvents']
  ),
  broker(
    'queue:infra/queues.ts:agentContinuationQueueDLQ',
    '6a36ae54a4e5ea35b9c34a06d407cee8281bcd6284eeeecf35d7c530dd0c6ffb'
  ),
  gapBecause(
    'queue:infra/queues.ts:agentProactiveMessageQueue',
    'dbd862b5a366753ee2a95dc40d46bc4ccc009956267bf4a3a2ad55371422859a',
    'The session trigger-proactive-messages route enqueues here and no self-host consumer drains it, so triggered messages are never sent. The handler is in open core: candidate to wire.',
    ['bedrock:*', 'cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:agentProactiveMessageQueueDLQ',
    '1990fa893bed28bef2523e156f10d9e0a787552590a76489415b59814359c2a9'
  ),
  gap('queue:infra/queues.ts:bobRunQueue', '29e45091d355f0701e5c072abeee970273010c70fb854dbb863396a059bbaec9', [
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
    'c7246a0a232128a250244202c6edf6384cb6604deac094cc58fd9706a35af2e2',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:dataLakeResearchQueue',
      fingerprint: '79cd3768c14cfcbb5ce7c6f5b8381aa98ed5c2ebef1a7e8ee1e3a489de8b35f9',
    }
  ),
  broker(
    'queue:infra/queues.ts:dataLakeResearchQueueDLQ',
    '282597bb81f72e340915441f8a2556c94f86bc43be0eb76db1f625d2d052a5ec'
  ),
  wired(
    'queue:infra/queues.ts:dataLakeTaxonomyQueue',
    '019eb651caa124acd54f242b48a5d0a11c8a2c25ee03342ec504c3246667c7f3',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:dataLakeTaxonomyQueue',
      fingerprint: '5a7d423174e135ac298eec7354e81f7f4c870cd0420c88c8b1d655af6a397ae3',
    }
  ),
  broker(
    'queue:infra/queues.ts:dataLakeTaxonomyQueueDLQ',
    '09d613eb6bffdc733600b1b2dbb9a68496671babcfb7a2b8769c84b5d65d9bbd'
  ),
  gapBecause(
    'queue:infra/queues.ts:deepAgentWakeQueue',
    '7fabc060e567ba3872895852fdecd1c0a371fa8cfbfa14966a1fd89e0dd57ad1',
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
      fingerprint: '97f8b804f4e1f99fad12e4671f0aaf83409509982f59492c19d36408efed0239',
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
      fingerprint: 'e781e3fb2f50a292b9cbaf71b05af05204efe95d356c2a3a7b4cd9f71403cd40',
    }
  ),
  broker(
    'queue:infra/queues.ts:driveLakeIngestQueueDLQ',
    '936a38165a1530a6e2300096213886ea50250a8cc9d8f192e5877234d74ea18f'
  ),
  wired(
    'queue:infra/queues.ts:fabFileChunkQueue',
    'c32b84d2dced60212e5b1955ed46941f8a911bfa41c4151b7757b673b84a7d9d',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:fabFileChunkQueue',
      fingerprint: 'd471c1cffc3855608c975eb46d53e0066eb84dcd977a17bb327c543dc3df1331',
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
    '30aa1c30861a66d83dfa7caeac58138a628d46d7b42f5c9f29ee552cd0b88250',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:fabFileVectorizeQueue',
      fingerprint: 'c2b6a7bc97b18da2639bfa606857fac0cc8437a90db692db9071cd0a7668c782',
    },
    ['bedrock:InvokeModel', 'cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:fabFileVectorizeQueueDLQ',
    '2e3862991aa93a6c5edc3d625cb53fdf125b408f1b85d204208d5d5531b04195'
  ),
  wired(
    'queue:infra/queues.ts:generationCallbackQueue',
    'e635e70bd46291de225fb89a2109f4429394ae61fcffdd17436b0a2aef482198',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:generationCallbackQueue',
      fingerprint: '75567fcfbc4856f775c59409712c3c1516ba88cd4dfa423823f485a9dc614195',
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
    'e268e038c95b3f6efaf73e354b37ec08c8a36793111d0336bcc9a0d53c3f3a1c',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:generationJobQueue',
      fingerprint: 'd83fe8afd215b17fe620bbef761f3c81ffac76d3e2640cf26bc38a98c5c14cc8',
    }
  ),
  wired(
    'queue:infra/queues.ts:githubLakeIngestQueue',
    '5991bc2614a68d8d7a45c8db5361eca1d80a1f52053ee29bc879093903636a28',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:githubLakeIngestQueue',
      fingerprint: '6a256b8ec5b0ff5f864ead529be2ba84f2a41b53b97816986755e0e805b371ec',
    }
  ),
  broker(
    'queue:infra/queues.ts:githubLakeIngestQueueDLQ',
    '85d47c076cbe0cbf6f649423831607793f7c8e014bb946603b1252de412abf4c'
  ),
  wired(
    'queue:infra/queues.ts:githubLakeRevokeQueue',
    'e813340095aa304e65e8f0176a6f16b9189282f8ca12fa623f17628bd6c655cc',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:githubLakeRevokeQueue',
      fingerprint: 'd8d0bd9d53d78357a9f22fdee461daa2ac812251aff70b025f09fe052fd19bad',
    }
  ),
  broker(
    'queue:infra/queues.ts:githubLakeRevokeQueueDLQ',
    '4491856037e8f9226cdeb137466706aa7bc84abb90e191d01aef7f42424825d1'
  ),
  gapBecause(
    'queue:infra/queues.ts:generatedMediaPurgeQueue',
    'f0877af2f06e1496e13554dd084fd1b5dc2ecc5622828f03f1a373cdaa6e02d0',
    'Optional. Notebook and message deletes hand it the generated media their request budget did not reach; with no URL set the leftovers are logged and dropped. The self-host templates declare it with a URL, as queue parity requires, but no self-host consumer is wired yet, so leftovers wait in the broker until one is.'
  ),
  broker(
    'queue:infra/queues.ts:generatedMediaPurgeQueueDLQ',
    'c2d58c32249e95e85b54c27855e71c6dc8512ff1fc4965a78013fd5eee539abc'
  ),
  gap('queue:infra/queues.ts:githubWebhookQueue', '72684acab9efbf0efebee843b28926a7b94e7817cc558d1f9e6b6a9f717f2eaf', [
    'import:@aws-sdk/client-cloudwatch',
  ]),
  broker(
    'queue:infra/queues.ts:githubWebhookQueueDLQ',
    'a2822aee5a83e5452e0217169125d1a7788fe9a5f4c78dada41fb6e4aa412fb9'
  ),
  broker('queue:infra/queues.ts:imageEditDLQ', '10c1a0580567d9b39e1c9547b6edccdbf9e9e6a71ea74c050e73f8da63190074'),
  wired(
    'queue:infra/queues.ts:imageEditQueue',
    'e032bf356275315f97dbf4f8b5444b50f08fb05aafb5db4cd63d25553d69d7f7',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:imageEditQueue',
      fingerprint: '36005486ce1eea69f75dc17f52160a5f74b7de2cc9775bc110426c27ac7e241e',
    },
    ['bedrock:*']
  ),
  broker(
    'queue:infra/queues.ts:imageGenerationDLQ',
    'e5555dbe58ec90c0fe40c11b46fab25d491c21b2e0e4db14a8bd75bb24684051'
  ),
  wired(
    'queue:infra/queues.ts:imageGenerationQueue',
    '4227eb91fc5d77e70f8cb7077fe125c5738023305f52defa456e712bf7fe96cf',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:imageGenerationQueue',
      fingerprint: '22e4c3b7c38347ea42d522dd790fa085dbdf2be4e1d06e1fd06cabfa6b859546',
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
  wired('queue:infra/queues.ts:lakeMemoryQueue', '76d7afe4775c8daa04288444289d3865e8e78afd914d259f4f2118c599411333', {
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
  gapBecause(
    'queue:infra/queues.ts:liveOpsTriageQueue',
    'd91c007aa45bb18a7da975b5f9555df2bc73ebcc3eca39b258fe26ee3fc696d2',
    'The admin live-ops trigger route enqueues here and no self-host consumer drains it. The hosted handler uses the CloudWatch client, so wiring needs a local metrics decision first.',
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  broker(
    'queue:infra/queues.ts:liveOpsTriageQueueDLQ',
    '396277d7176e9e4839b55c3f4f43ba8107c46a9262e8cfa5859bff0b50bba37b'
  ),
  wired(
    'queue:infra/queues.ts:notebookCurationQueue',
    '00962b583c879f1b66672f336702870770812a7ccd1aef5ec79932529d02e11c',
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
    '8ec6d78db33072b1c167a6bade35f2f169a64ae64d7b335e62652a37ab8f6992',
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
  wired(
    'queue:infra/queues.ts:questExportQueue',
    'fcade3ba3497611b1ed891bb4f3afd618d95b96846078962fcdc166cfca34a5d',
    {
      source: 'apps/workers/src/selfhost/questExportQueue.ts',
      symbol: 'registerQuestExportQueue',
      fingerprint: '3dddcce0b838668ed665ee39483b2082294bd14b98c70fddee91736b638147bd',
    },
    ['bedrock:InvokeModel']
  ),
  wired(
    'queue:infra/queues.ts:accountDataExportQueue',
    'e68d74fd6e11cf064f0e388e8b44cd096e16bf27a56d67a43d6774de7734731f',
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
  wired(
    'queue:infra/queues.ts:accountErasureQueue',
    'ac380d7ddb79b550f73c01f2ea62406c0971c8961fd79ad4b287ebaebc6695c8',
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
  wired(
    'queue:infra/queues.ts:researchEngineQueue',
    '5abfb477a03684981d995d7088c8e8b1c51f06b3d10f8c30f2bb5c1bbe08211b',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:researchEngineQueue',
      fingerprint: 'dd9dda9631c13f43ef069124c37f52e96ce8039f43f7e521e75bedc743330cab',
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
    '39410fdba252b1ee915d7775d7e667be6221fcfebaad0258f4512ceb0ae2f884',
    'Not registered. The admin security-dashboard ingest routes enqueue here; triage works on Prowler and AWS security findings that self-host does not produce.',
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  broker(
    'queue:infra/queues.ts:secopsTriageQueueDLQ',
    '5dae60c15cdbc4e123e5ffaafcfdfecbe658a3ac123be20c976beab0dd4f3c2a'
  ),
  gap('queue:infra/queues.ts:slackExportQueue', '88177f4b85d6e7d7b11b8ab96d7c58b135b35122d0b8a0ec08a1e5b06824966e'),
  broker(
    'queue:infra/queues.ts:slackExportQueueDLQ',
    'e6f709c7a77ad92a6420578b8802c7199d3580045da4a245ec379dca2b2f2a84'
  ),
  gapBecause(
    'queue:infra/queues.ts:sreFixQueue',
    '8105f1b3043f3f0d5c48cb53a593c61a5d9539176905f4e1e256248b8c4ddfbd',
    'Reached from the SRE Slack approval path and, on hosted, an EventBridge rule. Part of the SRE pipeline with sreJobQueue, which self-host does not run; decide the two together.'
  ),
  broker('queue:infra/queues.ts:sreFixQueueDLQ', '209afa13455584e3d213f4664f8bb372f97c4047b441a13c140c10a2d3b9950c'),
  gapBecause(
    'queue:infra/queues.ts:sreJobQueue',
    '0ffc1da5c9159cdc60c036e0e8cb0a7d490fff538c68fa7aa4fb6009e9b90e8a',
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
    'c98623ce70559d3364f761f889ecc81077e07ac52f3219c01d1ee1eab3911050',
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
  gapBecause(
    'queue:infra/queues.ts:whatsNewHighlightsQueue',
    '4b33ee03bb5d034852e26a4c3e9c7c78a09d5a4d76cdf807829e4fdc2fc33384',
    'Not registered. Legacy highlights queue retained to drain hosted in-flight messages; the admin route now produces to whatsNewGenerationQueue.',
    [
      'bedrock:InvokeModel',
      'bedrock:InvokeModelWithResponseStream',
      'cloudwatch:PutMetricData',
      'import:@aws-sdk/client-cloudwatch',
    ]
  ),
  broker(
    'queue:infra/queues.ts:whatsNewHighlightsQueueDLQ',
    '132ea676c87ab70c72d8f1f1e6fa195c3f0ecac4af6383acd0ea59e22c4427fc'
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
    '6b4dee3c8d196df99d5167e3b8e68c215c9cd5ec5a1d2b482027edb7ab444870'
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
    '91f216c1167faa53a3a3f263bada6004ec296646cddba8eac0a90869d53c1b5b'
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
    '75ebb60c42949289eaa820ed09809f498c8859e5b8b0f7035e463913926d561d',
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
  wired('schedule:infra/cron.ts:creditLotSweep', '859ff980e5e0d9edf1462ba291a3339fa44cfca5590cb2bdd18d01f2bcdbeedd', {
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
    '706dfa0607f18134ffa39ab86fb730bff74b6dbf6d90abb0cc430b9d02ef50cc',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'schedule:dataLakeBatchReconcile',
      fingerprint: '4f51563dc2cd044a40ed26ffd2849a7f87d4053d48893d4322f9c246385dce61',
    },
    ['cloudwatch:PutMetricData']
  ),
  wired(
    'schedule:infra/cron.ts:dataLakeResearchScheduleCron',
    'efd5553c06745990f5b45129ea61538c9cf20bd35a1850bb2345a154f931d5d3',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'schedule:dataLakeResearchSchedule',
      fingerprint: 'de332556e030877d1fc88ee545c46f6e934e5c6d2aa59a11966ffa28d848cfa0',
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
  hostedOnly(
    'schedule:infra/cron.ts:liveopsTriageDispatcherCron',
    'cfb18bf1e22bd2165c628676842996f8c0c41d134814fef9cd3abaedb3ecc6a6',
    'Hosted error triage and auto-fix dispatch; not applicable to a portable deployment.',
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  wired(
    'schedule:infra/cron.ts:modelDiscoveryCron',
    '7f2b05bafc0342ba49618e79c8141efeb1def7b2ef88a4c2a76fbcc1f7b16fb8',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'schedule:modelDiscovery',
      fingerprint: '92d3e4ef8e855b4dbfc8f78d41e38183ef16974ff55d7da28d9eff0174531bae',
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
    'f9125f32b52a6ffb55b719c473439e3b4746edeef5f6fb26f774ab78fa496340',
    'Publishes provider-reported spend to hosted CloudWatch alarms on monitored stages; no local metric or alarm destination is configured.',
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
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
  wired('schedule:infra/cron.ts:scheduleTaskCron', '30855e2010b3cdb26a07364b2b7df1d2e2338ba65fba3981b2ea2951213e855c', {
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
    '61025c6700b007379156ef0b8fdfc06ca05bb1b10aa774948e8ff410ca9f7975',
    {
      source: 'apps/workers/src/selfhost/spendReconciliation.ts',
      symbol: 'registerSpendReconciliation',
      fingerprint: 'ca9cbea76249daab2f0359e7faecad3f4dcd80c3269a0481a74e9a69a41a6d8b',
    }
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
    'fc238dab90c68e25fefacf618a2f11bd489455fbb3955154e1243e487179c07a',
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
    '0fdfbcaf8af6ffe9c4e387cf32b5e6e8ea3ab73a8c4a5e24f84e5150bfa6a80e',
    'Hosted production abuse alert to Slack; not applicable to a portable deployment.',
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
  wired(
    'schedule:infra/cron.ts:accountDeletionSweep',
    '055111c892156bfadeb720f0e77946ffb31b0335b77f7fdd1687f177750bf0b0',
    {
      source: 'apps/workers/src/selfhost/accountDeletionSweep.ts',
      symbol: 'registerAccountDeletionSweep',
      fingerprint: 'd47912b4a94290136beeaa4844ae281be958dd0985d89d5eb766e6cae67971e6',
    }
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
    'ea8660b95977904b15a42e29c55cf99aa096ca8bb712e5c49606ecc007f57c34'
  ),
  gap('schedule:infra/cron.ts:usagePatternSignals', '066edef1ae0b959ca2c6049626beb3c8630d5c22f99aed2b3bca1430f1f05766'),
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
    '7f82c9a6daf1298781ec962e6a7ecff9022aa54eaf8c2b4d02c82cdc40d12ab7',
    ['bedrock:*', 'cloudwatch:PutMetricData', 'events:PutEvents', 'execute-api:ManageConnections']
  ),
  gap('service:infra/searxng.ts:Searxng', 'fef5f4ce5e094d32525bb4a13828a34b67ba75a38ab72c70e526ba908c31f049'),
  gap(
    'service:infra/subscriberFanout.ts:subscriberFanoutV2',
    'f22fd878b4415013dafdb60fd0699f5d6c10695f02eccb2450ff66d0388323d6'
  ),
  gap(
    'sesRule:infra/emailIngestion.ts:emailReceiptRule',
    '05b3592ffe98bceb32dc139bdfd95f5ecde2d2f3d5b1f8eca9b51e78c28c68dd'
  ),
  gap(
    'snsSubscription:infra/dlqAlarms.ts:DlqAlarmTopic',
    '6c8fc55925aee2dfb1f39b562506076ed133950a26786b0bc1036ac9410acfa3',
    ['ssm:GetParameter']
  ),
  gap(
    'snsSubscription:infra/dlqAlarms.ts:OobAlarmTopicEmailSub',
    '74a62b4123aa86855c94deee69bae3c79722c4f170f78ff0b06e2a45c43d6644'
  ),
  gap(
    'snsSubscription:infra/serviceHealthAlarms.ts:ServiceHealthAlarmTopic',
    'b9684de008b3f96066f602e384ac8ca09caa3e766eec7e143d645e0581223a02',
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
