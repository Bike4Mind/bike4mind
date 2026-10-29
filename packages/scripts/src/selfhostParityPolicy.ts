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
  hostedOnly(
    'eventRule:infra/accountCreationAlarms.ts:AccountCreationMetricsSchedule',
    '9ecd499546afefc96b5204f91ccaa0292f7eaf73bce58d0bf91a30adda3497e7',
    'Hosted CloudWatch account census on monitored stages; no local notification destination is configured.',
    ['cloudwatch:PutMetricData', 'cloudwatch:namespace', 'import:@aws-sdk/client-cloudwatch']
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
  gap('event:infra/eventBus.ts:email-send', '3e4a74324ec602608487f3d9f877681aebdf77d584cf02c00a89e2e759aa7d96'),
  gap(
    'event:infra/eventBus.ts:notebook-curation-complete-analytics',
    'cb7bc46a17716134f82299540bcff81030e1d4ef64e17f7a924d154f5d28c44a'
  ),
  wired(
    'event:infra/eventBus.ts:notebook-curation-start',
    'a7a6d05f417d3ec58af962d3a89d516cb7c08066c4cf526e9b2df1e43a256b55',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:notebook.curation.start',
      fingerprint: 'd663ba075abfda9ac7d23d199b524d788380ffa8f915da8ba18b76501b20f57a',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:session-auto-name',
    '139d3542ed0548541525d9fddaf3407f5da22a6828861b0443b61d5b4e594e9c',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:session.auto_name',
      fingerprint: '1c744f91e1ce4f1765bf04aa91c12ab6fa099bcb2b77c4d31d23367c9649ec89',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:session-context-summarize',
    '2144e217cbfc1bee2e633628e68c2abee7360f7ed57f4baa7b7acbe6d8c52969',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:session.context_summarize',
      fingerprint: '8c0471c08765553599360b35043bdb754706e94de04888debe86819074b8f1aa',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:session-summarize',
    'ca7a6ae80ad259481038c593fe8f857da950bcf0017dd6ef18ded07b7175beb6',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:session.summarize',
      fingerprint: '8e17e080302a8214d65343e9a9de1c1ca9233dc5a74a5de4f39038762122a589',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:session-tag',
    'c7e2b52271037285003279603ab3667e158fb2bf73c449f58023f92c08205a27',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:session.tag',
      fingerprint: 'c929c56131db90fe534e9c2f3370c050a294b960953008a178f7ce06186ccb90',
    },
    ['bedrock:*']
  ),
  gap('event:infra/eventBus.ts:spider-start', '502698d74e524ca5d1d8b10915b384b63b9350a5a3512d20a2e44f3c0d9f2ab4', [
    'bedrock:*',
  ]),
  gap('event:infra/eventBus.ts:SreFixDispatch', 'fa1122e45e2de82ee4a61c73ce860a679f2f5ce735bc628dd56a35c82977a648'),
  gap(
    'event:infra/eventBus.ts:stripe-customer-subscription-updated',
    '4c4fc4ab9c35065deecb949f1fac91f03147e83a2d0e4d69d325a4cffbb41c35',
    ['cloudwatch:PutMetricData']
  ),
  gap(
    'event:infra/eventBus.ts:stripe-invoice-payment-succeeded',
    '9bd7d67d91b7ed92af560f2bec4a2dc3a3fe76a8f907f503c253cd82811d556e',
    ['cloudwatch:PutMetricData']
  ),
  gap('event:infra/eventBus.ts:telemetry-alert', 'da2a32170866774933b17511f32fa3be3347981ebc58cde3f749a7bed484afe7', [
    'bedrock:*',
  ]),
  wired(
    'event:infra/llm.ts:create-memento',
    '5b17c92749a15d48ede31049684581cea9f72aaa98f0c3e0892a67b281c0e84a',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:completion.completed',
      fingerprint: 'f3dbfd8d59e1d0554032f2a99b85c2d5c104a24312d88de9b96172070a99aea3',
    },
    ['bedrock:*']
  ),
  gap('event:infra/llm.ts:slack-completion-start', 'b77d1f7e9b8c57c03f19f7e5cb0e5963301d329d453acafe321c4f158d0f2fd9', [
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
    'c6a14f07ef855138ab12c6c1970bf1ce56f0746a8c9adcbf0a896bafd9488cd2',
    ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'cloudwatch:PutMetricData', 'events:PutEvents']
  ),
  gap('function:infra/database.ts:DatabaseCleaner', 'e52f8c2f59b621e25176f06917724c82cd678c213de7325e2d9ad064c2971b70'),
  gap(
    'function:infra/database.ts:DatabaseMigrator',
    '31efb996c43c4082992ee76db1b39699772b7c4cd3b2df12e0c7d78c030e2d80'
  ),
  gap('function:infra/database.ts:DatabaseSeeder', 'b91b816baa251d6be222c010e9971215368b7bce7970647fa3d573a33aa07e33', [
    'ssm:GetParameter',
  ]),
  gap('function:infra/dataSyncer.ts:DataSyncer', '6b34c84dc682604d934700c4c8156e0127c4779ea369a3de7a3d02649fae6b9b'),
  gap(
    'function:infra/imageProcessor.ts:ImageProcessor',
    '6acb07ce9209d186c6446e5c91d9bdce2c79c2870a86e13cf0c4d28fe5d30b0a'
  ),
  gap('function:infra/mcp.ts:mcpHandler', '6823c55927c3c438006ff24b5388c4ac716c126bef6b90f1504045c83b5295f7'),
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
    '3f2d696484f12406f1a9b8f00013633eddd1491d55f1d58b30e3f9be5cb7fb5f'
  ),
  gap(
    'notification:infra/buckets.ts:historyImportBucket.notebookImportCompleted',
    '46d767b8487b14ea887f667f3b393c3a465b3dcedf585542bb931b5d75402588'
  ),
  gap(
    'notification:infra/buckets.ts:historyImportBucket.uploadComplete',
    '6cf759ba3cf36c008ce65f7007e12ca65950208f8c7c77fbe92ba5041425ebd2'
  ),
  gap(
    'notification:infra/emailIngestion.ts:emailIngestionBucket.emailReceived',
    '312fd4c0cde9c76be43efba5d0649ec3b8e1be04f5fc2e5484fa0ec6082bca03'
  ),
  gap(
    'notification:infra/queues.ts:fabFileBucket.uploadComplete',
    'f6a0b68fab5cfc642d2de5b7c4daaa49d2927333968c650c3b1af4f0584d456f'
  ),
  broker(
    'queue:infra/dlqAlarms.ts:DlqAlarmHandlerDlq',
    'a39800cfa48e2ecb2ab17d226bb6fde51c9222a75c61f822abe291e9692d938e'
  ),
  gap(
    'queue:infra/emailIngestion.ts:emailAnalysisQueue',
    'be7217e0e5579a751bc81aa5108d1d74ca0c62d31ee580076eeb8aa445296a64',
    ['bedrock:InvokeModel']
  ),
  broker(
    'queue:infra/emailIngestion.ts:emailAnalysisQueueDLQ',
    '3293f56dff623e68c9514a4305754db7930dabcab9adbc52eb71e63ccecc7c7b'
  ),
  gap(
    'queue:infra/emailIngestion.ts:emailIngestionQueue',
    '7b7c3c3d44c1d0fb097fb10c57e5aadfe970e8d3d02f1246d9930357dad4fd3f',
    ['bedrock:*']
  ),
  broker(
    'queue:infra/emailIngestion.ts:emailIngestionQueueDLQ',
    'f44858b26f2ee8f4fb254d41d172e76694252114fb45ab805e510e34c3897f1a'
  ),
  gap(
    'queue:infra/emailMarketing.ts:emailBatchQueue',
    '3d8d2085327f0b58158c1cd663e1c3a9481ad4f9d2230e117eb4f87cbc3c1b13'
  ),
  broker(
    'queue:infra/emailMarketing.ts:emailBatchQueueDLQ',
    'ff7a3dc9d711600848964bb4825fac5af480800f91d5018d6e02b08064a17d73'
  ),
  gap(
    'queue:infra/emailMarketing.ts:emailJobQueue',
    'a12494303f6f19ebd909f57060c2fa52ad7b0f6b9867cf8f495c72990f7f296c'
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
  broker(
    'queue:infra/loopSchedulerDeadLetter.ts:loopSchedulerDlq',
    '5b85259ddd18160448733c9a2bd2ef7c29d0e10e07bf4e7f251839b86ff91994'
  ),
  gap(
    'queue:infra/queues.ts:agentContinuationQueue',
    'cbcae199c1ef49338db41aab63f0419c50c681f8d3e31e0ad69bf21e7b711d18',
    ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'cloudwatch:PutMetricData', 'events:PutEvents']
  ),
  broker(
    'queue:infra/queues.ts:agentContinuationQueueDLQ',
    '6a36ae54a4e5ea35b9c34a06d407cee8281bcd6284eeeecf35d7c530dd0c6ffb'
  ),
  gap(
    'queue:infra/queues.ts:agentProactiveMessageQueue',
    '3f5dec679a326d5dd3cc12bfed1a94c51bed95f53e9db4abf6beecad50b13766',
    ['bedrock:*', 'cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:agentProactiveMessageQueueDLQ',
    '1990fa893bed28bef2523e156f10d9e0a787552590a76489415b59814359c2a9'
  ),
  gap('queue:infra/queues.ts:bobRunQueue', '70c0dfc95c5e790acd6fb03c457b43189942120d69bd9e39ff5345d315c4803b', [
    'cloudwatch:PutMetricData',
    'execute-api:ManageConnections',
  ]),
  broker('queue:infra/queues.ts:bobRunQueueDLQ', '992ea82e88afb9edee954915d02a11a851268dc0059930f226609026a42b34aa'),
  wired(
    'queue:infra/queues.ts:dataLakeCleanupQueue',
    '7f24faf4b7e554813956c07a31f4c84c21ed471e75243bcc241d53f668225451',
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
    '731536174082da500869942ee0e77bafc8d1935d3662362fb4c6b5789c32908d',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:dataLakeResearchQueue',
      fingerprint: 'd64dcdbad08ccb446313f3d229a706fcb2eee33dfe567692e8089e6feb66e04a',
    }
  ),
  broker(
    'queue:infra/queues.ts:dataLakeResearchQueueDLQ',
    '282597bb81f72e340915441f8a2556c94f86bc43be0eb76db1f625d2d052a5ec'
  ),
  wired(
    'queue:infra/queues.ts:dataLakeTaxonomyQueue',
    '17e826329364ed70287a4b6eaa47a710516054d15fa7ce699e63ef4895827994',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:dataLakeTaxonomyQueue',
      fingerprint: 'd3f1de6aab3e4bae5f77914e7409dca44b7ffa70e65caff1995cb486ea939e32',
    }
  ),
  broker(
    'queue:infra/queues.ts:dataLakeTaxonomyQueueDLQ',
    '09d613eb6bffdc733600b1b2dbb9a68496671babcfb7a2b8769c84b5d65d9bbd'
  ),
  gap('queue:infra/queues.ts:deepAgentWakeQueue', '7fabc060e567ba3872895852fdecd1c0a371fa8cfbfa14966a1fd89e0dd57ad1', [
    'bedrock:InvokeModel',
    'cloudwatch:PutMetricData',
  ]),
  broker(
    'queue:infra/queues.ts:deepAgentWakeQueueDLQ',
    '2daf534b0ed080ebdbaf3f323032db39f5ab06e345ebc0df5a73babd0f8c1bb8'
  ),
  wired(
    'queue:infra/queues.ts:driveDisconnectPurgeQueue',
    '0ee63d912df3561c0e6f8485301be724e36fab786dde57256f61d084ab2e1947',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:driveDisconnectPurgeQueue',
      fingerprint: '1aaeae5d44ce51e16ef4ac0054fca0697332cbf908a53ef449a01c38917c2a5b',
    }
  ),
  broker(
    'queue:infra/queues.ts:driveDisconnectPurgeQueueDLQ',
    'd72d0b74a0ba0a11eb344d09ea5e3a85f5d0ae99bb78d541f24e07b2bf1615c5'
  ),
  wired(
    'queue:infra/queues.ts:driveLakeIngestQueue',
    '878df072cc87724820e081d4a48bf39995414e58c95556e4de2bb66e06cc58f6',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:driveLakeIngestQueue',
      fingerprint: 'f5c20875b467be602128f3ce2a49bc21358704bba96e817982593099828c6eb7',
    }
  ),
  broker(
    'queue:infra/queues.ts:driveLakeIngestQueueDLQ',
    '936a38165a1530a6e2300096213886ea50250a8cc9d8f192e5877234d74ea18f'
  ),
  wired(
    'queue:infra/queues.ts:fabFileChunkQueue',
    '4287a9d45ee74e75d9c447f7b07ce86a9f78d993f47d435ce589c13fc3c954b0',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:fabFileChunkQueue',
      fingerprint: 'd2608c3e5ba0380c965f152421aeafe2a7a796876ee868af0f08faac1a85bd0d',
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
    'a8b00ba8d0ad0e42c470f733cf4329be38cc543fa6619e0077b3c0e12a8c9b3b',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:fabFileVectorizeQueue',
      fingerprint: '8eb42a9aba10dbcfea7f82586f3c43e638ec3ac4139543088389304e841eb85d',
    },
    ['bedrock:InvokeModel', 'cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:fabFileVectorizeQueueDLQ',
    '2e3862991aa93a6c5edc3d625cb53fdf125b408f1b85d204208d5d5531b04195'
  ),
  wired(
    'queue:infra/queues.ts:generationCallbackQueue',
    '988869c4a4e50257de25653281d75e0cbec3a51b93baa4960ef577b7ce291773',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:generationCallbackQueue',
      fingerprint: '5bb778a779ab2f8a2af38fd359319ca46671e1f032f6c1a24c3a7f206b1849fc',
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
    '77d257af6ce49d148226e2905975e4d521c61454e28700fe3813e608573eb440',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:generationJobQueue',
      fingerprint: 'b65db4e96d9c72e899820c7cffa81d09f84e7ddab3e8fc0c1f0185097babb691',
    }
  ),
  wired(
    'queue:infra/queues.ts:githubLakeIngestQueue',
    '62e97f50560a1c78564d754f93ccf53247233e127d4724297a3182f490010ac2',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:githubLakeIngestQueue',
      fingerprint: 'dfb37472824f4f0f713a90b5042478a9812a0b50100247e62bbec8c2d6f2eb12',
    }
  ),
  broker(
    'queue:infra/queues.ts:githubLakeIngestQueueDLQ',
    '85d47c076cbe0cbf6f649423831607793f7c8e014bb946603b1252de412abf4c'
  ),
  wired(
    'queue:infra/queues.ts:githubLakeRevokeQueue',
    '52bcf6007148c5ee4e8c4911fbc600dda7a97da5d1dc45cc48305f1aa4bb901c',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:githubLakeRevokeQueue',
      fingerprint: '3a7d0ae48c84dcd949effc310d0221743a793c34471d6eb2de7e098007ba37f5',
    }
  ),
  broker(
    'queue:infra/queues.ts:githubLakeRevokeQueueDLQ',
    '4491856037e8f9226cdeb137466706aa7bc84abb90e191d01aef7f42424825d1'
  ),
  gap('queue:infra/queues.ts:githubWebhookQueue', '912af3d9c7f8cb4a5cdafcd410c4db8789167b19815b534c6eb0cebd2f7d13f3', [
    'import:@aws-sdk/client-cloudwatch',
  ]),
  broker(
    'queue:infra/queues.ts:githubWebhookQueueDLQ',
    'a2822aee5a83e5452e0217169125d1a7788fe9a5f4c78dada41fb6e4aa412fb9'
  ),
  broker('queue:infra/queues.ts:imageEditDLQ', '10c1a0580567d9b39e1c9547b6edccdbf9e9e6a71ea74c050e73f8da63190074'),
  wired(
    'queue:infra/queues.ts:imageEditQueue',
    '93e9f204fbca1243e14c928c84d8f42e1e9ab4e97e80ec4ca0d93518e18e1065',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:imageEditQueue',
      fingerprint: '9be530e8f36ea86917a5114a35db20759fcc9665a9c174ceda8e3b237261c675',
    },
    ['bedrock:*']
  ),
  broker(
    'queue:infra/queues.ts:imageGenerationDLQ',
    'e5555dbe58ec90c0fe40c11b46fab25d491c21b2e0e4db14a8bd75bb24684051'
  ),
  wired(
    'queue:infra/queues.ts:imageGenerationQueue',
    'd8aa9592d96f49fdbd6ae9d96149dacd1c323e484257fed373f4382e4f079d97',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:imageGenerationQueue',
      fingerprint: 'fe9ba691dbe7872fa28e8d152b0d2a479245aa690102623bc3a596bbda1f23cb',
    },
    ['bedrock:*']
  ),
  gap(
    'queue:infra/queues.ts:lakeInconsistencyModelQueue',
    '96472053d974d831a53b57c6bf25016e2ca4fbb2949e6f331cc0af0beceff337'
  ),
  broker(
    'queue:infra/queues.ts:lakeInconsistencyModelQueueDLQ',
    'cd3631e1e06de7bbf8bef82bac2e6c518b0f9a2cedd0881211fad77de5b969f7'
  ),
  wired('queue:infra/queues.ts:lakeMemoryQueue', '567cc5deb549759a75929bd867e842837de1145fa2a509bf15da42b62fd38765', {
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
    '09e4fe5c011e27e8cbccc3e9c673626c56f14c546e25d8e768131f9e0a4ff4bc'
  ),
  broker(
    'queue:infra/queues.ts:libreoncologyAudioRenderQueueDLQ',
    '2ee2385d94d02b314ad0029cadb2c26a937f5a674ff43eb5a82816c228b00b6c'
  ),
  gap('queue:infra/queues.ts:liveOpsTriageQueue', '10f7067691b764999174d0040001fef91b6db622855893dfcbad5cfb803a9ba7', [
    'cloudwatch:PutMetricData',
    'import:@aws-sdk/client-cloudwatch',
  ]),
  broker(
    'queue:infra/queues.ts:liveOpsTriageQueueDLQ',
    '396277d7176e9e4839b55c3f4f43ba8107c46a9262e8cfa5859bff0b50bba37b'
  ),
  wired(
    'queue:infra/queues.ts:notebookCurationQueue',
    '1c6e42ddadf6d177bf67946a677e066f6f9e50034b58428045eba794f9c0cf5a',
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
    '41d9ad7538ab085985adb4b177acc83302f650c81b69121e5f419e81160423a7',
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
    '11536328c521ab1f24a8c2f9c9cca321fa9fc9c7e6647182fc613d72d4d84df3',
    ['cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:overwatchAnalyticsQueueDLQ',
    '48d2eb528668fa78a4afbc6df9740bd92ac527dc969f20966da54ac373072e04'
  ),
  hostedOnly(
    'queue:infra/queues.ts:publishThumbnailQueue',
    '8f298587c27293216beb642a82ea5d2fbbb117cfead26091d6588c5cc1f90d31',
    'Owner-only publish thumbnails render in a Lambda-packaged headless Chromium; the self-host worker image ships no browser, so publish skips the enqueue and cards keep their generated cover.',
    ['lambda:InvokeFunction']
  ),
  broker(
    'queue:infra/queues.ts:publishThumbnailQueueDLQ',
    'a1b84e4b8d1c2da1390507f0e1bdd7a567c77e5390ede903ca583acdfdbe87d2'
  ),
  wired(
    'queue:infra/queues.ts:questExportQueue',
    'e984d4fc019c7df6402d41fe29ec4ab286d6c46d444a053e8a12eed92485b7fa',
    {
      source: 'apps/workers/src/selfhost/questExportQueue.ts',
      symbol: 'registerQuestExportQueue',
      fingerprint: '3dddcce0b838668ed665ee39483b2082294bd14b98c70fddee91736b638147bd',
    },
    ['bedrock:InvokeModel']
  ),
  broker(
    'queue:infra/queues.ts:questExportQueueDLQ',
    '25de3f067cc3dbb3aa93798220af65df41849f0baad7ef6cd008e56706335966'
  ),
  wired(
    'queue:infra/queues.ts:researchEngineQueue',
    'e39a82d9527fdca3f0f53d7c71065ddbcd37ed04e6cddf7bd8f0d7763ada587b',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:researchEngineQueue',
      fingerprint: 'b1fbce0bdd1e3b2dba4e1897adf34ee6b8cdfab75738ae595dbdc38986d0835d',
    },
    ['bedrock:*']
  ),
  broker(
    'queue:infra/queues.ts:researchEngineQueueDLQ',
    'fc9787d34e6471af94a399dd6b53d266f1dd1d037fb591d7731ef8edec35d78d'
  ),
  gap('queue:infra/queues.ts:secopsTriageQueue', 'a1112e855d9bd5bbfd10645e4c5e3c6635c31f3b740b640b198026333aa66863', [
    'cloudwatch:PutMetricData',
    'import:@aws-sdk/client-cloudwatch',
  ]),
  broker(
    'queue:infra/queues.ts:secopsTriageQueueDLQ',
    '5dae60c15cdbc4e123e5ffaafcfdfecbe658a3ac123be20c976beab0dd4f3c2a'
  ),
  gap('queue:infra/queues.ts:slackExportQueue', '63f3c03eccc15300651ebcb6f79497b3e5b0e3c4e906510d5c679d78529adf13'),
  broker(
    'queue:infra/queues.ts:slackExportQueueDLQ',
    'e6f709c7a77ad92a6420578b8802c7199d3580045da4a245ec379dca2b2f2a84'
  ),
  gap('queue:infra/queues.ts:sreFixQueue', '8105f1b3043f3f0d5c48cb53a593c61a5d9539176905f4e1e256248b8c4ddfbd'),
  broker('queue:infra/queues.ts:sreFixQueueDLQ', '209afa13455584e3d213f4664f8bb372f97c4047b441a13c140c10a2d3b9950c'),
  gap('queue:infra/queues.ts:sreJobQueue', '3d20154baf287fd6b05e5ebc5e574208837dab2089e7521cb48d6a7bdf804dee', [
    'bedrock:InvokeModel',
    'cloudwatch:PutMetricData',
  ]),
  broker('queue:infra/queues.ts:sreJobQueueDLQ', '37a9ace9b78c31a34324c565734ddad57f611e999c69c55b2052ed020cca1435'),
  gap('queue:infra/queues.ts:tavernHeartbeatQueue', '5ece4ce114a9900aeb8e5ce9f67c415d42d1623c8a3bdf99098e93ee613294f4'),
  broker(
    'queue:infra/queues.ts:tavernHeartbeatQueueDLQ',
    '3f2e2017042d9cc8ad66385424a377b2e04b2f1d137b3fcd2b229f1d277966b7'
  ),
  gap(
    'queue:infra/queues.ts:webhookDeliveryQueue',
    'def1706d75b2672b2e5cd7edfe51faa7acbf9f281776537f1468036cdb762768',
    ['cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:webhookDeliveryQueueDLQ',
    '489b16bdceaf15867423fcbfab9344b5e36cefcdbd6473c595f6604d440ad271'
  ),
  gap(
    'queue:infra/queues.ts:whatsNewGenerationQueue',
    '7df5242a93aeaf78aa95a16ddb7595d308df55e9ca19a3273809dac56b69b856',
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
  gap(
    'queue:infra/queues.ts:whatsNewHighlightsQueue',
    '606bf264dcf3693c1579a07bd828bc627684657e755851c8f289fb9798437011',
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
    'queue:infra/serviceHealthAlarms.ts:ServiceHealthAlarmHandlerDlq',
    '6b4dee3c8d196df99d5167e3b8e68c215c9cd5ec5a1d2b482027edb7ab444870'
  ),
  broker(
    'queue:infra/waf.ts:WafAlarmSlackHandlerDlq',
    '6066a79188816238482fa1a91f2da527bdd8017cdd3fb815fe2b4002ff234a93',
    ['ssm:GetParameter']
  ),
  broker(
    'queue:infra/youngAccountSpendAlertDeadLetter.ts:youngAccountSpendAlertDlq',
    '7c55bfdeaea409d972ba757cc5e3c8d50a5a0d1e8fd8629afab3473284bbbd6e'
  ),
  broker(
    'queue:infra/signupGrantHeldReleaseDeadLetter.ts:signupGrantHeldReleaseDlq',
    '1856afc8013710101dc260617d02b2feca7f30a05c0a2444f823a5e1ae6b21c8'
  ),
  wired('schedule:infra/cron.ts:adminAuditAlerts', 'affe75eb1ea58ec7de19131925c6c8907a82f258f187996331f5df4183eb3ab0', {
    source: 'apps/workers/src/selfhost/adminAuditAlerts.ts',
    symbol: 'registerAdminAuditAlerts',
    fingerprint: 'c3d09ab1645e180de73018af05a50b748c27dffcb699ccd1535be774c1359ab6',
  }),
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
  gap(
    'schedule:infra/cron.ts:creditPurchaseReconciliation',
    '8455f96cc2ce815f18eab081597232ffd8b01ab372d4c04fa6a8d19fcbe3aef3',
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  hostedOnly(
    'schedule:infra/cron.ts:dailyUserActivityReport',
    'c8a18208501187549670f14edb67aea76c2c5dced73c8595ffc5749407c7c0b0',
    'Hosted production analytics report; not applicable to a portable deployment.'
  ),
  wired(
    'schedule:infra/cron.ts:dataLakeBatchReconcile',
    '1707c3369d89db332fd58cacc3e09db447b3d1c8326c2466ccff33c9021ba522',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'schedule:dataLakeBatchReconcile',
      fingerprint: 'b9ca12d71c27931bf01ed89732e928066d9379d08e45f9c129b8b77cff846cad',
    },
    ['cloudwatch:PutMetricData']
  ),
  wired(
    'schedule:infra/cron.ts:dataLakeResearchScheduleCron',
    'efd5553c06745990f5b45129ea61538c9cf20bd35a1850bb2345a154f931d5d3',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'schedule:dataLakeResearchSchedule',
      fingerprint: 'a9124f5b2abce50fe53bbfc175d396323f2ae996b8d3fae7bb7713ce1b5067a3',
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
  gap('schedule:infra/cron.ts:helpDatalakeIngest', '730ccd34ff9f62c9a9d40425c834c4a409a0710624664f18d2b27e97faac0a7e', [
    'bedrock:InvokeModel',
  ]),
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
  gap('schedule:infra/cron.ts:loopSchedulerCron', '9af087dbb217b9b00921e57b2e7fd5c5dd61e320e2c62297bcbb58890cbe6743', [
    'lambda:InvokeFunction',
  ]),
  wired(
    'schedule:infra/cron.ts:modelDiscoveryCron',
    '7f2b05bafc0342ba49618e79c8141efeb1def7b2ef88a4c2a76fbcc1f7b16fb8',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'schedule:modelDiscovery',
      fingerprint: '256024da35799c777a98d55573c7c0e46775654292474217de5e0f32e590312c',
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
  gap(
    'schedule:infra/cron.ts:modelDiscoveryStalenessCron',
    'f906894c42c72f63c47bff4cd0214d9803e241702098291f3a30a67204b0da99',
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
    '38ae278158647137f13eef04fc530fe3b8b6076ba2084ec48523d4282f5a3774',
    {
      source: 'apps/workers/src/selfhost/realtimeConnectionSweep.ts',
      symbol: 'registerRealtimeConnectionSweep',
      fingerprint: '786cca0d3f334531b90d437cb49f4e4335b24989be24bfead1845eda9fb0e380',
    },
    ['execute-api:ManageConnections']
  ),
  wired('schedule:infra/cron.ts:scheduleTaskCron', 'f74b7fd7eda3fce0d1fd6da03668b66d356fe51e5ce228d02e81d2a13316adb7', {
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
  wired(
    'schedule:infra/cron.ts:skillMarketReviewSla',
    '697ac5832f8ddde3e173f89d1b8dde98f233da8187f3babf59abe26f215867c9',
    {
      source: 'apps/workers/src/selfhost/skillMarketReviewSla.ts',
      symbol: 'registerSkillMarketReviewSla',
      fingerprint: '9f57dd7788c58e8c80541ed80e9def95959a8ab62567866fe35d4c9ca6b98ec9',
    }
  ),
  gap('schedule:infra/cron.ts:spendReconciliation', '61025c6700b007379156ef0b8fdfc06ca05bb1b10aa774948e8ff410ca9f7975'),
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
    'schedule:infra/cron.ts:youngAccountSpendAlert',
    '0f351e3081a732ae7ebcb35c048e4d5a5031666986942fbba872f472c6fa7ad2',
    'Hosted production abuse alert to Slack; not applicable to a portable deployment.'
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
  wired(
    'schedule:infra/cron.ts:signupIpRetention',
    'b90d6f8f8b7bdc5640a0de6c90b64dcdc176e9170da8d595b5aa6a52328cb312',
    {
      source: 'apps/workers/src/selfhost/signupIpRetention.ts',
      symbol: 'registerSignupIpRetention',
      fingerprint: '0c313edef4ce27ecfa5a27f06f3eb3765dd6b22efd7cbe2d17278623b20deef4',
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
    '65f26f577c13203463e31692dd274aff85c4dcfdca6c822b954b5ee6d6e41e11',
    ['bedrock:*', 'cloudwatch:PutMetricData', 'events:PutEvents', 'execute-api:ManageConnections']
  ),
  gap('service:infra/searxng.ts:Searxng', '16fc0b23bc4d075e5c4e98cbb502ff6dfc37aac7fbf9bd4f7429cd4202b2f370'),
  gap(
    'service:infra/subscriberFanout.ts:subscriberFanoutV2',
    '63d9a5eab65de1a95f5fd1514ae9c91da593ef6ee35b364ba0918b98dfb54e50'
  ),
  gap(
    'sesRule:infra/emailIngestion.ts:emailReceiptRule',
    '149ae3de5b22c02958053d3325afe648873ca141260f64d4b5b46168534b2f42'
  ),
  gap(
    'snsSubscription:infra/dlqAlarms.ts:DlqAlarmTopic',
    '368f2fda89a530ff780c20f48f90b0b10fbbc8a1a05a195f9cc195b61804e9df',
    ['ssm:GetParameter']
  ),
  gap(
    'snsSubscription:infra/dlqAlarms.ts:OobAlarmTopicEmailSub',
    '7c36bbf7168b43b7f3a0a8f1f51130a9961e41d3cc9badc61efa50b45edd586d'
  ),
  gap(
    'snsSubscription:infra/serviceHealthAlarms.ts:ServiceHealthAlarmTopic',
    'e049191c0ab4767b337b43790f36eb45df8e11dfb8fbf0043e8d5249583168e5',
    ['ssm:GetParameter']
  ),
  gap(
    'snsSubscription:infra/waf.ts:WafAlarmSlackHandlerSubscription',
    '49907efa33b805b563e7f36381353886fc10ddd1beb74721772e36c1d24e14a8',
    ['lambda:InvokeFunction', 'ssm:GetParameter']
  ),
  gap(
    'snsSubscription:infra/waf.ts:WafOobAlarmTopicEmailSub',
    'c39161f23c01b940505e3caa92cd7ef982273ad081f5d91b83756b93ad8279c6',
    ['ssm:GetParameter']
  ),
];
