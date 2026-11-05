import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  find: vi.fn(),
  fileOptions: vi.fn(),
  otherFile: vi.fn(),
  personalWorkspace: vi.fn(),
  personalWorkspaces: vi.fn(),
  workspaceOptions: vi.fn(),
  appFind: vi.fn(),
  appDelete: vi.fn(),
  importFind: vi.fn(),
  importDelete: vi.fn(),
  fileDelete: vi.fn(),
  appStorageDelete: vi.fn(),
  importStorageDelete: vi.fn(),
  generatedDelete: vi.fn(),
  deletePrefix: vi.fn(),
  hardDelete: vi.fn(),
  indexModels: vi.fn(),
  indexDelete: vi.fn(),
  findLakes: vi.fn(),
  pickOwner: vi.fn(),
  deleteObjects: vi.fn(),
  findSessions: vi.fn(),
  openSearchEnabled: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  Organization: {
    exists: (...args: unknown[]) => ({
      setOptions: (options: unknown) => {
        h.workspaceOptions(options);
        return h.personalWorkspace(...args);
      },
    }),
    find: (...args: unknown[]) => ({
      setOptions: (options: unknown) => {
        h.workspaceOptions(options);
        return { select: () => h.personalWorkspaces(...args) };
      },
    }),
  },
  FabFile: {
    find: (...args: unknown[]) => ({
      setOptions: (options: unknown) => {
        h.fileOptions(options);
        return { sort: () => ({ limit: () => h.find(...args) }) };
      },
    }),
    findOne: (...args: unknown[]) => ({ setOptions: () => ({ select: () => h.otherFile(...args) }) }),
  },
  AppFile: {
    collection: {
      find: (...args: unknown[]) => ({ limit: () => ({ toArray: () => h.appFind(...args) }) }),
      deleteOne: h.appDelete,
    },
  },
  fabFileRepository: { hardDeleteWithChunks: h.hardDelete },
  fabFileChunkRepository: { distinctRetrievalIndexModelsByFabFileIds: h.indexModels },
  DataLakeModel: {},
  importHistoryJobRepository: {},
  mongoose: {
    model: () => ({ collection: { name: 'importHistoryJobs' } }),
    connection: {
      db: {
        collection: () => ({
          find: (...args: unknown[]) => ({ limit: () => ({ toArray: () => h.importFind(...args) }) }),
          deleteOne: h.importDelete,
        }),
      },
    },
  },
}));
vi.mock('@bike4mind/db-core', () => ({ selfHostOpenSearchEnabled: h.openSearchEnabled }));
vi.mock('@bike4mind/fab-pipeline', () => ({
  FabFileChunkSearchIndex: { deleteByFabFileIdOrThrow: h.indexDelete },
  S3Storage: class {
    deletePermanently = h.importStorageDelete;
  },
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { findMemberLakesForFile: h.findLakes },
  fabFilesService: { pickOwnerOrganizationId: h.pickOwner, deleteStoredObjects: h.deleteObjects },
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ deletePermanently: h.fileDelete, deletePrefixPermanently: h.deletePrefix }),
  getGeneratedImageStorage: () => ({ deletePermanently: h.generatedDelete }),
  getAppFilesStorage: () => ({ deletePermanently: h.appStorageDelete }),
}));
vi.mock('@server/files/generatedCopyStore', () => ({
  getGeneratedCopyStore: () => ({
    storage: { delete: h.generatedDelete },
    quests: { findSessionIdsByImage: h.findSessions },
  }),
}));
vi.mock('sst', () => ({ Resource: { historyImportBucket: { name: 'imports' } } }));

import { purgeAccountFiles } from './purgeAccountFiles';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const assertLease = vi.fn();
const options = { logger, assertLease };
const file = { id: 'f1', userId: 'u1', filePath: 'files/current', versions: [{ filePath: 'files/old' }] };

