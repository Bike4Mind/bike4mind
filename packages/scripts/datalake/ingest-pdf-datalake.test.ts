import { describe, it, expect, vi, beforeEach } from 'vitest';

type FabFileDoc = { _id: string; fileName: string; userId: string };

const mockFind = vi.fn();
const mockUpdateOne = vi.fn();
const mockSend = vi.fn();

// requeueStragglers's own imports, stubbed to the minimum needed to import the module without
// running any real DB/AWS logic - see the entrypoint guard in ingest-pdf-datalake.ts, which is
// what makes importing this module for a test safe in the first place (#1802 follow-up).
vi.mock('@bike4mind/database', () => ({
  buildDataLakeMembershipFilter: () => ({}),
  connectDB: vi.fn(),
  adminSettingsRepository: {},
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  fabFileRepository: {},
  FabFile: {
    find: (...args: unknown[]) => mockFind(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
  Organization: {},
  User: {},
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {},
  fabFilesService: {},
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: vi.fn(),
  getSettingsValue: vi.fn(),
}));
vi.mock('@bike4mind/common', () => ({
  DATA_LAKES: [],
  KnowledgeType: { FILE: 'file' },
}));
vi.mock('sst', () => ({
  Resource: { fabFileChunkQueue: { url: 'https://sqs.test/fabFileChunkQueue' }, MONGODB_URI: { value: '' }, App: {} },
}));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn().mockImplementation(function (this: { send: (...args: unknown[]) => unknown }) {
    this.send = (...args: unknown[]) => mockSend(...args);
  }),
  SendMessageCommand: vi.fn().mockImplementation(function (this: { input: unknown }, input: unknown) {
    this.input = input;
  }),
}));

import { requeueStragglers, type Options } from './ingest-pdf-datalake';
import type { LakeTarget } from './ingestPlan';

const lake: LakeTarget = {
  source: 'db',
  slug: 'test-lake',
  name: 'Test Lake',
  datalakeTag: 'datalake:test-lake',
  id: 'lake-1',
};

const baseOpts: Options = {
  slug: 'test-lake',
  userId: 'u1',
  concurrency: 4,
  execute: true,
  status: false,
  requeueStragglers: true,
  requeueLimit: 50,
};

const findReturning = (docs: FabFileDoc[]) => ({
  sort: () => ({
    limit: () => ({
      lean: () => Promise.resolve(docs),
    }),
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateOne.mockResolvedValue({});
  mockSend.mockResolvedValue({});
});

describe('requeueStragglers (#1802 follow-up: narrowed reset)', () => {
  it('never writes the worker-owned claim fields (isChunking/chunkClaimedAt)', async () => {
    mockFind.mockReturnValue(findReturning([{ _id: 'f1', fileName: 'a.pdf', userId: 'u1' }]));

    await requeueStragglers(lake, baseOpts);

    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    const [, update] = mockUpdateOne.mock.calls[0];
    expect(update.$set).not.toHaveProperty('isChunking');
    expect(update.$set).not.toHaveProperty('chunkClaimedAt');
  });

  it('still resets the reprocess-marker fields, so a fixed extraction can actually re-chunk', async () => {
    mockFind.mockReturnValue(findReturning([{ _id: 'f1', fileName: 'a.pdf', userId: 'u1' }]));

    await requeueStragglers(lake, baseOpts);

    const [, update] = mockUpdateOne.mock.calls[0];
    expect(update.$set).toEqual({
      chunked: false,
      chunkCount: 0,
      vectorized: false,
      vectorizedChunkCount: 0,
      notes: '',
      error: null,
    });
  });

  it('resets and enqueues every selected straggler exactly once, in order', async () => {
    mockFind.mockReturnValue(
      findReturning([
        { _id: 'f1', fileName: 'a.pdf', userId: 'u1' },
        { _id: 'f2', fileName: 'b.pdf', userId: 'u2' },
      ])
    );

    await requeueStragglers(lake, baseOpts);

    expect(mockUpdateOne).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledTimes(2);
    const bodies = mockSend.mock.calls.map(([cmd]) => JSON.parse(cmd.input.MessageBody));
    expect(bodies).toEqual([
      { fabFileId: 'f1', userId: 'u1' },
      { fabFileId: 'f2', userId: 'u2' },
    ]);
  });

  it('dry-run (execute: false) performs zero writes and zero sends', async () => {
    mockFind.mockReturnValue(findReturning([{ _id: 'f1', fileName: 'a.pdf', userId: 'u1' }]));

    const result = await requeueStragglers(lake, { ...baseOpts, execute: false });

    expect(result).toBe(0);
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('no stragglers found performs zero writes and zero sends', async () => {
    mockFind.mockReturnValue(findReturning([]));

    const result = await requeueStragglers(lake, baseOpts);

    expect(result).toBe(0);
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
