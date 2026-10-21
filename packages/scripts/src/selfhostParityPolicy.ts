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
  gap('event:infra/llm.ts:slack-completion-start', 'ac698df8099dc31721aa456578e7ed20cab7130781b0c5d77022c6187dc818f4', [
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
    '259167e53b4f21e52b64f1a2154ba55e5547f459deda85b7305028337d5b0755',
    ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'cloudwatch:PutMetricData', 'events:PutEvents']
  ),
  gap('function:infra/database.ts:DatabaseCleaner', 'e52f8c2f59b621e25176f06917724c82cd678c213de7325e2d9ad064c2971b70'),
  gap(
    'function:infra/database.ts:DatabaseMigrator',
    'ddc9d611ee11a49f55806b0dbbae33183546cbeb610550c0d228435fd7691db1'
  ),
  gap('function:infra/database.ts:DatabaseSeeder', 'aaf2ea29aae4258be24385977537d2273fa8306215ad0744040ef4cc65b9a91e', [
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
    '00c285e858f18b475acbfe6548243c3a0e40101c4724768c9d486e2671adc420'
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
    'ce1f8e331afd2ceb72371d7acf8e04627891ae787024b0b1b0fa9618fcffcd3b',
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
      fingerprint: 'ac1bc0d0eb7e60650420fcafa0c8cc1ac44874cb0132365c3c41510631bca8a7',
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
      fingerprint: '702a030220e5615752033da263a8952ee1111c0d66132c93c5f70ca8c9b5105c',
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
      fingerprint: '8146b1d5d3d6d7589f7b389c25299b0d54cc3ef615a9e2a338e40e83fb1dd27d',
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
      fingerprint: 'dfdc789272936b136c7ae41fe775c8c9f803689c6b7cef1a76bc2eaed9cda186',
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
      fingerprint: 'eadc042fb294dce64dc6a99aed438c9def2a74e04055ae0f0779cc4cffce1bea',
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
      fingerprint: 'c97f9bbdcbf5c78a2a356c3cfb9ea79d8f199a9e307880d6e1021ed8c55f820e',
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
      fingerprint: '731feca644713bcfd60142035776f8d3c7787ade05e316599b86d47da1e3e435',
    },
    ['bedrock:InvokeModel', 'cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:fabFileVectorizeQueueDLQ',
    '2e3862991aa93a6c5edc3d625cb53fdf125b408f1b85d204208d5d5531b04195'
  ),
  wired(
    'queue:infra/queues.ts:generationCallbackQueue',
    'ae237051ce20715e8fb67ecc582b289287c4d90d7c94344344f2f9fedbef8ba7',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:generationCallbackQueue',
      fingerprint: 'b8e07d0f19c08b7c6a94490e8c21ca19102b272f08e2b59ead0bdc1d621e8a82',
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
      fingerprint: 'd094a0fe2c6b094e226d008d9e94ab59d663b09e9b12f8410e0b891bf9e46d03',
    }
  ),
  wired(
    'queue:infra/queues.ts:githubLakeIngestQueue',
    '5f3ce84b16696c185dcba949eb89c5a4b8697f12ded52d3ecb963539c6cc6df4',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:githubLakeIngestQueue',
      fingerprint: 'd91c7034c66a1f1c2d9923a9562dc73902dd3ee76a78aebe2aeec5a5ae135255',
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
      fingerprint: '4a86fb425d1995f9fcee4a98bc819ac35f1da1652c803ba5703b6a4109af3d24',
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
      fingerprint: 'cae519a2870f50dc927f2e9afe18079cb1d86dfa1c568f95e8b2d6f7e07ea00f',
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
      fingerprint: '3ed2f49eab22afd9a7d1c18b82f6c2382b4c26965f73551bf32afb4c55c1ba4e',
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
    '9f43268abec33c309b1020cff8c27e3d35e17f990b715e9aec1cbf32feb8af4a',
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
      fingerprint: 'c6319d69ec2e1f2ea436c80c81b7f6a7225342c3df7633122e0aab117f4e0490',
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
  wired('schedule:infra/cron.ts:adminAuditAlerts', '3d29c77c0415f6c9a1df4c5844222d599f060b9cc59f38fddcf9878c6882ec47', {
    source: 'apps/workers/src/selfhost/adminAuditAlerts.ts',
    symbol: 'registerAdminAuditAlerts',
    fingerprint: 'c3d09ab1645e180de73018af05a50b748c27dffcb699ccd1535be774c1359ab6',
  }),
  wired(
    'schedule:infra/cron.ts:agentExecutionAbandonedSweep',
    '9a52354f7105669b1d7801c105eda9fa65205775a9ca6cf3b87c88c79e3e423a',
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
    'd7da5b363930eba0108ccc9e78d0c9572e88ad1949b7f2fb724ff2dca9e163c4',
    {
      source: 'apps/workers/src/selfhost/apiKeyBaselineCalculation.ts',
      symbol: 'registerApiKeyBaselineCalculation',
      fingerprint: '0c849457ddc4e06c07e6ad9a52d4098359838ad885f25824720da1795e75e606',
    }
  ),
  gap(
    'schedule:infra/cron.ts:attackSimulationCron',
    '493f4ece19e6b0e52c0e9c8fb43fc08245e69c98fb763ce06c8ed67c474e85e8'
  ),
  gap('schedule:infra/cron.ts:CloudSecurityScan', 'e4c54adf04e623e4ddabdc158aa2d3304bf8d0a29fd6c68cd9018f3e1893194b'),
  wired(
    'schedule:infra/cron.ts:creditHoldSweep',
    '89a0eb8abf6a7ec5b2e6ce52e61b52df542e3e62b422a9ef03952b1abadaf0ce',
    {
      source: 'apps/workers/src/selfhost/creditHoldSweep.ts',
      symbol: 'registerCreditHoldSweep',
      fingerprint: 'd5a06717fc21aeaaabc32cfbb3bd759dffe2f779c877d2c12481a13e5c007e2a',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  wired('schedule:infra/cron.ts:creditLotSweep', 'a8cd3c545b8da400b647c4f02385ccf90a2097d181d8dfc548f6acb0c0bec615', {
    source: 'apps/workers/src/selfhost/creditLotSweep.ts',
    symbol: 'registerCreditLotSweep',
    fingerprint: 'a8c89b47317a1c5821c18a6b5769c2bb20b64c1bafe69660994db5827757c7bd',
  }),
  gap(
    'schedule:infra/cron.ts:creditPurchaseReconciliation',
    'ff04c893f2101dd6edb7d0ca04a576b7ff75fb28cb45fcf3add98cd6f1948032',
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  gap(
    'schedule:infra/cron.ts:dailyUserActivityReport',
    '25dad0aee60758280848e2628a46a060b37d86cfc642c5082b03c41684992fbc'
  ),
  wired(
    'schedule:infra/cron.ts:dataLakeBatchReconcile',
    '073ff27f64a51a09a60ac88c579fadb18eba7425879a8055d88424b24642355f',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'schedule:dataLakeBatchReconcile',
      fingerprint: '01d46d22b2f231c3233a5929da8da6c9a3be75305b41bf21451b0974aee700c8',
    },
    ['cloudwatch:PutMetricData']
  ),
  wired(
    'schedule:infra/cron.ts:dataLakeResearchScheduleCron',
    '881ef4c8f240fb5405433ba8c4adb17373409eb11d16873ada0bda7117d38c6c',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'schedule:dataLakeResearchSchedule',
      fingerprint: '2ad538bc8a1cc13f558998f429d9a1e71748afe503e072200398a829eb52cf50',
    }
  ),
  gap('schedule:infra/cron.ts:deepAgentWakeCron', 'c312aea3eea5a3c2c729f63f32cf587cab67ec0ccaa793a3e140f9ce23a0e11e'),
  gap('schedule:infra/cron.ts:driveLakeResyncPoll', '964dba267ccb03cb766b96add16e29da5d8715dd031bc9cac8b46e115d59ad8d'),
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
    'b6a3478ff3c433bca6d96e6980b050e9c2eec0cedf0ca9822951b8109874a17d',
    {
      source: 'apps/workers/src/selfhost/githubLakeReconcile.ts',
      symbol: 'registerGitHubLakeReconcile',
      fingerprint: '28fa72e17231df491e249d4e4d5fd0d19023022e7e4e52fde5f9f16e1781cecd',
    }
  ),
  gap('schedule:infra/cron.ts:helpDatalakeIngest', 'c0028172649b6d280beab0768f5f79214893e9818b3d8aafb7a851a74a1a7e04', [
    'bedrock:InvokeModel',
  ]),
  gap(
    'schedule:infra/cron.ts:integrationHealthCheck',
    'a5f8162f9f58cac2eae48f0b4d612ff670eb4f41f490cbb9dfc05b09c31ac520',
    ['cloudwatch:PutMetricData']
  ),
  wired(
    'schedule:infra/cron.ts:lakeConnectorOrphanReap',
    '5135129242da6f0b07b8c1fec5e587ffbe4913c8a66177c0620b29c31299b65d',
    {
      source: 'apps/workers/src/selfhost/lakeConnectorOrphanReap.ts',
      symbol: 'registerLakeConnectorOrphanReap',
      fingerprint: '2f90eb27924b7d29b3d80505ff3c393740947f1dcc92ff289dec31aba793f335',
    }
  ),
  wired(
    'schedule:infra/cron.ts:lakeHealthSweep',
    '475503899c233b3a4c2d25b96ddf21bbd8356ab548c5b455119214f93db08b5f',
    {
      source: 'apps/workers/src/selfhost/lakeHealthSweep.ts',
      symbol: 'registerLakeHealthSweep',
      fingerprint: '7b707156b4804bef2a829d784bbdfd104cef6765680ebd323909880c82456e34',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  wired(
    'schedule:infra/cron.ts:lakeInconsistencySweep',
    '1c97472d179b1fcb9fb916ac35a344335aa72e3e7267e1be94f4938603da9565',
    {
      source: 'apps/workers/src/selfhost/lakeInconsistencySweep.ts',
      symbol: 'registerLakeInconsistencySweep',
      fingerprint: 'd1e27a485506840b87ec42b02a47573e744ca7e02c5a28316506a2d57dcdf816',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  gap(
    'schedule:infra/cron.ts:liveopsTriageDispatcherCron',
    '48ebe9d6b063f00792cc820bb1c2c6557b0649273addde5bf55be7034722fe39',
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  wired(
    'schedule:infra/cron.ts:modelDiscoveryCron',
    'ea8a12d710cc3e6ac97e6256cd287c57386a8d498a5a58fb38f1f3a57eac53c1',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'schedule:modelDiscovery',
      fingerprint: '19e7df33c533d0f8954f8c4e636e80c11b99d79c241b51f1b90a660af79d0470',
    },
    ['bedrock:GetFoundationModelAvailability', 'bedrock:ListFoundationModels', 'cloudwatch:PutMetricData']
  ),
  gap(
    'schedule:infra/cron.ts:modelDiscoveryStalenessCron',
    '8f17755858a749f29b24d3ddfdb46fd237d5f89769b8853225e077af2ad94d29',
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  wired(
    'schedule:infra/cron.ts:questTimeoutSweep',
    '912e9c3a3430885071153f51bf886db3e7e2664b1e25c4e6f4096d26d97db31e',
    {
      source: 'apps/workers/src/selfhost/questTimeoutSweep.ts',
      symbol: 'registerQuestTimeoutSweep',
      fingerprint: 'd51aeb7871d0b24b9fe6052862370e617e4d16b8f660adf0f5fd81e2d5465a7d',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  wired(
    'schedule:infra/cron.ts:realtimeConnectionSweep',
    'ef44ce959dc20b02bc5cd5bcf0cde41d0fa0dec94e67cffc429ab09b32f7db91',
    {
      source: 'apps/workers/src/selfhost/realtimeConnectionSweep.ts',
      symbol: 'registerRealtimeConnectionSweep',
      fingerprint: '786cca0d3f334531b90d437cb49f4e4335b24989be24bfead1845eda9fb0e380',
    },
    ['execute-api:ManageConnections']
  ),
  wired(
    'schedule:infra/cron.ts:scheduleTaskCron',
    '4792978953745b7ea8c9c384086e3be84d182f00db2252b3b61745af65096def',
    {
      source: 'apps/workers/src/selfhost/taskScheduler.ts',
      symbol: 'registerTaskScheduler',
      fingerprint: 'f394d8b0c0847bf801d80443d57e8f46a220a037cc7a0484d9f9d39365c5206e',
    },
    ['events:*']
  ),
  gap(
    'schedule:infra/cron.ts:secretRotationNotifier',
    '53ce6957dc65b2898314c65405ebf7a4b16a7471bedb6ccd8ed642e0ced5ed2e'
  ),
  gap(
    'schedule:infra/cron.ts:securityScanScheduler',
    '937c351074f20bfa1f240fab190968f89b0acecae4f8e6cf38620b97ba44ff21',
    ['events:*']
  ),
  wired(
    'schedule:infra/cron.ts:skillMarketReviewSla',
    'a9e0bcc6e7296cb0b9fa36ad4fdc2ab94c1a7a45b5342263e164967b16fc48e7',
    {
      source: 'apps/workers/src/selfhost/skillMarketReviewSla.ts',
      symbol: 'registerSkillMarketReviewSla',
      fingerprint: '9f57dd7788c58e8c80541ed80e9def95959a8ab62567866fe35d4c9ca6b98ec9',
    }
  ),
  gap('schedule:infra/cron.ts:spendReconciliation', '7c16e45ebde04b25819b6fb67b67021d2e962e3a5bb4f57c4f62841a192f2050'),
  gap(
    'schedule:infra/cron.ts:storageReconciliation',
    '57c3ffee025c3ca6cc34b1a3659e0b3997e4dab02136a084c5a67da657c75624',
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  gap(
    'schedule:infra/cron.ts:signupBaselineReport',
    'c5e21ed10e3d8b48ba363af2d0422119287414d2a0fce925897b7925e55b1a27'
  ),
  gap(
    'schedule:infra/cron.ts:SreStaleDispatchCron',
    '40b5809d38bd8ac7c195c309c64f592d07dfed93c9fad1541765c4d94cc70dbd'
  ),
  wired('schedule:infra/cron.ts:telemetryCleanup', '720c1dfcfd8c320446a2334585ef3b6d08af343aae67c8b6f3a12bc2388cff9d', {
    source: 'apps/workers/src/selfhost/telemetryCleanup.ts',
    symbol: 'registerTelemetryCleanup',
    fingerprint: 'da6450a4a59ea6ac4f91f4b6adc5e7c54586164f920952bb76654f03b4b0e228',
  }),
  wired(
    'schedule:infra/cron.ts:voiceHoldSweep',
    '89b2864330246aeafc0f6771aff6bf74ca90a0f22df1ddd72409f718fc0edb45',
    {
      source: 'apps/workers/src/selfhost/voiceHoldSweep.ts',
      symbol: 'registerVoiceHoldSweep',
      fingerprint: '736ef108898650ecdd41332d5ae49e3c3be864687111b57dd122e431a0b54b5b',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  gap(
    'schedule:infra/cron.ts:weeklyUserActivityReport',
    '1b96e0c9771ef7c02e7791e814f07c88cf23e8c02f0408d10d3de9b583111f70'
  ),
  gap(
    'schedule:infra/cron.ts:whatsNewHighlightsCron',
    'be68c74f51033aa9ad7f4a49c7d85ec9acdb9d88e202eb00dbfe96cf0953063c',
    ['cloudwatch:PutMetricData']
  ),
  gap('schedule:infra/cron.ts:whatsNewSyncCron', 'c22c6f1da3086a35aef715f6e018e820751605f3b9bd9015ec3066fb890198cd', [
    'cloudwatch:PutMetricData',
  ]),
  gap(
    'schedule:infra/securityAlerts.ts:SecurityAlertsSchedule',
    'aa4dee6442687bf18f254f1de11a4180049760781332890f006025e80f059ca6',
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
