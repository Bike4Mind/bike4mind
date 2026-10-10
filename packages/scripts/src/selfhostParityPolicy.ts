import type { ParityPolicyEntry } from './selfhostParityInventory';

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
  gap('event:infra/eventBus.ts:email-send', '42d87a0efe64a8811acd6c84a6249adb274917180aa97fbf144d19b3fba5f105'),
  gap(
    'event:infra/eventBus.ts:notebook-curation-complete-analytics',
    'e5899b37e30656f1e5058fe8a40b0d65a332d7a412eb4eaa15d2d5c7cfa820c8'
  ),
  wired(
    'event:infra/eventBus.ts:notebook-curation-start',
    '6d38171fb73da0de9e6506ac9712966565ca084af861b2cb672cd8ec289af7cd',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:notebook.curation.start',
      fingerprint: 'd663ba075abfda9ac7d23d199b524d788380ffa8f915da8ba18b76501b20f57a',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:session-auto-name',
    'c47cd18df5c4c90cddeec85bcaa8a9a76c15e527955dc789fb3d502a505ed424',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:session.auto_name',
      fingerprint: '1c744f91e1ce4f1765bf04aa91c12ab6fa099bcb2b77c4d31d23367c9649ec89',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:session-context-summarize',
    '08cdeadc3e1e92a5e36ff1224bf635fe9b28ab94ff0c62ee748ddfc042e1974c',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:session.context_summarize',
      fingerprint: '8c0471c08765553599360b35043bdb754706e94de04888debe86819074b8f1aa',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:session-summarize',
    'ea07647ac717b9a0260738e2f41a491a8517618553b175aeeda6e3be83f02179',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:session.summarize',
      fingerprint: '8e17e080302a8214d65343e9a9de1c1ca9233dc5a74a5de4f39038762122a589',
    },
    ['bedrock:*']
  ),
  wired(
    'event:infra/eventBus.ts:session-tag',
    'f8620261bf0df48712e6984a1b6b2922817304f06e278f60c9913fd38b6a0677',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:session.tag',
      fingerprint: 'c929c56131db90fe534e9c2f3370c050a294b960953008a178f7ce06186ccb90',
    },
    ['bedrock:*']
  ),
  gap('event:infra/eventBus.ts:spider-start', 'dccb658d31a37b54b26d94929195072d8837d8ab3d91d282f8f1d07fa8f528f2', [
    'bedrock:*',
  ]),
  gap('event:infra/eventBus.ts:SreFixDispatch', 'fa1122e45e2de82ee4a61c73ce860a679f2f5ce735bc628dd56a35c82977a648'),
  gap(
    'event:infra/eventBus.ts:stripe-customer-subscription-updated',
    'cd779b66e9045eb11e7780b112145e2b13b8528a63adf596f03a7d35de5de074',
    ['cloudwatch:PutMetricData']
  ),
  gap(
    'event:infra/eventBus.ts:stripe-invoice-payment-succeeded',
    '23312708eeba4ef369e2a76a2f8896338edf795a55275cb0e0b3054ba8c5d9bb',
    ['cloudwatch:PutMetricData']
  ),
  gap('event:infra/eventBus.ts:telemetry-alert', '7089f153a0bc4362f16ce7b2efc8feb8021598cb29aaad1817b8766fb470d1df', [
    'bedrock:*',
  ]),
  wired(
    'event:infra/llm.ts:create-memento',
    '0a7971209922c8d0c0b73a41ff29d23eb6cf6a68cb6522cba0733a28a8afdf48',
    {
      source: 'apps/workers/src/selfhost/eventDispatch.ts',
      symbol: 'event:completion.completed',
      fingerprint: 'f3dbfd8d59e1d0554032f2a99b85c2d5c104a24312d88de9b96172070a99aea3',
    },
    ['bedrock:*']
  ),
  gap('event:infra/llm.ts:slack-completion-start', '4205a5deb21807d9c00bf3dee7dd8ff09a797d2e8ab77903ecd9a28e6943ba56', [
    'bedrock:*',
    'cloudwatch:PutMetricData',
    'events:PutEvents',
  ]),
  broker(
    'queue:infra/dlqAlarms.ts:DlqAlarmHandlerDlq',
    'a39800cfa48e2ecb2ab17d226bb6fde51c9222a75c61f822abe291e9692d938e'
  ),
  gap(
    'queue:infra/emailIngestion.ts:emailAnalysisQueue',
    '93efc639d079abf26bd69649b9a3882f51f87a2b120349540e6a155db0e95cc5',
    ['bedrock:InvokeModel']
  ),
  broker(
    'queue:infra/emailIngestion.ts:emailAnalysisQueueDLQ',
    '3293f56dff623e68c9514a4305754db7930dabcab9adbc52eb71e63ccecc7c7b'
  ),
  gap(
    'queue:infra/emailIngestion.ts:emailIngestionQueue',
    '3e5bc575856cf3b62935570f97b8383d942e8f555f7a9816501c7a8b48d6b292',
    ['bedrock:*']
  ),
  broker(
    'queue:infra/emailIngestion.ts:emailIngestionQueueDLQ',
    'f44858b26f2ee8f4fb254d41d172e76694252114fb45ab805e510e34c3897f1a'
  ),
  gap(
    'queue:infra/emailMarketing.ts:emailBatchQueue',
    'aff57efef115b5bad7c770f8f4804c6df1b6d65545c825d24d4dfb3e620ac697'
  ),
  broker(
    'queue:infra/emailMarketing.ts:emailBatchQueueDLQ',
    'ff7a3dc9d711600848964bb4825fac5af480800f91d5018d6e02b08064a17d73'
  ),
  gap(
    'queue:infra/emailMarketing.ts:emailJobQueue',
    'a05de66113703a2bfe18529c68bb7308613797f87ab19e6dc4445d1b16c297b1'
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
    '6d84631d3242843b84b42e02eb7ed71a3cb0f542ef39ba6f0467fe0f4b79e985',
    ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'cloudwatch:PutMetricData', 'events:PutEvents']
  ),
  broker(
    'queue:infra/queues.ts:agentContinuationQueueDLQ',
    '6a36ae54a4e5ea35b9c34a06d407cee8281bcd6284eeeecf35d7c530dd0c6ffb'
  ),
  gap(
    'queue:infra/queues.ts:agentProactiveMessageQueue',
    'e86f6ddc4ecb4b70186fbc6e9de2bb1aea8bded3f95aec4761d9c8d9e02b6e06',
    ['bedrock:*', 'cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:agentProactiveMessageQueueDLQ',
    '1990fa893bed28bef2523e156f10d9e0a787552590a76489415b59814359c2a9'
  ),
  gap('queue:infra/queues.ts:bobRunQueue', '37c4d892630d07dacf006244da2bb05fdda89e0353ec554b6e87cea11439e96c', [
    'execute-api:ManageConnections',
  ]),
  broker('queue:infra/queues.ts:bobRunQueueDLQ', '992ea82e88afb9edee954915d02a11a851268dc0059930f226609026a42b34aa'),
  wired(
    'queue:infra/queues.ts:dataLakeCleanupQueue',
    '4f497d6d41ead30cce0cd1fc0ae6157cfbb264fb9774afb287836cb23c355b6c',
    {
      source: 'apps/workers/src/selfhost/dataLakeCleanupQueue.ts',
      symbol: 'registerDataLakeCleanupQueue',
      fingerprint: 'cf7b6781d543e66a32135059cb05c222fb457355894b61896b5da78ff1768668',
    }
  ),
  broker(
    'queue:infra/queues.ts:dataLakeCleanupQueueDLQ',
    '501479ddcbfc73c175688c2151a627de14d2e3b900234a9c74d299f1fc75b7f2'
  ),
  wired(
    'queue:infra/queues.ts:dataLakeResearchQueue',
    'b2a1cd066e222f6172ccc8eab995574a7ff73c4372c69abc95f0606af9def0ea',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:dataLakeResearchQueue',
      fingerprint: '793adfd2cec0e14f7b6b594bfdd333f4ced1b42cb7b13bc923503031f20592af',
    }
  ),
  broker(
    'queue:infra/queues.ts:dataLakeResearchQueueDLQ',
    '282597bb81f72e340915441f8a2556c94f86bc43be0eb76db1f625d2d052a5ec'
  ),
  wired(
    'queue:infra/queues.ts:dataLakeTaxonomyQueue',
    '160c9d75e80605c1ead0626d9eda14aa11384eeae2bc15ff16ee8c721c4d9930',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:dataLakeTaxonomyQueue',
      fingerprint: '7b7139603e2bff8ede557f15b56fda2b99ea291fcd421af0dfc6a9ae36a70347',
    }
  ),
  broker(
    'queue:infra/queues.ts:dataLakeTaxonomyQueueDLQ',
    '09d613eb6bffdc733600b1b2dbb9a68496671babcfb7a2b8769c84b5d65d9bbd'
  ),
  gap('queue:infra/queues.ts:deepAgentWakeQueue', '846994a956732aa9a6faa6802e3b650714aaa7d9e1fa1348d74b797987b39171', [
    'bedrock:InvokeModel',
    'cloudwatch:PutMetricData',
  ]),
  broker(
    'queue:infra/queues.ts:deepAgentWakeQueueDLQ',
    '2daf534b0ed080ebdbaf3f323032db39f5ab06e345ebc0df5a73babd0f8c1bb8'
  ),
  wired(
    'queue:infra/queues.ts:driveDisconnectPurgeQueue',
    '735eb83e5cdf3512a51443391d796708c8511e31cc3493f97ae020bda275096c',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:driveDisconnectPurgeQueue',
      fingerprint: 'f111416e878ddece24e939152109f5863777b9967834c92b14f8d531a028a438',
    }
  ),
  broker(
    'queue:infra/queues.ts:driveDisconnectPurgeQueueDLQ',
    'd72d0b74a0ba0a11eb344d09ea5e3a85f5d0ae99bb78d541f24e07b2bf1615c5'
  ),
  wired(
    'queue:infra/queues.ts:driveLakeIngestQueue',
    'bd1e7bfd212b165a27f9bf3911ce51dd4561e468a477612fc9f66a7b64e517f7',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:driveLakeIngestQueue',
      fingerprint: '6224e207dc9f7b4e732289486dc6476a4eeed644e0411782d61387366dcc46d8',
    }
  ),
  broker(
    'queue:infra/queues.ts:driveLakeIngestQueueDLQ',
    '936a38165a1530a6e2300096213886ea50250a8cc9d8f192e5877234d74ea18f'
  ),
  wired(
    'queue:infra/queues.ts:fabFileChunkQueue',
    '4a93cbf9f316a443bcece94bda948054abc7c4c294b08d5d068352c1d92635b6',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:fabFileChunkQueue',
      fingerprint: '43631c564f0638d09a338d2bf165d4a20b53246e217a2217e25295c6c1bb8ce5',
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
    '56d5d811cdc553665c3318c1517fe6ab13d3496a1cb471a3909881dccacd6b9d',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:fabFileVectorizeQueue',
      fingerprint: 'e0faca724b799fcfbbe138fa2e09aa242f2f34e5327b88476bbc59513574dd37',
    },
    ['bedrock:InvokeModel', 'cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:fabFileVectorizeQueueDLQ',
    '2e3862991aa93a6c5edc3d625cb53fdf125b408f1b85d204208d5d5531b04195'
  ),
  wired(
    'queue:infra/queues.ts:generationCallbackQueue',
    '9266fdb8248f7b80dc3890a1b32206813d9cbc647f418315bc9fa6f8e69c4daa',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:generationCallbackQueue',
      fingerprint: '3cccd8782883911306dbacabc35ca638280a653d896ca9dc123105d97448225f',
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
    'be1666bae745eb7baa36340b5bfc073c95351420d5c1f51161e8396af43ac636',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:generationJobQueue',
      fingerprint: '7ef9bbaad0389ee784d823750595168c56a13d9daf7e7c2d82130db487113742',
    }
  ),
  wired(
    'queue:infra/queues.ts:githubLakeIngestQueue',
    '27fedc70438233888075d6b4db468407ef28153d3d47346f69cc0d48bb40fe6d',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:githubLakeIngestQueue',
      fingerprint: 'e9fc15d430211cb16d98d92b72479c538c5516f82733d042ab7aadd227226e65',
    }
  ),
  broker(
    'queue:infra/queues.ts:githubLakeIngestQueueDLQ',
    '85d47c076cbe0cbf6f649423831607793f7c8e014bb946603b1252de412abf4c'
  ),
  wired(
    'queue:infra/queues.ts:githubLakeRevokeQueue',
    '528fab78f77768b022a2a4239b7b7a191df9931e3cce11ee667dc48ab611f530',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:githubLakeRevokeQueue',
      fingerprint: '340bd19492be956d631700df2df078b4214c38e828fd47e8d309dbe779a6b825',
    }
  ),
  broker(
    'queue:infra/queues.ts:githubLakeRevokeQueueDLQ',
    '4491856037e8f9226cdeb137466706aa7bc84abb90e191d01aef7f42424825d1'
  ),
  gap('queue:infra/queues.ts:githubWebhookQueue', '3f8b518461cc0f295ef6ccee05ca41f5709642f117721910dd46a27c16b0464f', [
    'import:@aws-sdk/client-cloudwatch',
  ]),
  broker(
    'queue:infra/queues.ts:githubWebhookQueueDLQ',
    'a2822aee5a83e5452e0217169125d1a7788fe9a5f4c78dada41fb6e4aa412fb9'
  ),
  broker('queue:infra/queues.ts:imageEditDLQ', '10c1a0580567d9b39e1c9547b6edccdbf9e9e6a71ea74c050e73f8da63190074'),
  gap('queue:infra/queues.ts:imageEditQueue', 'd9a9bc2f2c4b1cd78bcce3f37a3152e1e38e904da44456f5f46006d0eec50c81', [
    'bedrock:*',
  ]),
  broker(
    'queue:infra/queues.ts:imageGenerationDLQ',
    'e5555dbe58ec90c0fe40c11b46fab25d491c21b2e0e4db14a8bd75bb24684051'
  ),
  gap(
    'queue:infra/queues.ts:imageGenerationQueue',
    '2acaf5ce56339f5755500b66a0fd0804dc34eea8429b5f97edbe679d93c2f809',
    ['bedrock:*']
  ),
  gap(
    'queue:infra/queues.ts:lakeInconsistencyModelQueue',
    'b47328698520fe15e8f124ae277206d5dc0fcc01f6547c1680c813156cc691d7'
  ),
  broker(
    'queue:infra/queues.ts:lakeInconsistencyModelQueueDLQ',
    'cd3631e1e06de7bbf8bef82bac2e6c518b0f9a2cedd0881211fad77de5b969f7'
  ),
  wired('queue:infra/queues.ts:lakeMemoryQueue', 'bc9163af6551c47a198c0f1d096ccc4bf83c5ccb346baca5b19b740fd534018a', {
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
    '897efd9af87209dd0bc1be65fe5c8ef86cf375ba033a409b69aabca86b0c15f0'
  ),
  broker(
    'queue:infra/queues.ts:libreoncologyAudioRenderQueueDLQ',
    '2ee2385d94d02b314ad0029cadb2c26a937f5a674ff43eb5a82816c228b00b6c'
  ),
  gap('queue:infra/queues.ts:liveOpsTriageQueue', '033d8bc24d391fb1e7c2040e471a8b7503d6651addf2696c646b25db79237b66', [
    'cloudwatch:PutMetricData',
    'import:@aws-sdk/client-cloudwatch',
  ]),
  broker(
    'queue:infra/queues.ts:liveOpsTriageQueueDLQ',
    '396277d7176e9e4839b55c3f4f43ba8107c46a9262e8cfa5859bff0b50bba37b'
  ),
  wired(
    'queue:infra/queues.ts:notebookCurationQueue',
    'e5f6a2c6bc72b10f9300dadab4e6f3c794b63548046337bbb2d26b10a63f2f38',
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
    '28dcfc905bf78c3f15aab70a154047f8004bb21af0c0ec265a2a797a4316079d',
    ['cloudwatch:PutMetricData', 'execute-api:ManageConnections']
  ),
  broker(
    'queue:infra/queues.ts:optihashiRunCompletionQueueDLQ',
    '37a2dc491c730c2bc828b7b2d5b578d986d6bd4d6f8ae22f14115fa2d7795402'
  ),
  gap(
    'queue:infra/queues.ts:overwatchAnalyticsQueue',
    '30f6b071335f2f09cfa4f52a2ef91a57d5328f0f37cc122189e3232b0992415e',
    ['cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:overwatchAnalyticsQueueDLQ',
    '48d2eb528668fa78a4afbc6df9740bd92ac527dc969f20966da54ac373072e04'
  ),
  wired(
    'queue:infra/queues.ts:questExportQueue',
    '1619014baca05c841cd8904b42d461ba1357a4df5f87c373bf36c5dd16f8c125',
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
    'ec6a3e98adfcd03b14dc5ef1f19b20510a1fd2ac68ef6160ed4838834a1f11ee',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'queue:researchEngineQueue',
      fingerprint: '72b065d1d17b7f98327b4d256995e36ff345f00a7f14c26ddedfae70739f17af',
    },
    ['bedrock:*']
  ),
  broker(
    'queue:infra/queues.ts:researchEngineQueueDLQ',
    'fc9787d34e6471af94a399dd6b53d266f1dd1d037fb591d7731ef8edec35d78d'
  ),
  gap('queue:infra/queues.ts:secopsTriageQueue', '80676621deb3dbd6da61fa4703b3e6aee893b7da6466cc119ccd7804aef29d28', [
    'cloudwatch:PutMetricData',
    'import:@aws-sdk/client-cloudwatch',
  ]),
  broker(
    'queue:infra/queues.ts:secopsTriageQueueDLQ',
    '5dae60c15cdbc4e123e5ffaafcfdfecbe658a3ac123be20c976beab0dd4f3c2a'
  ),
  gap('queue:infra/queues.ts:slackExportQueue', 'aa10446c225c8d09a74726eefb03f330527170f199efed6e1d1f0cb69835b9db'),
  broker(
    'queue:infra/queues.ts:slackExportQueueDLQ',
    'e6f709c7a77ad92a6420578b8802c7199d3580045da4a245ec379dca2b2f2a84'
  ),
  gap('queue:infra/queues.ts:sreFixQueue', 'b564105a8d0e90f3be13761c47c1da101006f50fbb0278746e10b92ecd3cfe95'),
  broker('queue:infra/queues.ts:sreFixQueueDLQ', '209afa13455584e3d213f4664f8bb372f97c4047b441a13c140c10a2d3b9950c'),
  gap('queue:infra/queues.ts:sreJobQueue', 'e9ce6cc3e4c99f28cece9335b4cca4634741b20724d82eb214a51a974534ae5a', [
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
    'f0e7aaa326325c3c3ab2128c9be2ea75fb208b5c3c66129512eaa40ac536729a',
    ['cloudwatch:PutMetricData']
  ),
  broker(
    'queue:infra/queues.ts:webhookDeliveryQueueDLQ',
    '489b16bdceaf15867423fcbfab9344b5e36cefcdbd6473c595f6604d440ad271'
  ),
  gap(
    'queue:infra/queues.ts:whatsNewGenerationQueue',
    '623a97cd5e5e4c852feb00713230d8e06b2e6a6031e5a01a7fc5e2e09f35e99e',
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
    'c59b28a74f4f1b352e408486103bc66acfdb0b8a35d5f3bc05d58b52bffc0d33',
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
    '83b109a460727fb1e6e809f30bac1d947a546f28fe478dcbb914e4d6a76069f3'
  ),
  wired(
    'schedule:infra/cron.ts:agentExecutionAbandonedSweep',
    '1aa734c661465683341def622c0c9d8145b65c3b81513e41e884a5cfa2faf36e',
    {
      source: 'apps/workers/src/selfhost/abandonedExecutionSweep.ts',
      symbol: 'registerAbandonedExecutionSweep',
      fingerprint: '2d305238c11a974e7bed4c70116beab12108402fa7dc0320906e99e3949d9ebc',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  gap(
    'schedule:infra/cron.ts:agentProactiveMessageCron',
    '20877476fbbe8dc32ddfcafc14ebff39355b47135a00a52c9715eb7583ec0898'
  ),
  wired(
    'schedule:infra/cron.ts:apiKeyBaselineCalculation',
    'bb692dec2e55e2ffb4a2ce48c1e62a11700c376e9bc98da26fbe9a9c9b59ef5f',
    {
      source: 'apps/workers/src/selfhost/apiKeyBaselineCalculation.ts',
      symbol: 'registerApiKeyBaselineCalculation',
      fingerprint: '0c849457ddc4e06c07e6ad9a52d4098359838ad885f25824720da1795e75e606',
    }
  ),
  gap(
    'schedule:infra/cron.ts:attackSimulationCron',
    '0378d1fc3cec70be1611a2731c96bf195bca5a4c1fbaeee8aea515fd53978d1e'
  ),
  gap('schedule:infra/cron.ts:CloudSecurityScan', '590fc3f8f7e4ab55885a1a1ac3274be140c9b02ea3683c94e1d6f9559d82c545'),
  wired('schedule:infra/cron.ts:creditLotSweep', 'ffde2b5bad96b0a9994f1c7a8ab04dc66d428f67a598028f620b350c3acbf7b1', {
    source: 'apps/workers/src/selfhost/creditLotSweep.ts',
    symbol: 'registerCreditLotSweep',
    fingerprint: 'a8c89b47317a1c5821c18a6b5769c2bb20b64c1bafe69660994db5827757c7bd',
  }),
  gap(
    'schedule:infra/cron.ts:dailyUserActivityReport',
    '6087491366bcb4de351c7cffdf75c4cfbef49fcdd3f6a4fcb2139f5a277d8098'
  ),
  wired(
    'schedule:infra/cron.ts:dataLakeBatchReconcile',
    '2fc2e29294001f6222b4857099659d42ac72cfbbfb1004100a77a9c47d480b49',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'schedule:dataLakeBatchReconcile',
      fingerprint: '0c80b3b312f7c0e533b44485115cf2c03a65cd5062fe270b9d7bc0ae20b40fe2',
    },
    ['cloudwatch:PutMetricData']
  ),
  wired(
    'schedule:infra/cron.ts:dataLakeResearchScheduleCron',
    'f01f74482df87892eca8d116dc07b88dc438d39e917af862008960d5d23157ec',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'schedule:dataLakeResearchSchedule',
      fingerprint: 'e15b377b7660ee52d26baa2e6bb9800317be606ec778e9e3406cbed558100962',
    }
  ),
  gap('schedule:infra/cron.ts:deepAgentWakeCron', '4e6897310485e60328fc6b2910edd36aae51910ed47056d66b07f303f8ff66f3'),
  gap('schedule:infra/cron.ts:driveLakeResyncPoll', '3ec5ebc4e14f2b8435a8ad41df50f49282209f29db3586e4d83123bfaaeed2f9'),
  gap(
    'schedule:infra/cron.ts:emailCampaignScheduler',
    '3054b1dfca429819cf85337b3071eaac57c5f1f3bb8a6bd5fca2b9ce885333c8'
  ),
  wired(
    'schedule:infra/cron.ts:generationJobSweep',
    'bc0fd6b08fda95e13f53c07a08aac6698a0eb5001c4a69503148a10de4bcc277',
    {
      source: 'apps/workers/src/selfhost/generationJobSweep.ts',
      symbol: 'registerGenerationJobSweep',
      fingerprint: '687b207c61a761f05b0b3b4fff8fc14f3458f119071153de2fd2723979f119f8',
    }
  ),
  wired(
    'schedule:infra/cron.ts:githubLakeReconcile',
    '52c09f7fefc9606c0063e49197d2ec99938e2d785b61c16f07827c5c60339c45',
    {
      source: 'apps/workers/src/selfhost/githubLakeReconcile.ts',
      symbol: 'registerGitHubLakeReconcile',
      fingerprint: '28fa72e17231df491e249d4e4d5fd0d19023022e7e4e52fde5f9f16e1781cecd',
    }
  ),
  gap('schedule:infra/cron.ts:helpDatalakeIngest', '2a2d195583c49b75ad9dab06ce07bf065cb69c046de43216a16c10d495076c20', [
    'bedrock:InvokeModel',
  ]),
  gap(
    'schedule:infra/cron.ts:integrationHealthCheck',
    '89e8f187b48344604fc30208af2b6b48154d2fd0aedc6c0bfd47baa1b8f65e8b',
    ['cloudwatch:PutMetricData']
  ),
  wired(
    'schedule:infra/cron.ts:lakeHealthSweep',
    '13575f402a285541847a8b6e6399ab3b6c792da31b7bec73aa5c085c55c45971',
    {
      source: 'apps/workers/src/selfhost/lakeHealthSweep.ts',
      symbol: 'registerLakeHealthSweep',
      fingerprint: '7b707156b4804bef2a829d784bbdfd104cef6765680ebd323909880c82456e34',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  wired(
    'schedule:infra/cron.ts:lakeInconsistencySweep',
    '0c04f654a669a433ff4d9c2c5eea36aa3338ae14967c0c25eebf782df3f3630b',
    {
      source: 'apps/workers/src/selfhost/lakeInconsistencySweep.ts',
      symbol: 'registerLakeInconsistencySweep',
      fingerprint: 'd1e27a485506840b87ec42b02a47573e744ca7e02c5a28316506a2d57dcdf816',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  gap(
    'schedule:infra/cron.ts:liveopsTriageDispatcherCron',
    '38298b5a4b74cfd3311414ddc4016666fc8b98af3614c22e4375703770d964bc',
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  wired(
    'schedule:infra/cron.ts:modelDiscoveryCron',
    'e88c74bc6ca1198a2d2bd516b9cecb9ec788344f2f50be58d3c98f345776c282',
    {
      source: 'apps/workers/src/selfhost/main.ts',
      symbol: 'schedule:modelDiscovery',
      fingerprint: 'eec9b06d5558498dbb899bdfe9e86d8607b5d7d2d8f4882a0d161238862cd2b2',
    },
    ['bedrock:GetFoundationModelAvailability', 'bedrock:ListFoundationModels', 'cloudwatch:PutMetricData']
  ),
  gap(
    'schedule:infra/cron.ts:modelDiscoveryStalenessCron',
    'b1adce7c90f1e1fc2f2b9c6ed4abfd7cf7893ef637c46d86cc036dbfacbf9533',
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  wired(
    'schedule:infra/cron.ts:questTimeoutSweep',
    '6e58fba8d8701b10d41dd5878fb58778ca64d7281748702ca6553f492e18ab70',
    {
      source: 'apps/workers/src/selfhost/questTimeoutSweep.ts',
      symbol: 'registerQuestTimeoutSweep',
      fingerprint: 'd51aeb7871d0b24b9fe6052862370e617e4d16b8f660adf0f5fd81e2d5465a7d',
    },
    ['cloudwatch:PutMetricData', 'import:@aws-sdk/client-cloudwatch']
  ),
  wired(
    'schedule:infra/cron.ts:scheduleTaskCron',
    'b9ad55cfeb1a600d41eacf1883fcc4ed49842f57a99bc17b26e38a9a1b7f78e9',
    {
      source: 'apps/workers/src/selfhost/taskScheduler.ts',
      symbol: 'registerTaskScheduler',
      fingerprint: '5aefa6f48a90f15db086947ce51e342d4e4ac7495aa13d96b414708460adf953',
    },
    ['events:*']
  ),
  gap(
    'schedule:infra/cron.ts:secretRotationNotifier',
    'f9f7907ef07234511bc4e93660ee5547784c6c06dd73f10550110f87b1222796'
  ),
  gap(
    'schedule:infra/cron.ts:securityScanScheduler',
    '1696d83d9c9ac924b6834bd7d432900bbc2988810528dfba85c5863e47ee6c0d',
    ['events:*']
  ),
  gap('schedule:infra/cron.ts:spendReconciliation', '8917147eb4d03887695d6ca29d7511b3ade360ad27588ed91c874f7edadea74a'),
  gap(
    'schedule:infra/cron.ts:SreStaleDispatchCron',
    '7dc7f6715091b5ea915d5b378a6efd420792f467411c9c62bdbbdc7c2db0e7f3'
  ),
  wired('schedule:infra/cron.ts:telemetryCleanup', '4638c390ed500b090531e0eff675949128afc44fb835288626a13ceb633b6b00', {
    source: 'apps/workers/src/selfhost/telemetryCleanup.ts',
    symbol: 'registerTelemetryCleanup',
    fingerprint: 'da6450a4a59ea6ac4f91f4b6adc5e7c54586164f920952bb76654f03b4b0e228',
  }),
  gap(
    'schedule:infra/cron.ts:weeklyUserActivityReport',
    'c878c6efc7220b479d3f778564938f32926a149e5aa271fbd8df3fe8c191ac2f'
  ),
  gap(
    'schedule:infra/cron.ts:whatsNewHighlightsCron',
    '7cd4e383aa06203654a9c769561dc86a5260bd163fb56b05035619f308af220c',
    ['cloudwatch:PutMetricData']
  ),
  gap('schedule:infra/cron.ts:whatsNewSyncCron', 'ac35e784db547893bda67ae9b8fba28a2f5fced73593611cfe42416de649521f', [
    'cloudwatch:PutMetricData',
  ]),
  gap(
    'schedule:infra/securityAlerts.ts:SecurityAlertsSchedule',
    '022fb9a6a7ad06fc41df63dcd3c8e95bc45e6876a99741ce8d872490decdbe9c',
    ['events:PutEvents']
  ),
];
