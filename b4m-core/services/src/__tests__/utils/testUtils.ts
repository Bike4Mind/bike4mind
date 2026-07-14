import {
  IBaseRepository,
  IProjectDocument,
  IProjectRepository,
  IShareableStaticMethods,
  IFabFileRepository,
  IFabFileDocument,
  ISessionRepository,
  ISessionDocument,
  IUserRepository,
  IUserDocument,
  IOrganizationRepository,
  IOrganizationDocument,
  ICreditTransactionRepository,
  ICreditTransactionDocument,
} from '@bike4mind/common';
import {
  IResearchTask,
  ResearchTaskStatus,
  ResearchTaskType,
  ResearchTaskExecutionType,
  IResearchAgent,
} from '@bike4mind/common';
import { MockedFunction, MockedObject, vi } from 'vitest';

export const createMockRepository = <T>(): IBaseRepository<T> => ({
  findById: vi.fn(),
  findOne: vi.fn(),
  find: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  updateMany: vi.fn(),
  count: vi.fn(),
});

export const createMockShareableRepository = <T>(): IShareableStaticMethods<T> => ({
  findAllAccessible: vi.fn(),
  findAllShared: vi.fn(),
  findAccessibleById: vi.fn(),
  findAllAccessibleByIds: vi.fn(),
  findUpdateAccessById: vi.fn(),
  findShareAccessById: vi.fn(),
});

export const createMockProjectRepository = (): IProjectRepository => ({
  ...createMockRepository<IProjectDocument>(),
  shareable: createMockShareableRepository<IProjectDocument>(),
  findByIdAndUserId: vi.fn(),
  searchAccessible: vi.fn(),
  removeSession: vi.fn(),
  findAllBySessionId: vi.fn(),
});

export const createMockFabFileRepository = (): IFabFileRepository => ({
  ...createMockRepository<IFabFileDocument>(),
  shareable: createMockShareableRepository<IFabFileDocument>(),
  getAccessibleFiles: vi.fn(),
  findByIdAndUserId: vi.fn(),
  findAllInIds: vi.fn(),
  deleteManyInIds: vi.fn(),
  findAllByIds: vi.fn(),
  search: vi.fn(),
  executeSearch: vi.fn(),
  countByUserIdAndTag: vi.fn(),
  countFilesByTagForUser: vi.fn(),
  countDataLakeTagsByPrefix: vi.fn(),
  countDataLakeUniqueFilesByPrefix: vi.fn(),
  countUniqueFilesByNamespaceForUser: vi.fn(),
  removeTagByUserId: vi.fn(),
  updateTagsByUserId: vi.fn(),
  pullTagByFabFileId: vi.fn(),
  findByContentHashes: vi.fn(),
  findByContentHashesInDataLake: vi.fn(),
  markFailedIfNotAlready: vi.fn(),
  computeDataLakeStats: vi.fn(),
  archiveByDataLakeTag: vi.fn(),
  unarchiveByDataLakeTag: vi.fn(),
  findArchivedByDataLakeTag: vi.fn(),
  findDeletedByDataLakeTag: vi.fn(),
  undeleteByDataLakeTag: vi.fn(),
  softDeleteByDataLakeTag: vi.fn(),
  hardDeleteByDataLakeTag: vi.fn(),
  findIdsByDataLakeTag: vi.fn(),
  findByUserId: vi.fn(),
});

export const createMockUser = (overrides = {}) => ({
  _id: 'test-user-id',
  email: 'test@example.com',
  name: 'Test User',
  ...overrides,
});

export const createMockAdapters = (overrides = {}) => ({
  db: {
    someRepo: createMockRepository(),
    ...overrides,
  },
});

export const createMockSessionRepository = (): MockedObject<ISessionRepository> =>
  vi.mocked({
    ...createMockRepository<ISessionDocument>(),
    shareable: createMockShareableRepository<ISessionDocument>(),
    upsertByOpenaiConversationId: vi.fn() as MockedFunction<ISessionRepository['upsertByOpenaiConversationId']>,
    upsertByClaudeConversationId: vi.fn() as MockedFunction<ISessionRepository['upsertByClaudeConversationId']>,
    search: vi.fn(),
    findByIdAndUserId: vi.fn(),
    findAllWithKnowledgeId: vi.fn(),
    searchByUserId: vi.fn(),
    findRecentlyUpdatedByUserId: vi.fn(),
    findAllByIds: vi.fn(),
    findSessionIdsByUserId: vi.fn(),
    attachAgent: vi.fn(),
    detachAgent: vi.fn(),
    getAttachedAgents: vi.fn(),
    addArtifact: vi.fn(),
    removeArtifact: vi.fn(),
    getAttachedArtifacts: vi.fn(),
    ensureMessageCount: vi.fn(),
    populateMessageCounts: vi.fn(),
    countByUserId: vi.fn(),
    countActiveVoiceSessionsByUserId: vi.fn(),
  });

