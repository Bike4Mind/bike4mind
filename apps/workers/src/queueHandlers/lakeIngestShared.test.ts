import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  order: [] as string[],
  createFabFile: vi.fn(),
  recordLakeMembershipChange: vi.fn(),
  appendFiles: vi.fn(),
  upload: vi.fn(),
  markUploaded: vi.fn(),
  removeFileFromLake: vi.fn(),
  fabFileFindById: vi.fn(),
  findOtherLakeClaims: vi.fn(),
  loadPrefixArmCandidateLakes: vi.fn(),
  deleteFabFile: vi.fn(),
  sessionsWithKnowledgeId: vi.fn(),
  userRepoFindById: vi.fn(),
  userFindById: vi.fn(),
  changeStorageSize: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  User: { findById: h.userFindById },
  changeStorageSize: h.changeStorageSize,
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
  adminSettingsRepository: {},
  scopedSettingsRepository: {},
  dataLakeRepository: {},
  dataLakeBatchRepository: { appendFiles: h.appendFiles, findById: vi.fn(), setTotalFilesIfActive: vi.fn() },
  fabFileRepository: { findById: h.fabFileFindById, markUploaded: h.markUploaded, pushTagsByFabFileId: vi.fn() },
  fabFileChunkRepository: {},
  lakeMembershipChangeEventRepository: { record: vi.fn() },
  sessionRepository: { findAllWithKnowledgeId: h.sessionsWithKnowledgeId, update: vi.fn() },
  userRepository: { findById: h.userRepoFindById },
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    recordLakeMembershipChange: h.recordLakeMembershipChange,
    removeFileFromLake: h.removeFileFromLake,
    findOtherLakeClaims: h.findOtherLakeClaims,
    hasOtherLakeClaim: (claims: { metaTagNames: string[]; prefixArmLakes: unknown[] }) =>
      claims.metaTagNames.length > 0 || claims.prefixArmLakes.length > 0,
    loadPrefixArmCandidateLakes: h.loadPrefixArmCandidateLakes,
    assertLakeAdmission: vi.fn(),
    assertCanWriteDataLakeTags: vi.fn(),
  },
  fabFilesService: { deleteFabFile: h.deleteFabFile },
}));
vi.mock('@bike4mind/fab-pipeline', () => ({ FabFileChunkSearchIndex: {} }));
vi.mock('@bike4mind/db-core', () => ({ selfHostOpenSearchEnabled: () => false }));
vi.mock('@server/managers/fabFileManager', () => ({ createFabFile: h.createFabFile }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ upload: h.upload }) }));
vi.mock('@server/queueHandlers/dataLakeBatchProgress', () => ({ finalizeBatchIfComplete: vi.fn() }));

import { createLakeIngestRetirer, ingestLakeFile } from './lakeIngestShared';

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn() } as never;
const lake = { id: 'lake1', datalakeTag: 'datalake:lake1' } as never;
const membershipActor = { userId: 'u1', isAdmin: true };

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.createFabFile.mockImplementation(async () => (h.order.push('create'), { id: 'ff1' }));
  h.recordLakeMembershipChange.mockImplementation(async () => void h.order.push('record'));
  h.appendFiles.mockImplementation(async () => void h.order.push('append'));
  h.upload.mockImplementation(async () => void h.order.push('upload'));
  h.markUploaded.mockImplementation(async () => void h.order.push('mark'));
  h.removeFileFromLake.mockResolvedValue({ contentTags: [] });
  h.fabFileFindById.mockResolvedValue({ id: 'old', userId: 'u1', tags: [], users: [], groups: [] });
  h.findOtherLakeClaims.mockResolvedValue({ metaTagNames: [], prefixArmLakes: [] });
  h.loadPrefixArmCandidateLakes.mockResolvedValue([]);
  h.userRepoFindById.mockResolvedValue({ id: 'u1' });
  h.deleteFabFile.mockImplementation(async (_userId, _params, adapter) => {
    await adapter.onDeleteComplete?.({}, 100);
    return { action: 'deleted' };
  });
});

describe('ingestLakeFile', () => {
  it('creates, records membership, appends the manifest entry, uploads, then confirms, in that order', async () => {
    const result = await ingestLakeFile({
      data: {
        userId: 'u1',
        fileName: 'a.md',
        mimeType: 'text/markdown',
        filePath: 'k.md',
        relativePath: 'docs/a.md',
      } as never,
      ability: {} as never,
      lake,
      membershipActor,
      batchId: 'b1',
      bytes: Buffer.from('x'),
      fileKey: 'k.md',
      logger,
    });
    expect(result).toEqual({ id: 'ff1' });
    expect(h.order).toEqual(['create', 'record', 'append', 'upload', 'mark']);
    expect(h.appendFiles).toHaveBeenCalledWith('b1', [
      { fabFileId: 'ff1', fileName: 'a.md', relativePath: 'docs/a.md', status: 'pending' },
    ]);
    expect(h.upload).toHaveBeenCalledWith(Buffer.from('x'), 'k.md', { ContentType: 'text/markdown' });
  });
});

describe('createLakeIngestRetirer', () => {
  const retirer = () =>
    createLakeIngestRetirer({
      lake,
      membershipActor,
      replacementOwnerId: 'u1',
      candidateOwnerIds: ['u1'],
      logTag: '[test]',
      logger,
    });

  it('deletes a sole-lake copy with no replacement and carries nothing forward', async () => {
    const r = retirer();
    await expect(r.retireSupersededCopy({ id: 'old' } as never, null)).resolves.toBe('deleted');
    expect(h.removeFileFromLake).toHaveBeenCalled();
    expect(h.sessionsWithKnowledgeId).not.toHaveBeenCalled();
    expect(r.stagedReclaimFor('u1')).toBe(100);
  });

  it('only unpicks a copy shared outside its owner', async () => {
    h.fabFileFindById.mockResolvedValue({ id: 'old', userId: 'u1', tags: [], users: [{ userId: 'u2' }], groups: [] });
    await expect(retirer().retireSupersededCopy({ id: 'old' } as never, null)).resolves.toBe('unpicked');
    expect(h.deleteFabFile).not.toHaveBeenCalled();
  });

  it('flushes staged reclaim onto the owner re-read at flush time, then clears it', async () => {
    const save = vi.fn();
    h.userFindById.mockResolvedValue({ id: 'u1', save });
    const r = retirer();
    await r.retireSupersededCopy({ id: 'old' } as never, null);
    await r.flushReclaimedStorage();
    expect(h.changeStorageSize).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), -100);
    expect(save).toHaveBeenCalled();
    expect(r.stagedReclaimFor('u1')).toBe(0);
  });
});