beforeEach(() => {
  vi.resetAllMocks();
  h.find.mockResolvedValue([]);
  h.personalWorkspaces.mockResolvedValue([]);
  h.appFind.mockResolvedValue([]);
  h.importFind.mockResolvedValue([]);
  h.findLakes.mockResolvedValue([]);
  h.otherFile.mockResolvedValue(null);
  h.indexModels.mockResolvedValue(['model-1']);
  h.deleteObjects.mockImplementation(
    async (
      files: { filePath?: string; sourceMetadata?: { generatedCopyKey?: string } }[],
      buckets: {
        files: { delete: (key: string) => Promise<void> };
        generated: { storage: { delete: (key: string) => Promise<void> } };
      }
    ) => {
      for (const row of files) {
        if (row.filePath) await buckets.files.delete(row.filePath);
        if (row.sourceMetadata?.generatedCopyKey)
          await buckets.generated.storage.delete(row.sourceMetadata.generatedCopyKey);
      }
    }
  );
});

describe('purgeAccountFiles', () => {
  it('deletes retained versions before current bytes, then chunks and row; also removes export ZIPs', async () => {
    h.find.mockResolvedValueOnce([file]);
    await purgeAccountFiles('u1', options);
    expect(h.fileDelete.mock.calls).toEqual([['files/old'], ['files/current']]);
    expect(h.hardDelete).toHaveBeenCalledWith('f1', 50, assertLease);
    expect(h.fileOptions).toHaveBeenCalledWith({ includeDeleted: true });
    expect(h.fileDelete.mock.invocationCallOrder[1]).toBeLessThan(h.hardDelete.mock.invocationCallOrder[0]);
    expect(h.deletePrefix).toHaveBeenCalledWith('exports/account-data/u1/');
    expect(h.find).toHaveBeenCalledWith(
      expect.objectContaining({ $or: [{ userId: 'u1' }, { organizationId: { $in: [] } }] })
    );
  });

  it('keeps the metadata retry locator when a retained version cannot be deleted', async () => {
    h.find.mockResolvedValueOnce([file]);
    h.fileDelete.mockRejectedValue(new Error('storage denied'));
    await expect(purgeAccountFiles('u1', options)).rejects.toThrow('storage denied');
    expect(h.deleteObjects).not.toHaveBeenCalled();
    expect(h.hardDelete).not.toHaveBeenCalled();
  });

  it('preserves moderation-held and legacy organization files', async () => {
    h.find.mockResolvedValueOnce([
      { ...file, moderationStatus: 'blocked' },
      { ...file, id: 'legacy' },
    ]);
    h.findLakes.mockResolvedValue([{ organizationId: 'org' }]);
    h.pickOwner.mockReturnValue('org');
    await purgeAccountFiles('u1', options);
    expect(h.fileDelete).not.toHaveBeenCalled();
    expect(h.hardDelete).not.toHaveBeenCalled();
    expect(h.findLakes).toHaveBeenCalledTimes(1);
    expect(h.find).toHaveBeenLastCalledWith(expect.objectContaining({ _id: { $gt: 'legacy' } }));
  });

  it('retains blocked file content, revision bytes, generated copies, chunks and metadata as moderation evidence', async () => {
    h.find.mockResolvedValueOnce([
      {
        ...file,
        moderationStatus: 'blocked',
        blockReason: 'illegal-content',
        sourceMetadata: { generatedCopyKey: 'held/generated' },
      },
    ]);
    await purgeAccountFiles('u1', options);
    expect(h.fileDelete).not.toHaveBeenCalled();
    expect(h.generatedDelete).not.toHaveBeenCalled();
    expect(h.deleteObjects).not.toHaveBeenCalled();
    expect(h.indexModels).not.toHaveBeenCalled();
    expect(h.indexDelete).not.toHaveBeenCalled();
    expect(h.hardDelete).not.toHaveBeenCalled();
  });

  it('purges files stamped to the personal workspace but preserves genuine organization files', async () => {
    h.find.mockResolvedValueOnce([
      { ...file, userId: 'other-uploader', organizationId: 'personal' },
      { ...file, id: 'org-file', organizationId: 'company' },
    ]);
    h.personalWorkspaces.mockResolvedValue([{ _id: 'personal', deletedAt: new Date() }]);
    h.personalWorkspace.mockResolvedValueOnce({ _id: 'personal' }).mockResolvedValueOnce(null);
    await purgeAccountFiles('u1', options);
    expect(h.hardDelete).toHaveBeenCalledExactlyOnceWith('f1', 50, assertLease);
    expect(h.personalWorkspace).toHaveBeenCalledWith({ _id: 'personal', userId: 'u1', personal: true });
    expect(h.workspaceOptions).toHaveBeenCalledWith({ includeDeleted: true });
    expect(h.workspaceOptions).toHaveBeenCalledTimes(3);
  });

  it('defers pending moderation before destroying possible evidence', async () => {
    h.find.mockResolvedValueOnce([{ ...file, moderationStatus: 'pending' }]);
    await expect(purgeAccountFiles('u1', options)).rejects.toThrow('waiting for moderation');
    expect(h.fileDelete).not.toHaveBeenCalled();
    expect(h.hardDelete).not.toHaveBeenCalled();
  });

  it('preserves original, revision and generated objects referenced by surviving files', async () => {
    h.find.mockResolvedValueOnce([{ ...file, sourceMetadata: { generatedCopyKey: 'generated/shared' } }]);
    h.otherFile.mockResolvedValue({ _id: 'other' });
    await purgeAccountFiles('u1', options);
    expect(h.fileDelete).not.toHaveBeenCalled();
    expect(h.generatedDelete).not.toHaveBeenCalled();
    expect(h.hardDelete).toHaveBeenCalledWith('f1', 50, assertLease);
  });

  it('keeps file metadata when strict self-host index cleanup fails', async () => {
    h.find.mockResolvedValueOnce([file]);
    h.openSearchEnabled.mockReturnValue(true);
    h.indexDelete.mockRejectedValue(new Error('index down'));
    await expect(purgeAccountFiles('u1', options)).rejects.toThrow('index down');
    expect(h.hardDelete).not.toHaveBeenCalled();
  });

  it('deletes AppFile and import ZIP bytes before their metadata, including import tombstones', async () => {
    h.appFind.mockResolvedValueOnce([{ _id: 'app', path: 'photos/avatar' }]);
    h.importFind.mockResolvedValueOnce([
      { _id: 'job', s3Bucket: 'imports', s3Key: 'u1/history.zip', deletedAt: new Date() },
    ]);
    await purgeAccountFiles('u1', options);
    expect(h.appStorageDelete).toHaveBeenCalledWith('photos/avatar');
    expect(h.importStorageDelete).toHaveBeenCalledWith('u1/history.zip');
    expect(h.appStorageDelete.mock.invocationCallOrder[0]).toBeLessThan(h.appDelete.mock.invocationCallOrder[0]);
    expect(h.importStorageDelete.mock.invocationCallOrder[0]).toBeLessThan(h.importDelete.mock.invocationCallOrder[0]);
  });

  it('keeps AppFile metadata on object deletion failure', async () => {
    h.appFind.mockResolvedValueOnce([{ _id: 'app', path: 'photos/avatar' }]);
    h.appStorageDelete.mockRejectedValue(new Error('app storage down'));
    await expect(purgeAccountFiles('u1', options)).rejects.toThrow('app storage down');
    expect(h.appDelete).not.toHaveBeenCalled();
  });

  it('stops before deleting objects when the purge lease is lost', async () => {
    assertLease.mockRejectedValue(new Error('lease lost'));
    await expect(purgeAccountFiles('u1', options)).rejects.toThrow('lease lost');
    expect(h.fileDelete).not.toHaveBeenCalled();
    expect(h.deletePrefix).not.toHaveBeenCalled();
  });
});
