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
const wired = (
  id: string,
  fingerprint: string,
  portable: NonNullable<ParityPolicyEntry['portable']>,
  signals: string[] = []
): ParityPolicyEntry => reviewed(id, fingerprint, 'portable', signals, portable);

// Reviewed snapshots, never automatically refreshed by CI. Portable means wiring only.
export const selfhostParityPolicy: readonly ParityPolicyEntry[] = [
  gap('event:infra/eventBus.ts:email-send', 'dc02074bef62eff726cebf1a226ea2788040941b8db0e3dec3e672a5b1fd347f'),
  gap(
    'event:infra/eventBus.ts:notebook-curation-complete-analytics',
    'f9919e513644fa6c9609ef01d57f90e51f3673b32a3b02c70a61bce2b1e960a4'
  ),
  wired(
    'event:infra/eventBus.ts:notebook-curation-start',
    'cab051f1d3bc732ab76434d7bade46b4376f5333f0ac097eaa5571bbed1118ac',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:notebook.curation.start',
      fingerprint: 'd663ba075abfda9ac7d23d199b524d788380ffa8f915da8ba18b76501b20f57a',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:session-auto-name',
    '3d2c328c2a6f007311411986fdc6a6ee6b5c5308caf6cac358b39d9b13b3929f',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:session.auto_name',
      fingerprint: '1c744f91e1ce4f1765bf04aa91c12ab6fa099bcb2b77c4d31d23367c9649ec89',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:session-context-summarize',
    'a8161a1b002dcd12a06fcdbfe10ee3d5140310650191ee4cdcfd81c7a4b255ca',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:session.context_summarize',
      fingerprint: '8c0471c08765553599360b35043bdb754706e94de04888debe86819074b8f1aa',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:session-summarize',
    '1a656a158853877359594a6685a0b5de9cba8c8136cf8983707382b0801fce52',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:session.summarize',
      fingerprint: '8e17e080302a8214d65343e9a9de1c1ca9233dc5a74a5de4f39038762122a589',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:session-tag',
    '94ced1c3e69d023eb0ed95cf3ed3320d381cf1814df773bd4daa3ab4ffda49ae',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:session.tag',
      fingerprint: 'c929c56131db90fe534e9c2f3370c050a294b960953008a178f7ce06186ccb90',
    },
    ['bedrock:*']
  ),
  gap('event:infra/eventBus.ts:spider-start', 'e98531ff4418a86b9df57341a45ee0b66d1f05c29a04b7e3619453faf2360136', [
    'bedrock:*',
  ]),
  gap('event:infra/eventBus.ts:SreFixDispatch', 'fa1122e45e2de82ee4a61c73ce860a679f2f5ce735bc628dd56a35c82977a648'),
  gap(
    'event:infra/eventBus.ts:stripe-customer-subscription-updated',
    '9323d25fdf383adea905680d672974564d4822f6ca0460835a48c2467546f876',
    ['cloudwatch:PutMetricData']
  ),
  gap(
    'event:infra/eventBus.ts:stripe-invoice-payment-succeeded',
    '316503ee48b058f3c6ee3ae0baf0484d05d8f14f04109919374f7d08fb5faffc',
    ['cloudwatch:PutMetricData']
  ),
  gap('event:infra/eventBus.ts:telemetry-alert', 'a84bb98b72fccf9647ea90dd53ccff2db7ca562a064dabdf4355e211990ffaa5', [
    'bedrock:*',
  ]),
  wired(
    'event:infra/llm.ts:create-memento',
    'fa32f692e2414afdd751b6900f04f08e71b6b31493dad8ef9a7f25cc970cd2a6',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:completion.completed',
      fingerprint: 'f3dbfd8d59e1d0554032f2a99b85c2d5c104a24312d88de9b96172070a99aea3',
    },
    ['bedrock:*']
  ),
  gap('event:infra/llm.ts:slack-completion-start', '2d9b45368699ac5b65d13f3c8d6bb7a7914d38886c24e421dc3f5b33eb8c938d', [
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
    'b94dc08d27d3bce5797f0acb45d739337840a32a8b859d1124f1d4ef07a3e2a8',
    ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'cloudwatch:PutMetricData', 'events:PutEvents']
  ),
  gap('function:infra/database.ts:DatabaseCleaner', 'e52f8c2f59b621e25176f06917724c82cd678c213de7325e2d9ad064c2971b70'),
  gap(
    'function:infra/database.ts:DatabaseMigrator',
    'ddc9d611ee11a49f55806b0dbbae33183546cbeb610550c0d228435fd7691db1'
  ),
  gap('function:infra/database.ts:DatabaseSeeder', 'd0de1f957fe2e02c32ff318f42aff91979650b67a0050264d2d9b9597869f9c8', [
    'ssm:GetParameter',
  ]),
  gap('function:infra/dataSyncer.ts:DataSyncer', '6b34c84dc682604d934700c4c8156e0127c4779ea369a3de7a3d02649fae6b9b'),
  gap(
    'function:infra/imageProcessor.ts:ImageProcessor',
    '7fd2b40ddb22e4265c76224cd77f1cef0bf20dff5af7cae37d3b81a3994c315a'
  ),
  gap('function:infra/mcp.ts:mcpHandler', 'e3bfed090995364d360c725c2215d1295cff7f6e64722943495293d1899b6334'),
  gap(
    'logSubscription:infra/logMonitor.ts:createLogSubscriptions()',
    '235e9ebbdccd1202b354d558a713998832b152cf9093cb995f23e12e2c091997',
    ['lambda:InvokeFunction']
  ),
  gap(
    'notification:infra/buckets.ts:appFilesBucket.uploadComplete',
    'e6911e53b6221ad9574148fb4eb4b3df625f7d1196d74c7ca0a90202c7b825fb'
  ),
  gap(
    'notification:infra/buckets.ts:historyImportBucket.notebookImportCompleted',
    'e0430fe0d505fc221ff49d6ca4b6558155c0d315053a5ac1c55e5a95cd977288'
  ),
  gap(
    'notification:infra/buckets.ts:historyImportBucket.uploadComplete',
    'cafb42f2be005c1fb985fdc35d09701ad622c349c1f709c956fe3e9c44dbcafe'
  ),
  gap(
    'notification:infra/emailIngestion.ts:emailIngestionBucket.emailReceived',
    '312fd4c0cde9c76be43efba5d0649ec3b8e1be04f5fc2e5484fa0ec6082bca03'
  ),
  gap(
    'notification:infra/queues.ts:fabFileBucket.uploadComplete',
    'e86b2e48c667f617cc1722d157f8e456c57cf82ca7ce543b1dbbe02cacb537db'
  ),
  broker(
    'queue:infra/dlqAlarms.ts:DlqAlarmHandlerDlq',
    'a39800cfa48e2ecb2ab17d226bb6fde51c9222a75c61f822abe291e9692d938e'
  ),
  gap(
    'queue:infra/emailIngestion.ts:emailAnalysisQueue',
    '6c62105a65f9ac4086f0c1e39897dfa3cdbfe0edd50f11015ec29cf46142963d',
    ['bedrock:InvokeModel']
  ),
  broker(
    'queue:infra/emailIngestion.ts:emailAnalysisQueueDLQ',
    '3293f56dff623e68c9514a4305754db7930dabcab9adbc52eb71e63ccecc7c7b'
  ),
  gap(
    'queue:infra/emailIngestion.ts:emailIngestionQueue',
    'fbd4b12a562c4f7010ad6f3d94b4ae9b13baf2e780d7c8b2a6f768ccd487924a',
    ['bedrock:*']
  ),
  broker(
    'queue:infra/emailIngestion.ts:emailIngestionQueueDLQ',
    'f44858b26f2ee8f4fb254d41d172e76694252114fb45ab805e510e34c3897f1a'
  ),
  gap(
    'queue:infra/emailMarketing.ts:emailBatchQueue',
    '5bcd555047666fb024bab6c014880add8acd0dfeb992b4202ec6925ad4a961b8'
  ),
  broker(
    'queue:infra/emailMarketing.ts:emailBatchQueueDLQ',
    'ff7a3dc9d711600848964bb4825fac5af480800f91d5018d6e02b08064a17d73'
  ),
  gap(
    'queue:infra/emailMarketing.ts:emailJobQueue',
    '648fa6cac293707c33df0637127074ca85826a4cdf7b90d56437c5e3a26f670b'
  ),
  broker(
    'queue:infra/emailMarketing.ts:emailJobQueueDLQ',
    '6d6a3df0afbdc622c4cac46865a7875da157e26a9f0d4295a491faf9ec1d2968'
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
    '0f9dcfd56792b7eac07ef87175752d433c208e8596559f3cf43493cbade1866c',
    ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'cloudwatch:PutMetricData', 'events:PutEvents']
  ),
  broker(
    'queue:infra/queues.ts:agentContinuationQueueDLQ',
    '6a36ae54a4e5ea35b9c34a06d407cee8281bcd6284eeeecf35d7c530dd0c6ffb'
  ),
  gap(
    'queue:infra/queues.ts:agentProactiveMessageQueue',
    '0b94b20489d09d3b025b60ea63731a98bba17cafbbaaf07a7641c91d2fa6fbec',
    ['bedrock:*', 'cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:agentProactiveMessageQueueDLQ',
    '1990fa893bed28bef2523e156f10d9e0a787552590a76489415b59814359c2a9'
  ),
  gap('queue:infra/queues.ts:bobRunQueue', '118171ae230701e80947605002d7bfa04f5dad654c2dc7ea30731e64d799f767', [
    'cloudwatch:PutMetricData',
    'execute-api:ManageConnections',
  ]),
  broker('queue:infra/queues.ts:bobRunQueueDLQ', '992ea82e88afb9edee954915d02a11a851268dc0059930f226609026a42b34aa'),
  wired(
    'queue:infra/queues.ts:dataLakeCleanupQueue',
    'cc6196e589d3a38e768150a53533070628984f5aebeda7e2404a941d95bce777',
    {
      source: 'apps/workers/src/selfhost/dataLakeCleanupQueue.ts',
      symbol: 'registerDataLakeCleanupQueue',
      fingerprint: '27369e6953717701cd816491064c131057246c91d5dffb3b870d31bd3a92e9e9',
    }
  ),
  broker(
    'queue:infra/queues.ts:dataLakeCleanupQueueDLQ',
    '501479ddcbfc73c175688c2151a627de14d2e3b900234a9c74d299f1fc75b7f2'
  ),
  wired(
    'queue:infra/queues.ts:dataLakeResearchQueue',
    'f1285e4b4696ab261bf776cdebc2423fd4c6d152be1727f5e8733b2673f45d1e',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:dataLakeResearchQueue',
      fingerprint: 'e7a07c37676856c7721762cb4edddad626ed22a46a7f6fafd0baa4e3103d35ee',
    }
  ),
  broker(
    'queue:infra/queues.ts:dataLakeResearchQueueDLQ',
    '282597bb81f72e340915441f8a2556c94f86bc43be0eb76db1f625d2d052a5ec'
  ),
  wired(
    'queue:infra/queues.ts:dataLakeTaxonomyQueue',
    '0dfae2cc4151bc331069aac84670e2922cb007457b377d22e4cbdcf1cf80c047',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:dataLakeTaxonomyQueue',
      fingerprint: '87097fd12f334031797d3b01875430c292e235cbfd112cfbed70b190a0f2a31a',
    }
  ),
  broker(
    'queue:infra/queues.ts:dataLakeTaxonomyQueueDLQ',
    '09d613eb6bffdc733600b1b2dbb9a68496671babcfb7a2b8769c84b5d65d9bbd'
  ),
  gap('queue:infra/queues.ts:deepAgentWakeQueue', 'ad7960fb51a1a1a1adaea99a351dfd9e8750c8dbacf62b597a34aa64300dbaec', [
    'bedrock:InvokeModel',
    'cloudwatch:PutMetricData',
  ]),
  broker(
    'queue:infra/queues.ts:deepAgentWakeQueueDLQ',
    '2daf534b0ed080ebdbaf3f323032db39f5ab06e345ebc0df5a73babd0f8c1bb8'
  ),
  wired(
    'queue:infra/queues.ts:driveDisconnectPurgeQueue',
    '86b190a884485ccff58aff70d6fe1dc30e846589c279f70a5664d6acc9e74cad',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:driveDisconnectPurgeQueue',
      fingerprint: 'd762ff0304e2a1fbc1a68626b1dedaf4ff4ee7ce782f15908bec7008c634a707',
    }
  ),
  broker(
    'queue:infra/queues.ts:driveDisconnectPurgeQueueDLQ',
    'd72d0b74a0ba0a11eb344d09ea5e3a85f5d0ae99bb78d541f24e07b2bf1615c5'
  ),
  wired(
    'queue:infra/queues.ts:driveLakeIngestQueue',
    '7721a951a8cb50b5ad8a842b53ef18c1445c51b4ac79a245f2a6ef75a2be5a21',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:driveLakeIngestQueue',
      fingerprint: '7469ed20213b42463586bdc7673278d471cc8cc40384232a38e02f1f35317c17',
    }
  ),
  broker(
    'queue:infra/queues.ts:driveLakeIngestQueueDLQ',
    '936a38165a1530a6e2300096213886ea50250a8cc9d8f192e5877234d74ea18f'
  ),
  wired(
    'queue:infra/queues.ts:fabFileChunkQueue',
    'f9e2b169cbc9baa999fde9b36a8106fcf19d58ed292b417bd229306d74b0b855',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:fabFileChunkQueue',
      fingerprint: 'b065deba7f1c6942927da333716b6ccf712c99bbf030a67438f1d638d7378726',
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
    'e063ef89a646677bd54a4bb35d210b8be67c6d45b4c7a77a619277313fc2ee72',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:fabFileVectorizeQueue',
      fingerprint: '97930394027f87bd310eddd24da4ae61ddaee526c50af9a8864f26ce95452d03',
    },
    ['bedrock:InvokeModel', 'cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:fabFileVectorizeQueueDLQ',
    '2e3862991aa93a6c5edc3d625cb53fdf125b408f1b85d204208d5d5531b04195'
  ),
  wired(
    'queue:infra/queues.ts:generationCallbackQueue',
    'cae0d3968043db54d14aca073fba5752d2e8ed8c0435e509652c7d1e82637494',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:generationCallbackQueue',
      fingerprint: 'f6cfc435e3f8ceea7b766d4a7e6cf6fa1f684a147ebf3995a78164b171104f8e',
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
    '0d42d959085700123e83ffac8104c2907b47ba917463a6e7fe57c005734b9cb4',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:generationJobQueue',
      fingerprint: '930e13975c9842b53c893f3b34bd99bbba1305840cc26bad66064e75f4fcafa4',
    }
  ),
  wired(
    'queue:infra/queues.ts:githubLakeIngestQueue',
    '5f3ce84b16696c185dcba949eb89c5a4b8697f12ded52d3ecb963539c6cc6df4',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:githubLakeIngestQueue',
      fingerprint: '53fce38c067970db73b0aa1a84ff6c223ce454b0d3924adfabe31693b5634c73',
    }
  ),
  broker(
    'queue:infra/queues.ts:githubLakeIngestQueueDLQ',
    '85d47c076cbe0cbf6f649423831607793f7c8e014bb946603b1252de412abf4c'
  ),
  wired(
    'queue:infra/queues.ts:githubLakeRevokeQueue',
    '13d2cfcd61adf0413f13cb18e0acc2a4287097c1a60c50b17ec13bd69ac77078',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:githubLakeRevokeQueue',
      fingerprint: '5d58f3eb4ce1df766ec714a1e7002c7283b82e1b76c34d69dfc916f91a55edc9',
    }
  ),
  broker(
    'queue:infra/queues.ts:githubLakeRevokeQueueDLQ',
    '4491856037e8f9226cdeb137466706aa7bc84abb90e191d01aef7f42424825d1'
  ),
  gap('queue:infra/queues.ts:githubWebhookQueue', '1fd350d8f6b75d525f18203c803be134a8ef8e450b32630a8ab60f9f5bd4e837', [
    'import:@aws-sdk/client-cloudwatch',
  ]),
  broker(
    'queue:infra/queues.ts:githubWebhookQueueDLQ',
    'a2822aee5a83e5452e0217169125d1a7788fe9a5f4c78dada41fb6e4aa412fb9'
  ),
  broker('queue:infra/queues.ts:imageEditDLQ', '10c1a0580567d9b39e1c9547b6edccdbf9e9e6a71ea74c050e73f8da63190074'),
  wired(
    'queue:infra/queues.ts:imageEditQueue',
    '73fc0a1f2c5d93808b6171f38e94ca684cb5d4ea66ad3dd522f518e78f55ca6b',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:imageEditQueue',
      fingerprint: '43f90231dfc42dc1bb54763310830c633999a06aa9e2d10703361ca51a4a82a7',
    },
    ['bedrock:*']
  ),
  broker(
    'queue:infra/queues.ts:imageGenerationDLQ',
    'e5555dbe58ec90c0fe40c11b46fab25d491c21b2e0e4db14a8bd75bb24684051'
  ),
  wired(
    'queue:infra/queues.ts:imageGenerationQueue',
    'f37dce3291f1223a70275df06e37299ea54902484d8c83f3a3d5743fb1b07d2e',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:imageGenerationQueue',
      fingerprint: '32203fa3b5915ed4abed40dce941123cedd6625d8daf4ec6b0f9287baa675eb0',
    },
    ['bedrock:*']
  ),
  gap(
    'queue:infra/queues.ts:lakeInconsistencyModelQueue',
    '82b674f574d0ff242f5406af8d87f29fff05254d71b43aeb112e1049d0e3d474'
  ),
  broker(
    'queue:infra/queues.ts:lakeInconsistencyModelQueueDLQ',
    'cd3631e1e06de7bbf8bef82bac2e6c518b0f9a2cedd0881211fad77de5b969f7'
  ),
  wired('queue:infra/queues.ts:lakeMemoryQueue', '42d5fb4292d07449df36f80d86bc13bd685eb436de096c412575d4a4d65404f7', {
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
    '078f01816ba8d075dc651c11f7770556aad52461e9c5bf97a5165d9062d1c536'
  ),
  broker(
    'queue:infra/queues.ts:libreoncologyAudioRenderQueueDLQ',
    '2ee2385d94d02b314ad0029cadb2c26a937f5a674ff43eb5a82816c228b00b6c'
  ),
  gap('queue:infra/queues.ts:liveOpsTriageQueue', '7d14b53739c606943d497cb1d9dfc22035f29d8793c7ee5511556f2fb81d6ad9', [
    'cloudwatch:PutMetricData',
    'import:@aws-sdk/client-cloudwatch',
  ]),
  broker(
    'queue:infra/queues.ts:liveOpsTriageQueueDLQ',
    '396277d7176e9e4839b55c3f4f43ba8107c46a9262e8cfa5859bff0b50bba37b'
  ),
  wired(
    'queue:infra/queues.ts:notebookCurationQueue',
    'd3d5002ff3132b6da6a514e1a1f52c5c1e82aa01661726df6b1481353fb977c6',
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
    '86b8c5ccad30b979bcfda8cf2586e8602b10e8f9c1f66dddc5fe9a55dfbb7f3b',
    ['cloudwatch:PutMetricData', 'execute-api:ManageConnections']
  ),
  broker(
    'queue:infra/queues.ts:optihashiRunCompletionQueueDLQ',
    '37a2dc491c730c2bc828b7b2d5b578d986d6bd4d6f8ae22f14115fa2d7795402'
  ),
  gap(
    'queue:infra/queues.ts:overwatchAnalyticsQueue',
    '921f75ce14fc521f6806e111509b3e8a8af480d0b9e43ff061bfe17cd7f3d5f2',
    ['cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:overwatchAnalyticsQueueDLQ',
    '48d2eb528668fa78a4afbc6df9740bd92ac527dc969f20966da54ac373072e04'
  ),
  wired(
    'queue:infra/queues.ts:questExportQueue',
    'daebcc2d0b1021e4c650792ebae48c616d8705525dc24c24db6cf634c604c420',
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
    'cec2e9f8803bd72ddd7870878c2fc23338857b4e332fcf968c56acca9c2e6437',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:researchEngineQueue',
      fingerprint: '0b8caa02f44e5e0b467966ff957c2e65831f1d723fa63a6395adcebc70bcfcf6',
    },
    ['bedrock:*']
  ),
  broker(
    'queue:infra/queues.ts:researchEngineQueueDLQ',
    'fc9787d34e6471af94a399dd6b53d266f1dd1d037fb591d7731ef8edec35d78d'
  ),
  gap('queue:infra/queues.ts:secopsTriageQueue', 'bc049373065cb81c2b82cda626c8f12107080671831fa7b0f0f27bdda8917ade', [
    'cloudwatch:PutMetricData',
    'import:@aws-sdk/client-cloudwatch',
  ]),
  broker(
    'queue:infra/queues.ts:secopsTriageQueueDLQ',
    '5dae60c15cdbc4e123e5ffaafcfdfecbe658a3ac123be20c976beab0dd4f3c2a'
  ),
  gap('queue:infra/queues.ts:slackExportQueue', 'd2d9a72bbace7d56db6248d534f8ca707658562179bef30b6b62f900afc2968c'),
  broker(
    'queue:infra/queues.ts:slackExportQueueDLQ',
    'e6f709c7a77ad92a6420578b8802c7199d3580045da4a245ec379dca2b2f2a84'
  ),
  gap('queue:infra/queues.ts:sreFixQueue', '664687478c4e22ca8c1227a4dd0e74027f5c4a542309159ed59ff544908c5ebb'),
  broker('queue:infra/queues.ts:sreFixQueueDLQ', '209afa13455584e3d213f4664f8bb372f97c4047b441a13c140c10a2d3b9950c'),
  gap('queue:infra/queues.ts:sreJobQueue', '3f517494149694c0f546b1e7656feaf7ab0b3559b91b19e4bcce2666a956192c', [
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
    '9e5d9070b68a991e80c6cd5155d8d49fe0970ea526b0e76b4ac7f87cd73fba15',
    ['cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:webhookDeliveryQueueDLQ',
    '489b16bdceaf15867423fcbfab9344b5e36cefcdbd6473c595f6604d440ad271'
  ),
  gap(
    'queue:infra/queues.ts:whatsNewGenerationQueue',
    '80c11bad2510eb54d0f6ae650b18419bbfd5aee82215996530018f880212107a',
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
    '3ca8f7a777542df98b25d8dc4e2435f8b88647a9022c79516118e7458c2121ec',
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
    'ee5e561d5e093f20865aaaf04031d5d2bacc15d51df52b80ef817abac8f36723'
  ),
  wired(
    'schedule:infra/cron.ts:agentExecutionAbandonedSweep',
    '2e72ff45545aa38599769ac48e41076ea47bb47ba3b4e0a98b08185ba9bc1931',
    {
      source: 'apps/workers/src/selfhost/abandonedExecutionSweep.ts',
      symbol: 'registerAbandonedExecutionSweep',
      fingerprint: '2d305238c11a974e7bed4c70116beab12108402fa7dc0320906e99e3949d9ebc',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  gap(
    'schedule:infra/cron.ts:agentProactiveMessageCron',
    '91b6b69947f28cbfcfcf0a02ceffade3f4f321725a23ad48a723e91e7834ff67'
  ),
  wired(
    'schedule:infra/cron.ts:apiKeyBaselineCalculation',
    '9708c11e41a04ab62137fcd9f8e7fcc13c95bd86ae5aeaf1cfca0476f2cfe12e',
    {
      source: 'apps/workers/src/selfhost/apiKeyBaselineCalculation.ts',
      symbol: 'registerApiKeyBaselineCalculation',
      fingerprint: '0c849457ddc4e06c07e6ad9a52d4098359838ad885f25824720da1795e75e606',
    }
  ),
  gap(
    'schedule:infra/cron.ts:attackSimulationCron',
    'ca1059603efb233b53b1392b15d08d992c160fbeaa5b320b40e66b1816006ab5'
  ),
  gap('schedule:infra/cron.ts:CloudSecurityScan', '59885b8bae50fcf16de5d40ddfbdccd02759cc654e66eb4fb835ab9da98994ce'),
  wired('schedule:infra/cron.ts:creditLotSweep', 'edefcd966023f5e25978ccd7cebbf356bdcfc670a9731184d50a4411cbee7f15', {
    source: 'apps/workers/src/selfhost/creditLotSweep.ts',
    symbol: 'registerCreditLotSweep',
    fingerprint: 'a8c89b47317a1c5821c18a6b5769c2bb20b64c1bafe69660994db5827757c7bd',
  }),
  gap(
    'schedule:infra/cron.ts:creditPurchaseReconciliation',
    'd1192ff6fbebe980bc878a273cb5fb91653f4c372c6ac1fbc2dd69488599461e',
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  gap(
    'schedule:infra/cron.ts:dailyUserActivityReport',
    '8d20cafae0e93c7e1f35f63a54e2967a7df660b2f85505ba848fd44741789841'
  ),
  wired(
    'schedule:infra/cron.ts:dataLakeBatchReconcile',
    'f304f8af944b76b42a3bf2545997d8d383b9bc61c7659c99c569236dd483484e',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'schedule:dataLakeBatchReconcile',
      fingerprint: '46effcb05a2948a0cd63692f0509089658320070a86bdf4d1b408027322ca73d',
    },
    ['cloudwatch:PutMetricData']
  ),
  wired(
    'schedule:infra/cron.ts:dataLakeResearchScheduleCron',
    'c0dfdcee7c01eb70b4c0bfad82778dac472b49d1cf9496c2a59d81583a7bcc47',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'schedule:dataLakeResearchSchedule',
      fingerprint: '96b50bfb4f81e4385a8bbb586e0254b98e515946939332b0a5b2f7f9ccce54cc',
    }
  ),
  gap('schedule:infra/cron.ts:deepAgentWakeCron', '79c4635bdc17373ed2ac1aa375aceadba26c3e04acca8de182b625c13d51ba60'),
  gap('schedule:infra/cron.ts:driveLakeResyncPoll', '9f0b124ebfedcd071ab11a91814874b0fca73157a2db3f5f7d5103dbc4cd8c43'),
  gap(
    'schedule:infra/cron.ts:emailCampaignScheduler',
    'f2deaa920d4137e7056c6966a0e04fb0c400bb0cde1859e67bf2725dd9bc050e'
  ),
  wired(
    'schedule:infra/cron.ts:generationJobSweep',
    'bed54c4902eec6117df761d3703d7ec701e17c9d9b01d78ba112574fc2b5c415',
    {
      source: 'apps/workers/src/selfhost/generationJobSweep.ts',
      symbol: 'registerGenerationJobSweep',
      fingerprint: '687b207c61a761f05b0b3b4fff8fc14f3458f119071153de2fd2723979f119f8',
    }
  ),
  wired(
    'schedule:infra/cron.ts:githubLakeReconcile',
    '7755f0123362265a6af42cf4f27a25de9fe8a661faba6cac0e414e8c5888e1dc',
    {
      source: 'apps/workers/src/selfhost/githubLakeReconcile.ts',
      symbol: 'registerGitHubLakeReconcile',
      fingerprint: '28fa72e17231df491e249d4e4d5fd0d19023022e7e4e52fde5f9f16e1781cecd',
    }
  ),
  gap('schedule:infra/cron.ts:helpDatalakeIngest', '2ba8014e695c68423bb2bf139a1ac9c099024a278b772484f7edbc4ae7baabba', [
    'bedrock:InvokeModel',
  ]),
  gap(
    'schedule:infra/cron.ts:integrationHealthCheck',
    'd50268342edda573205f7c2150784d1b0ee00aee38da90cc7183a615f471a314',
    ['cloudwatch:PutMetricData']
  ),
  wired(
    'schedule:infra/cron.ts:lakeConnectorOrphanReap',
    'e0d121201c2af4fd06d677cb617666eb90d8d4743715c34e92f30e509a828e8f',
    {
      source: 'apps/workers/src/selfhost/lakeConnectorOrphanReap.ts',
      symbol: 'registerLakeConnectorOrphanReap',
      fingerprint: '2f90eb27924b7d29b3d80505ff3c393740947f1dcc92ff289dec31aba793f335',
    }
  ),
  wired(
    'schedule:infra/cron.ts:lakeHealthSweep',
    '1ef87c7e643b18f2c7c2630e1929c6ed975984cd664eeb71aa2ed2f217037085',
    {
      source: 'apps/workers/src/selfhost/lakeHealthSweep.ts',
      symbol: 'registerLakeHealthSweep',
      fingerprint: '7b707156b4804bef2a829d784bbdfd104cef6765680ebd323909880c82456e34',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  wired(
    'schedule:infra/cron.ts:lakeInconsistencySweep',
    '4eae372a3dcf4f987dc741b8e0b2c1bd45ec8b337ff8823277ba9e0ad1560d7f',
    {
      source: 'apps/workers/src/selfhost/lakeInconsistencySweep.ts',
      symbol: 'registerLakeInconsistencySweep',
      fingerprint: 'd1e27a485506840b87ec42b02a47573e744ca7e02c5a28316506a2d57dcdf816',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  gap(
    'schedule:infra/cron.ts:liveopsTriageDispatcherCron',
    '38c7a4de275693c07f1c0c89abb0287f71242db305e931dcc39da4f668f98cbb',
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  wired(
    'schedule:infra/cron.ts:modelDiscoveryCron',
    '59f7ac74e27b77d2543985f94451a887c2628ebf01b1a650ffcff97830003837',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'schedule:modelDiscovery',
      fingerprint: 'af8fd123e0f7f9d2cddfc036bcd36dff7d2856ed25e1b165a346dee47ea14292',
    },
    ['bedrock:GetFoundationModelAvailability', 'bedrock:ListFoundationModels', 'cloudwatch:PutMetricData']
  ),
  gap(
    'schedule:infra/cron.ts:modelDiscoveryStalenessCron',
    '1d55286cde774a04641354c30845e8121240f5adeadde444d0277c0cca13e0b7',
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  wired(
    'schedule:infra/cron.ts:questTimeoutSweep',
    'b0738ddca309c8d482161c03313b808245834c48e33718c2e348b04404a4e627',
    {
      source: 'apps/workers/src/selfhost/questTimeoutSweep.ts',
      symbol: 'registerQuestTimeoutSweep',
      fingerprint: 'd51aeb7871d0b24b9fe6052862370e617e4d16b8f660adf0f5fd81e2d5465a7d',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  wired(
    'schedule:infra/cron.ts:scheduleTaskCron',
    '4792978953745b7ea8c9c384086e3be84d182f00db2252b3b61745af65096def',
    {
      source: 'apps/workers/src/selfhost/taskScheduler.ts',
      symbol: 'registerTaskScheduler',
      fingerprint: '5aefa6f48a90f15db086947ce51e342d4e4ac7495aa13d96b414708460adf953',
    },
    ['events:*']
  ),
  gap(
    'schedule:infra/cron.ts:secretRotationNotifier',
    '652835a436720280ceb7725be576cb629e694ea545e9c52b64d5ce5039a62491'
  ),
  gap(
    'schedule:infra/cron.ts:securityScanScheduler',
    '7990c8f65eeb79c89360dcb8b99eb4f01644b58eb925ec4ed1769ec58ffc676d',
    ['events:*']
  ),
  gap('schedule:infra/cron.ts:spendReconciliation', '90fb2c16ceb5e2102a38e7442ad104309e991a2bddd141b71fd9ea9ae4181d60'),
  gap(
    'schedule:infra/cron.ts:SreStaleDispatchCron',
    '8cc9319c75a522cd4adb7040f068c1724a66dbc2b310cec65a047c69bbc5a31e'
  ),
  wired('schedule:infra/cron.ts:telemetryCleanup', '3b3b2ae6bd430fd9a0501afd0cfb8c81f494bbfc4db752fbf2af8c3bafbddc18', {
    source: 'apps/workers/src/selfhost/telemetryCleanup.ts',
    symbol: 'registerTelemetryCleanup',
    fingerprint: 'da6450a4a59ea6ac4f91f4b6adc5e7c54586164f920952bb76654f03b4b0e228',
  }),
  wired('schedule:infra/cron.ts:voiceHoldSweep', '4e408da223818724615eb2702ada0a50c9f6f4a6c370d20135345dcacd417c4e', {
    source: 'apps/workers/src/selfhost/voiceHoldSweep.ts',
    symbol: 'registerVoiceHoldSweep',
    fingerprint: '736ef108898650ecdd41332d5ae49e3c3be864687111b57dd122e431a0b54b5b',
  }),
  gap(
    'schedule:infra/cron.ts:weeklyUserActivityReport',
    '119895e5bd3a38cf80ebe8ac0da18d7cb2d5ef4ef14e2c6ffa4c22f991f24603'
  ),
  gap(
    'schedule:infra/cron.ts:whatsNewHighlightsCron',
    'b0e9596674f9589856d9748f039b05efcc6b756768fb271a7d9ff47ba009537a',
    ['cloudwatch:PutMetricData']
  ),
  gap('schedule:infra/cron.ts:whatsNewSyncCron', 'c22c6f1da3086a35aef715f6e018e820751605f3b9bd9015ec3066fb890198cd', [
    'cloudwatch:PutMetricData',
  ]),
  gap(
    'schedule:infra/securityAlerts.ts:SecurityAlertsSchedule',
    'efd2f6c3a776b574e28c9472db6e42678865e8adb14506bff608a6fbc8ce0ca6',
    ['events:PutEvents']
  ),
  gap(
    'service:infra/chatCompletion.ts:ChatCompletion',
    'd010e126ee4819fef1099d145e4d7084c80f4060bb0c85aebcd71d7ce1cc2a82',
    ['bedrock:*', 'cloudwatch:PutMetricData', 'events:PutEvents', 'execute-api:ManageConnections']
  ),
  gap('service:infra/searxng.ts:Searxng', '16fc0b23bc4d075e5c4e98cbb502ff6dfc37aac7fbf9bd4f7429cd4202b2f370'),
  gap(
    'service:infra/subscriberFanout.ts:subscriberFanoutV2',
    '02cdd6b4926dc3c12f7ecff7a1975b25750d24d10b5e84b4f007f6a38a44092f'
  ),
  gap(
    'sesRule:infra/emailIngestion.ts:emailReceiptRule',
    '149ae3de5b22c02958053d3325afe648873ca141260f64d4b5b46168534b2f42'
  ),
  gap(
    'snsSubscription:infra/dlqAlarms.ts:DlqAlarmTopic',
    '72c73c3b941630cbb9ce8a14ce9cb58cfe634edb348042fe981bf64c1668e64c'
  ),
  gap(
    'snsSubscription:infra/dlqAlarms.ts:OobAlarmTopicEmailSub',
    '84d8a753d4398b1923cd6967f312436fd05f265f181f553686da48001a40fc31'
  ),
  gap(
    'snsSubscription:infra/serviceHealthAlarms.ts:ServiceHealthAlarmTopic',
    '4a94d420bc77dfef23c15ac8f1525ed923d651749c86aae9fb7e52ad2c267b18'
  ),
  gap(
    'snsSubscription:infra/waf.ts:WafAlarmSlackHandlerSubscription',
    'f12eafd92daf91c7f1df0593fd5f6545bfd4fe8e50b77a0a50ad6e791665a18d',
    ['lambda:InvokeFunction']
  ),
  gap(
    'snsSubscription:infra/waf.ts:WafOobAlarmTopicEmailSub',
    '773e060944d0c679ae3ac61c166a94850695a68936544361eb597a35f3470a3a'
  ),
];
