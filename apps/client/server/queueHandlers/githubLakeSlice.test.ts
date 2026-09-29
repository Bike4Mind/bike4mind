import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestError } from '@bike4mind/utils';
import { FabFileSourceType } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  order: [] as string[],
  getRecursiveTree: vi.fn(),
  getBlobBytes: vi.fn(),
  findByGitHubConnectionIdInDataLake: vi.fn(),
  batchFindById: vi.fn(),
  batchCreate: vi.fn(),
  setTotalFilesIfActive: vi.fn(),
  recordSkippedDriveFile: vi.fn(),
  retire: vi.fn(),
  flush: vi.fn(),
  ingest: vi.fn(),
  assertWrite: vi.fn(),
  getSettingsMap: vi.fn(),
  getSettingsValue: vi.fn(),
  checkStorageLimit: vi.fn(),
  recomputeLakeStats: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  dataLakeRepository: {},
  dataLakeBatchRepository: {
    findById: h.batchFindById,
    create: h.batchCreate,
    setTotalFilesIfActive: h.setTotalFilesIfActive,
    recordSkippedDriveFile: h.recordSkippedDriveFile,
  },
  fabFileRepository: { findByGitHubConnectionIdInDataLake: h.findByGitHubConnectionIdInDataLake },
}));
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  // Real getSettingsValue by default (its own MaxFileSize schema floors at 1 MB - same as the
  // hardcoded rule, so it can never be the smaller Math.min term); overridden per-test to drive
  // the min() itself below the hardcoded rule, independent of that floor.
  h.getSettingsValue.mockImplementation(actual.getSettingsValue as (...args: unknown[]) => unknown);
  return {
    ...actual,
    getSettingsMap: h.getSettingsMap,
    getSettingsValue: h.getSettingsValue,
    checkStorageLimit: h.checkStorageLimit,
  };
});
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    createDataLakeFallbackTagger: () => async (tags: unknown) => tags,
    recomputeLakeStats: h.recomputeLakeStats,
  },
}));
vi.mock('@server/auth/ability', () => ({ default: () => ({}) }));
vi.mock('@server/integrations/github/dataLake/lakeAppClient', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/integrations/github/dataLake/lakeAppClient')>()),
  getRecursiveTree: h.getRecursiveTree,
  getBlobBytes: h.getBlobBytes,
}));
vi.mock('@server/queueHandlers/lakeIngestShared', () => ({
  createLakeIngestRetirer: () => ({
    retireSupersededCopy: h.retire,
    flushReclaimedStorage: h.flush,
    stagedReclaimFor: () => 0,
  }),
  ingestLakeFile: h.ingest,
  assertConnectorLakeWrite: h.assertWrite,
}));

import { runGitHubLakeSlice, GITHUB_LAKE_DEADLINE_BUFFER_MS } from './githubLakeSlice';

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn() } as never;
const blob = (path: string, sha: string, size = 5) => ({ path, mode: '100644', type: 'blob', sha, size });
const stored = (id: string, githubPath: string, githubBlobSha: string, createdAt = '2026-01-01T00:00:00Z') => ({
  id,
  githubPath,
  githubBlobSha,
  createdAt: new Date(createdAt),
  userId: 'owner1',
});
const input = (over: Record<string, unknown> = {}) => ({
  octokit: {} as never,
  repoFullName: 'acme/docs',
  commitSha: 'c1',
  connection: { id: 'conn1', targetDataLakeId: 'lake1', connectedBy: 'owner1' } as never,
  lake: { id: 'lake1', datalakeTag: 'datalake:lake1' } as never,
  user: { id: 'owner1' } as never,
  remainingMs: () => 600_000,
  logger,
  ...over,
});
const tree = (...entries: ReturnType<typeof blob>[]) =>
  h.getRecursiveTree.mockResolvedValue({ truncated: false, entries });
const rateLimited = () =>
  Object.assign(new Error('rate limited'), {
    status: 403,
    response: {
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120) },
    },
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  tree();
  h.getSettingsMap.mockResolvedValue({});
  h.findByGitHubConnectionIdInDataLake.mockResolvedValue([]);
  h.getBlobBytes.mockImplementation(async (_o: unknown, _r: string, sha: string) => Buffer.from(`content of ${sha}`));
  h.batchCreate.mockResolvedValue({ id: 'batch1' });
  h.batchFindById.mockResolvedValue(null);
  h.recordSkippedDriveFile.mockResolvedValue(true);
  h.retire.mockImplementation(async (copy: { id: string }, replacement: string | null) => {
    h.order.push(`retire:${copy.id}->${replacement}`);
    return 'deleted';
  });
  let n = 0;
  h.ingest.mockImplementation(async ({ data }: { data: { githubPath: string } }) => {
    h.order.push(`ingest:${data.githubPath}`);
    return { id: `new${++n}` };
  });
  h.assertWrite.mockResolvedValue(undefined);
  h.checkStorageLimit.mockResolvedValue(undefined);
  h.recomputeLakeStats.mockResolvedValue(undefined);
  h.flush.mockResolvedValue(undefined);
});

