import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@server/utils/thinkingVisibility', () => ({ resolveThinkingVisibility: vi.fn(async () => 'raw') }));

const mocks = vi.hoisted(() => ({
  fetchAndConvertFabFiles: vi.fn(),
  findExistingIdsIncludingDeletedByIds: vi.fn(),
  findExistingIdsByIds: vi.fn(),
  pullKnowledgeIds: vi.fn(),
  pullKnowledgeIdsFromSession: vi.fn(),
}));

vi.mock('sst', () => {
  const benignStub: ProxyHandler<object> = {
    get(_, key) {
      if (key === 'then') return undefined;
      return `mock-${String(key)}`;
    },
  };
  return {
    Resource: new Proxy({} as Record<string, unknown>, {
      get() {
        return new Proxy({}, benignStub);
      },
    }),
  };
});

vi.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: class {
    send() {
      return Promise.resolve({});
    }
  },
  PostToConnectionCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  fetchAndConvertFabFiles: mocks.fetchAndConvertFabFiles,
}));

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ delete: vi.fn(), upload: vi.fn(), getSignedUrl: vi.fn() }),
}));

vi.mock('@bike4mind/fab-pipeline', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/fab-pipeline')>()),
  // The embedding stack is beside the point here; the extraction call is stubbed below anyway.
  EmbeddingFactory: class {
    constructor(public config: unknown) {}
  },
  resolveEmbeddingWithKeylessFallback: () => ({ config: {}, missing: null }),
}));

vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return {
    ...actual,
    adminSettingsRepository: {
      ...actual.adminSettingsRepository,
      getSettingsValue: vi.fn().mockResolvedValue(undefined),
    },
    fabFileRepository: {
      ...actual.fabFileRepository,
      findExistingIdsIncludingDeletedByIds: mocks.findExistingIdsIncludingDeletedByIds,
      findExistingIdsByIds: mocks.findExistingIdsByIds,
    },
    sessionRepository: {
      ...actual.sessionRepository,
      pullKnowledgeIds: mocks.pullKnowledgeIds,
      pullKnowledgeIdsFromSession: mocks.pullKnowledgeIdsFromSession,
    },
  };
});

// Extraction is stubbed: the scrub takes the extractor's unresolved notices as its input, and the
// extractor itself has its own suite.
vi.mock('./agentExecutor.attachmentContent', async importOriginal => ({
  ...(await importOriginal<typeof import('./agentExecutor.attachmentContent')>()),
  materializeAttachmentContent: vi.fn(async (_files: unknown[], missingIds: string[]) => ({
    text: '',
    imageBlocks: [],
    inlinedFileIds: [],
    delivery: undefined,
    notices: missingIds.map(fabFileId => ({
      fabFileId,
      fileName: fabFileId,
      band: 'unresolved',
      message: 'not found',
      delivered: false,
    })),
  })),
}));

import { materializeAttachmentsForRun } from './agentExecutor';

const SOFT_DELETED = '507f1f77bcf86cd799439301';
const GONE = '507f1f77bcf86cd799439302';

const modelInfo = { id: 'test-model', contextWindow: 100_000, max_tokens: 4096 } as never;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), updateMetadata: vi.fn() } as never;

const run = (over: { sessionKnowledgeIds: string[]; sessionId?: string; onKnowledgeIdsScrubbed?: unknown }) =>
  materializeAttachmentsForRun({
    execution: { userId: 'user-1', sessionId: over.sessionId, query: 'question' },
    sessionKnowledgeIds: over.sessionKnowledgeIds,
    scope: {},
    lakeAccess: {} as never,
    modelInfo,
    apiKeyTable: {} as never,
    logger,
    onKnowledgeIdsScrubbed: over.onKnowledgeIdsScrubbed as never,
  });

describe('materializeAttachmentsForRun stale-reference scrub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchAndConvertFabFiles.mockResolvedValue({ files: [], missingIds: [SOFT_DELETED] });
    mocks.findExistingIdsIncludingDeletedByIds.mockResolvedValue([SOFT_DELETED]);
    mocks.findExistingIdsByIds.mockResolvedValue([]);
    mocks.pullKnowledgeIds.mockResolvedValue(1);
    mocks.pullKnowledgeIdsFromSession.mockResolvedValue(true);
  });

  it('detaches a soft-deleted pinned id from the execution session and reports it for trimming', async () => {
    const onKnowledgeIdsScrubbed = vi.fn();

    await run({ sessionKnowledgeIds: [SOFT_DELETED], sessionId: 'session-1', onKnowledgeIdsScrubbed });

    expect(mocks.pullKnowledgeIdsFromSession).toHaveBeenCalledWith('session-1', [SOFT_DELETED]);
    // Without this the first-iteration preamble would still list the file the scrub just detached.
    expect(onKnowledgeIdsScrubbed).toHaveBeenCalledWith([SOFT_DELETED]);
  });

  it('pulls a missing pinned id fleet-wide and reports it, with or without a session id', async () => {
    mocks.fetchAndConvertFabFiles.mockResolvedValue({ files: [], missingIds: [GONE] });
    mocks.findExistingIdsIncludingDeletedByIds.mockResolvedValue([]);
    const onKnowledgeIdsScrubbed = vi.fn();

    await run({ sessionKnowledgeIds: [GONE], onKnowledgeIdsScrubbed });

    expect(mocks.pullKnowledgeIds).toHaveBeenCalledWith([GONE]);
    expect(mocks.pullKnowledgeIdsFromSession).not.toHaveBeenCalled();
    expect(onKnowledgeIdsScrubbed).toHaveBeenCalledWith([GONE]);
  });

  it('keeps a soft-deleted id when no session id is available to scope the write to', async () => {
    const onKnowledgeIdsScrubbed = vi.fn();

    await run({ sessionKnowledgeIds: [SOFT_DELETED], onKnowledgeIdsScrubbed });

    expect(mocks.pullKnowledgeIdsFromSession).not.toHaveBeenCalled();
    expect(mocks.pullKnowledgeIds).not.toHaveBeenCalled();
    expect(onKnowledgeIdsScrubbed).not.toHaveBeenCalled();
  });
});