export const createMockUserRepository = (): MockedObject<IUserRepository> =>
  vi.mocked({
    ...createMockRepository<IUserDocument>(),
    findByEmail: vi.fn(),
    findByIds: vi.fn(),
    findByUsernameOrEmail: vi.fn(),
    findByIdWithPassword: vi.fn(),
    findByEmailVerificationToken: vi.fn(),
    findByPendingEmailToken: vi.fn(),
    findAllByEmailsOrUsernames: vi.fn(),
    searchCollections: vi.fn(),
    findByStripeCustomerId: vi.fn(),
    incrementCredits: vi.fn(),
    incrementCurrentStorage: vi.fn(),
    findBySlackUserId: vi.fn(),
    findByIdWithNotionToken: vi.fn(),
    findByIdWithMfaSecrets: vi.fn(),
    atomicRecordMfaFailedAttempt: vi.fn(),
    findOrCreateByEmail: vi.fn(),
    recordModerationHit: vi.fn(),
    setModerationStatus: vi.fn(),
    recordModerationAppeal: vi.fn(),
  });

export const createMockOrganizationRepository = (): MockedObject<IOrganizationRepository> =>
  vi.mocked({
    ...createMockRepository<IOrganizationDocument>(),
    shareable: createMockShareableRepository<IOrganizationDocument>(),
    search: vi.fn(),
    findByStripeCustomerId: vi.fn(),
    findIdsAdministeredBy: vi.fn(),
    incrementCredits: vi.fn(),
    incrementCurrentStorage: vi.fn(),
    findByIdAndUserId: vi.fn(),
    updateUserDetails: vi.fn(),
  });

export const createMockCreditTransactionRepository = (): MockedObject<ICreditTransactionRepository> =>
  vi.mocked({
    ...createMockRepository<ICreditTransactionDocument>(),
    createTransaction: vi.fn() as MockedFunction<ICreditTransactionRepository['createTransaction']>,
    findByUserId: vi.fn(),
    findByPaymentIntentId: vi.fn(),
    updateTransactionStatus: vi.fn(),
    findByOwnerWithFilters: vi.fn(),
    queryLedgerPage: vi.fn(),
  });

/**
 * Mock a research task
 * @param value - Partial<IResearchTask> - The value to override the default data
 * @returns IResearchTask - The mock research task
 */
export const mockResearchTask = (value: Partial<IResearchTask> = {}): IResearchTask => {
  const baseTask = {
    id: 'test-task-id',
    userId: 'test-user-id',
    researchAgentId: 'test-research-agent-id',
    title: 'test-research-task-title',
    description: 'test-research-task-description',
    createdAt: new Date(),
    updatedAt: new Date(),
    status: ResearchTaskStatus.PENDING,
    executionType: ResearchTaskExecutionType.ON_DEMAND,
  };

  // Default to SCRAPE type with scrape-specific properties
  if (!value.type || value.type === ResearchTaskType.SCRAPE) {
    const scrapeTask = {
      ...baseTask,
      type: ResearchTaskType.SCRAPE,
      url: 'https://example.com',
      urls: ['https://example.com'],
      canDiscoverLinks: true,
      discoveredLinks: [],
      content: '',
    };
    return Object.assign(scrapeTask, value) as IResearchTask;
  }

  // Handle DEEP_RESEARCH type with deep research specific properties
  if (value.type === ResearchTaskType.DEEP_RESEARCH) {
    const deepResearchTask = {
      ...baseTask,
      type: ResearchTaskType.DEEP_RESEARCH,
      topic: 'test research topic',
      maxDepth: 7,
    };
    return Object.assign(deepResearchTask, value) as IResearchTask;
  }

  // Default fallback
  const mock = {
    ...baseTask,
    type: ResearchTaskType.SCRAPE,
    url: 'https://example.com',
    urls: ['https://example.com'],
    canDiscoverLinks: true,
    discoveredLinks: [],
    content: '',
  };

  return Object.assign(mock, value) as IResearchTask;
};

/**
 * Mock a research agent
 * @param value - Partial<IResearchAgent> - The value to override the default data
 * @returns IResearchAgent - The mock research agent
 */
export const mockResearchAgent = (value: Partial<IResearchAgent> = {}): IResearchAgent => {
  const mock = {
    id: 'test-agent-id',
    userId: 'test-user-id',
    name: 'test-research-agent-name',
    description: 'test-research-agent-description',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return Object.assign(mock, value) as IResearchAgent;
};
