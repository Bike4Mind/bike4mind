import { describe, it, expect, vi, beforeEach } from 'vitest';

type FabFileDoc = { _id: string; fileName: string; userId: string };

const mockFind = vi.fn();
const mockResetChunkState = vi.fn();
const mockSend = vi.fn();

// requeueStragglers's own imports, stubbed to the minimum needed to import the module without
// running any real DB/AWS logic - see the entrypoint guard in ingest-pdf-datalake.ts, which is
// what makes importing this module for a test safe in the first place (#1802 follow-up).
vi.mock('@bike4mind/database', () => ({
  buildDataLakeMembershipFilter: () => ({}),
  connectDB: vi.fn(),
  adminSettingsRepository: {},
  // Declared even though no test reaches the ingest path yet: the source imports it, and Vitest
  // throws on ACCESS of an undeclared export - so omitting it is a trap for whoever extends this
  // file to cover that path, not a saving.
  scopedSettingsRepository: {},
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  fabFileRepository: {
    resetChunkStateByIds: (...args: unknown[]) => mockResetChunkState(...args),
  },
  FabFile: {
    find: (...args: unknown[]) => mockFind(...args),
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
  CONVERGENCE_ORIGIN: 'convergence',
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
  // Default: every selected file resets cleanly, so the canonical method hands back what it was given.
  mockResetChunkState.mockImplementation((ids: string[]) => Promise.resolve(ids));
  mockSend.mockResolvedValue({});
});

describe('requeueStragglers', () => {
  // The reset is delegated rather than re-implemented here. The local copy had drifted off the
  // canonical write by omitting `chunkRebuildRequestedAt` (#1939's marker), so asserting the
  // delegation is what guards against a second shape reappearing; the write's own guarantees -
  // the isChunking:{$ne:true} precondition, chunkClaimedAt untouched, the stamp in the same write -
  // are covered against a real DB in packages/database's fabFileRebuildPassages.test.ts.
  it('resets via the canonical resetChunkStateByIds, passing every selected straggler', async () => {
    mockFind.mockReturnValue(
      findReturning([
        { _id: 'f1', fileName: 'a.pdf', userId: 'u1' },
        { _id: 'f2', fileName: 'b.pdf', userId: 'u2' },
      ])
    );

    await requeueStragglers(lake, baseOpts);

    expect(mockResetChunkState).toHaveBeenCalledTimes(1);
    expect(mockResetChunkState).toHaveBeenCalledWith(['f1', 'f2']);
  });

  // Without `origin`, the chunk handler defaults the message to `user` work and the kill switch
  // never applies - which silently exempted this bulk operator path from a set PauseLakeConvergence.
  it('stamps convergence provenance so the kill switch can halt a bulk run', async () => {
    mockFind.mockReturnValue(findReturning([{ _id: 'f1', fileName: 'a.pdf', userId: 'u1' }]));

    await requeueStragglers(lake, baseOpts);

    const body = JSON.parse(mockSend.mock.calls[0][0].input.MessageBody);
    expect(body).toEqual({ fabFileId: 'f1', userId: 'u1', origin: 'convergence', lakeId: 'lake-1' });
  });

  // A static lake has no document to hang a Lake-scope override on; the platform switch still
  // applies, and sending an undefined lakeId would only add a field the payload schema must ignore.
  it('omits lakeId for a lake that has none', async () => {
    mockFind.mockReturnValue(findReturning([{ _id: 'f1', fileName: 'a.pdf', userId: 'u1' }]));

    await requeueStragglers({ ...lake, id: undefined }, baseOpts);

    const body = JSON.parse(mockSend.mock.calls[0][0].input.MessageBody);
    expect(body).toEqual({ fabFileId: 'f1', userId: 'u1', origin: 'convergence' });
  });

  it('skips the enqueue for a file re-claimed between selection and the reset write', async () => {
    mockFind.mockReturnValue(
      findReturning([
        { _id: 'f1', fileName: 'a.pdf', userId: 'u1' },
        { _id: 'f2', fileName: 'b.pdf', userId: 'u2' },
      ])
    );
    // resetChunkStateByIds returns only the ids it actually changed: f1 was re-claimed by a live
    // worker, so its reset never landed and it must not be enqueued.
    mockResetChunkState.mockResolvedValue(['f2']);

    await requeueStragglers(lake, baseOpts);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockSend.mock.calls[0][0].input.MessageBody);
    expect(body.fabFileId).toBe('f2');
  });

  it('resets and enqueues every selected straggler exactly once, in order', async () => {
    mockFind.mockReturnValue(
      findReturning([
        { _id: 'f1', fileName: 'a.pdf', userId: 'u1' },
        { _id: 'f2', fileName: 'b.pdf', userId: 'u2' },
      ])
    );

    await requeueStragglers(lake, baseOpts);

    expect(mockSend).toHaveBeenCalledTimes(2);
    const bodies = mockSend.mock.calls.map(([cmd]) => JSON.parse(cmd.input.MessageBody));
    expect(bodies).toEqual([
      { fabFileId: 'f1', userId: 'u1', origin: 'convergence', lakeId: 'lake-1' },
      { fabFileId: 'f2', userId: 'u2', origin: 'convergence', lakeId: 'lake-1' },
    ]);
  });

  it('dry-run (execute: false) performs zero writes and zero sends', async () => {
    mockFind.mockReturnValue(findReturning([{ _id: 'f1', fileName: 'a.pdf', userId: 'u1' }]));

    await requeueStragglers(lake, { ...baseOpts, execute: false });

    expect(mockResetChunkState).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('no stragglers found performs zero writes and zero sends', async () => {
    mockFind.mockReturnValue(findReturning([]));

    await requeueStragglers(lake, baseOpts);

    expect(mockResetChunkState).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
