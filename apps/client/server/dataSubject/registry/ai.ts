import type { DataHolderRegistry } from '../types';

export const aiHolders = {
  ActiveCodeAgent: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  Agent: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'users.userId', matchBy: 'userId', action: 'pullFromArray' },
    ],
  },
  AgentOpsSettings: {
    kind: 'holder',
    references: [{ path: 'versions.createdBy', matchBy: 'userId', action: 'anonymize' }],
  },
  CodeAgentEvent: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument' },
      // The approver of a tool request can be someone other than the event's owner.
      { path: 'resolvedBy', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  CuratedCatalogVersion: {
    kind: 'holder',
    references: [{ path: 'publishedBy', matchBy: 'userId', action: 'anonymize' }],
  },
  DataLake: {
    kind: 'holder',
    references: [
      { path: 'createdByUserId', matchBy: 'userId', action: 'anonymize' },
      { path: 'lastUpdatedByUserId', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  DataLakeAccessGrant: {
    kind: 'holder',
    references: [
      { path: 'principalId', matchBy: 'userId', action: 'deleteDocument', where: { principalType: 'user' } },
      { path: 'grantedByUserId', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  // Upload bookkeeping on a lake that may be org-owned, so the uploader is attribution, not ownership.
  DataLakeBatch: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'anonymize' }],
  },
  DataLakeCorpusAction: {
    kind: 'holder',
    references: [
      { path: 'actorUserId', matchBy: 'userId', action: 'anonymize' },
      {
        path: 'principal.principalId',
        matchBy: 'userId',
        action: 'anonymize',
        where: { 'principal.principalKind': 'user' },
      },
      { path: 'principal.onBehalfOfUserId', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  DataLakeFinding: {
    kind: 'holder',
    references: [
      { path: 'assigneeUserId', matchBy: 'userId', action: 'anonymize' },
      { path: 'resolvedByUserId', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  DataLakeHealthSnapshot: {
    kind: 'noUserData',
    note: 'Aggregate health counters per lake and day; names no person.',
  },
  DataLakeOwnershipOffer: {
    kind: 'holder',
    references: [
      { path: 'offeredByUserId', matchBy: 'userId', action: 'anonymize' },
      { path: 'recipientUserId', matchBy: 'userId', action: 'anonymize' },
      { path: 'priorOwnerUserIds', matchBy: 'userId', action: 'pullFromArray' },
      {
        path: 'auditPrincipal.principalId',
        matchBy: 'userId',
        action: 'anonymize',
        where: { 'auditPrincipal.principalKind': 'user' },
      },
      { path: 'auditPrincipal.onBehalfOfUserId', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  DataLakeProposal: {
    kind: 'holder',
    references: [{ path: 'reviewedByUserId', matchBy: 'userId', action: 'anonymize' }],
  },
  DataLakeResearchConfig: {
    kind: 'holder',
    references: [
      { path: 'createdByUserId', matchBy: 'userId', action: 'anonymize' },
      { path: 'lastUpdatedByUserId', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  DataLakeResearchRun: {
    kind: 'holder',
    references: [{ path: 'startedByUserId', matchBy: 'userId', action: 'anonymize' }],
  },
  DataLakeSpendNotification: {
    kind: 'holder',
    references: [{ path: 'recipientUserIds', matchBy: 'userId', action: 'pullFromArray' }],
  },
  DeepAgentCharter: {
    kind: 'holder',
    references: [{ path: 'identity.ownerUserId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  DeepAgentEpisode: {
    kind: 'viaParent',
    parent: 'DeepAgentCharter',
    foreignKey: 'agentId',
    parentKey: 'identity.agentId',
  },
  DeepAgentHandoff: {
    kind: 'viaParent',
    parent: 'DeepAgentCharter',
    foreignKey: 'agentId',
    parentKey: 'identity.agentId',
  },
  EmbedConversation: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  // Keyed by a content hash and shared across users: it cannot be resolved to a person by id.
  EmbeddingCache: {
    kind: 'pseudonymous',
    note: 'Embedding vectors keyed by a hash of the embedded text, shared across users and holding no user id.',
  },
  GenerationJob: {
    kind: 'holder',
    references: [
      { path: 'ownerId', matchBy: 'userId', action: 'deleteDocument', where: { ownerType: 'User' } },
      // On an org-owned job the requester is attribution on someone else's document.
      { path: 'requestedBy', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  LakeAccessEvent: {
    kind: 'holder',
    references: [
      { path: 'principalId', matchBy: 'userId', action: 'anonymize', where: { principalKind: 'user' } },
      { path: 'onBehalfOfUserId', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  // Shares its `_id` with the owning LakeAccessEvent.
  LakeAccessQueryText: { kind: 'viaParent', parent: 'LakeAccessEvent', foreignKey: '_id' },
  LakeConfigChangeEvent: {
    kind: 'holder',
    references: [
      { path: 'principalId', matchBy: 'userId', action: 'anonymize', where: { principalKind: 'user' } },
      { path: 'onBehalfOfUserId', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  LakeMembershipChangeEvent: {
    kind: 'holder',
    references: [
      { path: 'principalId', matchBy: 'userId', action: 'anonymize', where: { principalKind: 'user' } },
      { path: 'onBehalfOfUserId', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  LakeMembershipDecision: {
    kind: 'holder',
    references: [{ path: 'decidedByUserId', matchBy: 'userId', action: 'anonymize' }],
  },
  LakeMembershipRemoval: {
    kind: 'holder',
    references: [{ path: 'actorUserId', matchBy: 'userId', action: 'anonymize' }],
  },
  LakeSkippedFile: {
    kind: 'noUserData',
    note: 'Files a lake connector skipped, identified by source id and path; holds no user reference.',
  },
  LatticeModel: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    // A list of attribute names to group by, not people.
    unrelatedPaths: ['views.views.config.grouping.groupBy'],
  },
  McpConnection: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument', where: { ownerType: 'user' } },
      // An org-published definition carries no tokens; a userId on it is its creator.
      { path: 'userId', matchBy: 'userId', action: 'anonymize', where: { ownerType: 'org' } },
    ],
    secretPaths: [
      'urlEnc',
      'auth.oauth.manualClientIdEnc',
      'auth.oauth.manualClientSecretEnc',
      'auth.oauth.accessTokenEnc',
      'auth.oauth.refreshTokenEnc',
      'auth.apiKey.valueEnc',
    ],
  },
  McpOAuthClientRegistration: {
    kind: 'noUserData',
    note: 'One dynamic client registration per authorization server and redirect URI, shared by all users; no user field.',
  },
  McpOAuthPending: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    secretPaths: ['stateHash', 'codeVerifierEnc'],
  },
  McpServer: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    secretPaths: ['envVariables.value', 'metadata.webhooks.github.routingToken', 'metadata.webhooks.github.secret'],
    // The person's own GitHub handle and repo owner, removed with the document.
    unrelatedPaths: ['metadata.githubUserId', 'metadata.selectedRepositories.owner'],
  },
  // Deleting the key (MemoryPrincipalKey) crypto-shreds these; the rows themselves go too.
  MemoryLedgerEvent: {
    kind: 'holder',
    references: [
      { path: 'ownerUserId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'principalId', matchBy: 'userId', action: 'deleteDocument', where: { principalKind: 'user' } },
    ],
    secretPaths: ['factCipher', 'factIv', 'factTag', 'embeddingCipher', 'embeddingIv', 'embeddingTag'],
  },
  MemoryPrincipalKey: {
    kind: 'holder',
    references: [
      { path: 'ownerUserId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'principalId', matchBy: 'userId', action: 'deleteDocument', where: { principalKind: 'user' } },
    ],
    secretPaths: ['dek'],
  },
  ModelCatalog: {
    kind: 'noUserData',
    note: 'Model capability and pricing catalogue.',
  },
  ModelDiscoveryRun: {
    kind: 'noUserData',
    note: 'Log of the model discovery job against public aggregator sources.',
    // Model ids, not people.
    unrelatedPaths: ['lifecycleTransitions.replacedBy', 'catalogDiff.blockedBy'],
  },
  ModelDiscoveryState: {
    kind: 'noUserData',
    note: 'Per-model discovery bookkeeping.',
    unrelatedPaths: ['suggestion.replacedBy'],
  },
  NotebookCurationJob: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  RapidReplyAuditLog: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['userEmail', 'ipAddress', 'userAgent'] },
    ],
    // Redacted through alsoRedact above; it is the actor's email, not a reference.
    unrelatedPaths: ['userEmail'],
  },
  RapidReplyMapping: {
    kind: 'holder',
    references: [{ path: 'createdBy', matchBy: 'userId', action: 'anonymize' }],
  },
  RapidReplyPrompt: {
    kind: 'holder',
    references: [{ path: 'createdBy', matchBy: 'userId', action: 'anonymize' }],
  },
  RapidReplyResult: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  RepoHistoricalInsights: {
    kind: 'noUserData',
    note: 'Aggregate issue and PR statistics per repository; contributor handles are third-party GitHub profiles, not Bike4Mind users.',
  },
  ResearchAgent: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  ResearchTask: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  SessionAgentConfig: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  SessionToolApproval: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  Skill: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'users.userId', matchBy: 'userId', action: 'pullFromArray' },
    ],
  },
  SkillBundle: {
    kind: 'holder',
    references: [{ path: 'createdByUserId', matchBy: 'userId', action: 'anonymize' }],
  },
  // The author's own publication, so it goes with them (rule for authored items), even though others
  // may have imported it: their copies are independent Skill documents.
  SkillListing: {
    kind: 'holder',
    references: [{ path: 'authorUserId', matchBy: 'userId', action: 'deleteDocument' }],
    secretPaths: ['shareToken'],
  },
  SkillListingImport: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  SkillListingReport: {
    kind: 'holder',
    references: [
      { path: 'reporterId', matchBy: 'userId', action: 'anonymize' },
      { path: 'resolvedBy', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  // Version snapshots carry the author's skill body, so they follow the listing; reviewers are staff.
  SkillListingVersion: {
    kind: 'viaParent',
    parent: 'SkillListing',
    foreignKey: 'listingId',
    attribution: [
      { path: 'reviewerUserId', matchBy: 'userId', action: 'anonymize' },
      { path: 'auditedByUserId', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  ToolDefinitionOverride: {
    kind: 'holder',
    references: [
      { path: 'createdBy', matchBy: 'userId', action: 'anonymize' },
      { path: 'lastUpdatedBy', matchBy: 'userId', action: 'anonymize', alsoRedact: ['lastUpdatedByName'] },
    ],
  },
  // Execution telemetry (tool name, timing, error text): kept as platform health data with the identity link removed.
  ToolExecutionLog: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'anonymize' }],
  },
  ToolModel: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'users.userId', matchBy: 'userId', action: 'pullFromArray' },
    ],
  },
  TransformBatch: {
    kind: 'holder',
    references: [{ path: 'ownerUserId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  WorkItem: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
} satisfies DataHolderRegistry;