describe('runGitHubLakeSlice', () => {
  it('refuses a truncated tree before any write', async () => {
    h.getRecursiveTree.mockResolvedValue({ truncated: true, entries: [blob('a.md', 's1')] });
    h.findByGitHubConnectionIdInDataLake.mockResolvedValue([stored('old', 'gone.md', 's0')]);
    await expect(runGitHubLakeSlice(input())).resolves.toEqual({
      kind: 'refused',
      batchId: null,
      message: expect.stringContaining('too large'),
    });
    expect(h.retire).not.toHaveBeenCalled();
    expect(h.ingest).not.toHaveBeenCalled();
    expect(h.batchCreate).not.toHaveBeenCalled();
  });

  it('refuses over 5000 candidates before any write, removals included', async () => {
    tree(...Array.from({ length: 5001 }, (_, i) => blob(`f${i}.md`, `s${i}`)));
    h.findByGitHubConnectionIdInDataLake.mockResolvedValue([stored('old', 'gone.md', 's0')]);
    await expect(runGitHubLakeSlice(input())).resolves.toMatchObject({
      kind: 'refused',
      message: expect.stringContaining('5000'),
    });
    expect(h.retire).not.toHaveBeenCalled();
    expect(h.batchCreate).not.toHaveBeenCalled();
  });

  it('removes first, then ingests, and retires a changed file only after its replacement uploaded', async () => {
    tree(blob('keep.md', 's1'), blob('edit.md', 's2-new'), blob('new.md', 's3'));
    h.findByGitHubConnectionIdInDataLake.mockResolvedValue([
      stored('keep', 'keep.md', 's1'),
      stored('edit', 'edit.md', 's2-old'),
      stored('gone', 'gone.md', 's4'),
    ]);
    await expect(runGitHubLakeSlice(input())).resolves.toEqual({ kind: 'done', batchId: 'batch1', transientSkips: 0 });
    expect(h.order).toEqual(['retire:gone->null', 'ingest:new.md', 'ingest:edit.md', 'retire:edit->new2']);
    expect(h.batchCreate).toHaveBeenCalledWith(
      expect.objectContaining({ dataLakeId: 'lake1', userId: 'owner1', totalFiles: 2 })
    );
    expect(h.recomputeLakeStats).toHaveBeenCalled();
    expect(h.flush).toHaveBeenCalled();
  });

  it('stamps GitHub provenance on every created file', async () => {
    tree(blob('src/index.ts', 's9'));
    await runGitHubLakeSlice(input());
    expect(h.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId: 'batch1',
        data: expect.objectContaining({
          sourceType: FabFileSourceType.GITHUB,
          githubConnectionId: 'conn1',
          githubPath: 'src/index.ts',
          githubBlobSha: 's9',
          sourceLakeId: 'lake1',
          relativePath: 'src/index.ts',
          userId: 'owner1',
          fileName: 'index.ts',
          mimeType: 'text/plain',
          batchId: 'batch1',
          tags: [{ name: 'datalake:lake1', strength: 1 }],
        }),
      })
    );
  });

  it('keeps the old copy when the replacement upload fails', async () => {
    tree(blob('edit.md', 's2-new'));
    h.findByGitHubConnectionIdInDataLake.mockResolvedValue([stored('edit', 'edit.md', 's2-old')]);
    h.ingest.mockRejectedValue(new Error('upload failed'));
    await expect(runGitHubLakeSlice(input())).rejects.toThrow('upload failed');
    expect(h.retire).not.toHaveBeenCalled();
    expect(h.flush).toHaveBeenCalled();
  });

  it('retires duplicates of a live path into the newest copy', async () => {
    tree(blob('a.md', 's1'));
    h.findByGitHubConnectionIdInDataLake.mockResolvedValue([
      stored('a-old', 'a.md', 's1', '2026-01-01T00:00:00Z'),
      stored('a-new', 'a.md', 's1', '2026-02-01T00:00:00Z'),
    ]);
    await expect(runGitHubLakeSlice(input())).resolves.toEqual({ kind: 'done', batchId: null, transientSkips: 0 });
    expect(h.order).toEqual(['retire:a-old->a-new']);
  });

  it('yields on the deadline before starting a file', async () => {
    tree(blob('a.md', 's1'), blob('b.md', 's2'));
    const out = await runGitHubLakeSlice(input({ remainingMs: () => GITHUB_LAKE_DEADLINE_BUFFER_MS - 1 }));
    expect(out).toEqual({ kind: 'deadline', batchId: 'batch1', remaining: 2 });
    expect(h.getBlobBytes).not.toHaveBeenCalled();
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('yields on the deadline mid-removal, after retiring what fits', async () => {
    tree();
    h.findByGitHubConnectionIdInDataLake.mockResolvedValue([
      stored('gone1', 'gone1.md', 's1'),
      stored('gone2', 'gone2.md', 's2'),
    ]);
    let calls = 0;
    const remainingMs = () => (calls++ === 0 ? 600_000 : GITHUB_LAKE_DEADLINE_BUFFER_MS - 1);
    const out = await runGitHubLakeSlice(input({ remainingMs }));
    expect(out).toEqual({ kind: 'deadline', batchId: null, remaining: 1 });
    expect(h.order).toEqual(['retire:gone1->null']);
    expect(h.flush).toHaveBeenCalled();
    expect(h.recomputeLakeStats).toHaveBeenCalled();
  });

  it('yields on the deadline mid-duplicate-retire, after retiring what fits', async () => {
    tree(blob('a.md', 's1'), blob('b.md', 's2'));
    h.findByGitHubConnectionIdInDataLake.mockResolvedValue([
      stored('a-old', 'a.md', 's1', '2026-01-01T00:00:00Z'),
      stored('a-new', 'a.md', 's1', '2026-02-01T00:00:00Z'),
      stored('b-old', 'b.md', 's2', '2026-01-01T00:00:00Z'),
      stored('b-new', 'b.md', 's2', '2026-02-01T00:00:00Z'),
    ]);
    let calls = 0;
    const remainingMs = () => (calls++ === 0 ? 600_000 : GITHUB_LAKE_DEADLINE_BUFFER_MS - 1);
    const out = await runGitHubLakeSlice(input({ remainingMs }));
    expect(out).toEqual({ kind: 'deadline', batchId: null, remaining: 1 });
    expect(h.order).toEqual(['retire:a-old->a-new']);
    expect(h.flush).toHaveBeenCalled();
    expect(h.recomputeLakeStats).toHaveBeenCalled();
  });

  it('yields the rest of the slice when a blob fetch is rate-limited', async () => {
    tree(blob('a.md', 's1'), blob('b.md', 's2'));
    h.getBlobBytes.mockResolvedValueOnce(Buffer.from('ok')).mockRejectedValueOnce(rateLimited());
    const out = await runGitHubLakeSlice(input());
    expect(out).toMatchObject({ kind: 'rate_limited', batchId: 'batch1', remaining: 1 });
    expect((out as { delaySeconds: number }).delaySeconds).toBeGreaterThanOrEqual(119);
    expect((out as { delaySeconds: number }).delaySeconds).toBeLessThanOrEqual(120);
  });

  it('reports a rate-limited tree read with no batch to hand off', async () => {
    h.getRecursiveTree.mockRejectedValue(rateLimited());
    await expect(runGitHubLakeSlice(input())).resolves.toMatchObject({
      kind: 'rate_limited',
      batchId: null,
      remaining: 0,
    });
  });

  it('records a binary or non-UTF-8 file as a permanent chain skip', async () => {
    tree(blob('bin.md', 's1'), blob('latin1.txt', 's2'));
    h.getBlobBytes.mockResolvedValueOnce(Buffer.from([0x61, 0x00])).mockResolvedValueOnce(Buffer.from([0xc3, 0x28]));
    await expect(runGitHubLakeSlice(input())).resolves.toEqual({ kind: 'done', batchId: 'batch1', transientSkips: 0 });
    expect(h.recordSkippedDriveFile).toHaveBeenCalledWith('batch1', 'bin.md');
    expect(h.recordSkippedDriveFile).toHaveBeenCalledWith('batch1', 'latin1.txt');
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('records an oversized tree entry as a permanent skip with its size, without fetching it', async () => {
    tree(blob('big.md', 's1', 2 * 1024 * 1024), blob('small.md', 's2', 5));
    await expect(runGitHubLakeSlice(input())).resolves.toEqual({ kind: 'done', batchId: 'batch1', transientSkips: 0 });
    expect(h.batchCreate).toHaveBeenCalledWith(expect.objectContaining({ totalFiles: 2 }));
    expect(h.recordSkippedDriveFile).toHaveBeenCalledWith('batch1', 'big.md');
    expect(h.getBlobBytes).toHaveBeenCalledTimes(1);
    expect(h.getBlobBytes).toHaveBeenCalledWith(expect.anything(), expect.anything(), 's2');
    expect(h.ingest).toHaveBeenCalledTimes(1);
  });

  it('logs oversized files but creates no batch, claim check, or skip record when there is no other sync work', async () => {
    tree(blob('big1.md', 's1', 2 * 1024 * 1024), blob('big2.md', 's2', 3 * 1024 * 1024));
    await expect(runGitHubLakeSlice(input())).resolves.toEqual({ kind: 'done', batchId: null, transientSkips: 0 });
    expect(h.batchCreate).not.toHaveBeenCalled();
    expect(h.assertWrite).not.toHaveBeenCalled();
    expect(h.recordSkippedDriveFile).not.toHaveBeenCalled();
    expect(h.getBlobBytes).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      '[githubLakeIngest] oversized files with no other sync work this run; not recorded',
      expect.objectContaining({ count: 2 })
    );
  });

  it('records an oversized skip when the admin MaxFileSize setting lowers the cap below 1 MB', async () => {
    // MaxFileSize's real settings schema floors at 1 MB (equal to the hardcoded rule), so it can
    // never itself be lower - stub the resolved value directly to exercise the min() computation.
    h.getSettingsValue.mockReturnValueOnce(0.5);
    tree(blob('big.md', 's1', 600_000), blob('small.md', 's2', 5));
    await expect(runGitHubLakeSlice(input())).resolves.toEqual({ kind: 'done', batchId: 'batch1', transientSkips: 0 });
    expect(h.batchCreate).toHaveBeenCalledWith(expect.objectContaining({ totalFiles: 2 }));
    expect(h.recordSkippedDriveFile).toHaveBeenCalledWith('batch1', 'big.md');
    expect(h.getBlobBytes).toHaveBeenCalledTimes(1);
    expect(h.getBlobBytes).toHaveBeenCalledWith(expect.anything(), expect.anything(), 's2');
    expect(h.ingest).toHaveBeenCalledTimes(1);
  });

  it('counts a storage-limit skip as transient and does not record it for the chain', async () => {
    tree(blob('a.md', 's1'));
    h.checkStorageLimit.mockRejectedValue(new BadRequestError('File size exceeds storage limit'));
    await expect(runGitHubLakeSlice(input())).resolves.toEqual({ kind: 'done', batchId: 'batch1', transientSkips: 1 });
    expect(h.recordSkippedDriveFile).not.toHaveBeenCalled();
  });

  it('adopts the chain s batch and subtracts the paths it already skipped', async () => {
    tree(blob('bin.md', 's1'), blob('new.md', 's2'));
    h.batchFindById.mockResolvedValue({
      id: 'batch9',
      dataLakeId: 'lake1',
      status: 'processing',
      totalFiles: 1,
      files: [{ fabFileId: 'x', fileName: 'x', status: 'pending' }],
      skippedFiles: 1,
      skippedDriveFileIds: ['bin.md'],
    });
    await runGitHubLakeSlice(input({ resumeBatchId: 'batch9' }));
    expect(h.batchCreate).not.toHaveBeenCalled();
    expect(h.order).toEqual(['ingest:new.md']);
    expect(h.setTotalFilesIfActive).toHaveBeenCalledWith('batch9', 3);
  });

  it('refuses when the lake refuses connector writes, after applying removals', async () => {
    tree(blob('a.md', 's1'));
    h.findByGitHubConnectionIdInDataLake.mockResolvedValue([stored('gone', 'gone.md', 's0')]);
    h.assertWrite.mockRejectedValue(new BadRequestError('This lake is curated'));
    await expect(runGitHubLakeSlice(input())).resolves.toEqual({
      kind: 'refused',
      batchId: null,
      message: 'This lake is curated',
    });
    expect(h.order).toEqual(['retire:gone->null']);
    expect(h.batchCreate).not.toHaveBeenCalled();
  });
});
