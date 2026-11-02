import { describe, it, expect, vi, beforeEach } from 'vitest';

const captured = vi.hoisted(() => ({ handlers: {} as Record<string, any> }));
const cleanup = vi.hoisted(() => ({
  groupDeletedFileReferences: vi.fn(),
  cleanUpDeletedFileReferences: vi.fn(),
  pullKnowledgeIdsForUsers: vi.fn(),
  pullSystemFilesForUsers: vi.fn(),
  pullFileReferences: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  FabFile: { find: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
  User: { findById: vi.fn() },
  adminSettingsRepository: {},
  fabFileRepository: {},
  projectRepository: { pullFileReferences: cleanup.pullFileReferences },
  sessionRepository: { pullKnowledgeIdsForUsers: cleanup.pullKnowledgeIdsForUsers },
  userRepository: { pullSystemFilesForUsers: cleanup.pullSystemFilesForUsers },
  withTransaction: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn('txn')),
}));

// The real stored-object delete, so the legal-hold and generated-copy rules run against this route's
// projection; the real reference cleanup too, behind spies a test can make fail.
vi.mock('@bike4mind/services', async importOriginal => {
  const { fabFilesService } = await importOriginal<typeof import('@bike4mind/services')>();
  cleanup.groupDeletedFileReferences.mockImplementation(fabFilesService.groupDeletedFileReferences);
  cleanup.cleanUpDeletedFileReferences.mockImplementation(fabFilesService.cleanUpDeletedFileReferences);
  return {
    fabFilesService: {
      deleteStoredObjects: fabFilesService.deleteStoredObjects,
      deletedFileReferences: fabFilesService.deletedFileReferences,
      groupDeletedFileReferences: cleanup.groupDeletedFileReferences,
      cleanUpDeletedFileReferences: cleanup.cleanUpDeletedFileReferences,
    },
  };
});
vi.mock('@server/files/generatedCopyStore', () => ({
  getGeneratedCopyStore: () => ({
    storage: { delete: generatedDelete },
    quests: { findSessionIdsByImage: async () => [] },
  }),
}));

// The caller holds delete on their own file and on a file shared in from another owner - the
// scope the endpoint used to hard-delete wholesale.
vi.mock('@casl/mongoose', () => ({
  accessibleBy: () => ({ ofType: () => ({ __deleteScope: true }) }),
}));

vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/services/publish/purgeUserPublishedArtifacts', () => ({
  unpublishUserArtifactsBySource: vi.fn().mockResolvedValue({ artifacts: [] }),
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ delete: storageDelete }),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    for (const method of ['get', 'put', 'post', 'delete', 'patch']) {
      chain[method] = (handler: unknown) => {
        captured.handlers[method] = handler;
        return chain;
      };
    }
    return chain;
  },
}));

let ownedFiles: Record<string, unknown>[] = [];

// Applies the projection the route passes to `.select()`, so dropping a field from that projection is
// caught here rather than only by the projection-string assertion below. Dotted paths are kept nested.
const project = (doc: Record<string, unknown>, projection: string): Record<string, unknown> => {
  // Mongoose returns `_id` whatever the projection says.
  const out: Record<string, unknown> = doc._id === undefined ? {} : { _id: doc._id };
  for (const path of projection.split(' ').filter(Boolean)) {
    // An array path (`users.userId`) keeps each element's projected field, as Mongo does.
    const [head, ...rest] = path.split('.');
    if (Array.isArray(doc[head]) && rest.length > 0) {
      out[head] = (doc[head] as Record<string, unknown>[]).map(item => project(item, rest.join('.')));
      continue;
    }
    const value = path
      .split('.')
      .reduce<unknown>((v, k) => (v == null ? undefined : (v as Record<string, unknown>)[k]), doc);
    if (value === undefined) continue;
    const keys = path.split('.');
    let node = out;
    for (const key of keys.slice(0, -1)) node = (node[key] ??= {}) as Record<string, unknown>;
    node[keys[keys.length - 1]] = value;
  }
  return out;
};

const { storageDelete, generatedDelete, selectProjections } = vi.hoisted(() => ({
  storageDelete: vi.fn(),
  generatedDelete: vi.fn(),
  selectProjections: [] as unknown[],
}));

import '../../pages/api/files/index';
import { FabFile, User } from '@bike4mind/database';

const CALLER = 'user-caller';

const makeRes = () => {
  const out = { statusCode: 200 };
  const api: any = {
    status: vi.fn((code: number) => {
      out.statusCode = code;
      return api;
    }),
    json: vi.fn(() => api),
    send: vi.fn(() => api),
  };
  api.out = out;
  return api;
};

describe('DELETE /api/files scoping', () => {
  beforeEach(() => {
    cleanup.pullKnowledgeIdsForUsers.mockReset().mockResolvedValue(0);
    cleanup.pullSystemFilesForUsers.mockReset().mockResolvedValue(undefined);
    cleanup.pullFileReferences.mockReset().mockResolvedValue(undefined);
    cleanup.groupDeletedFileReferences.mockClear();
    cleanup.cleanUpDeletedFileReferences.mockClear();
    storageDelete.mockReset().mockResolvedValue(undefined);
    generatedDelete.mockReset().mockResolvedValue(undefined);
    selectProjections.length = 0;
    ownedFiles = [{ _id: 'mine', userId: CALLER, filePath: 'owned/mine.txt' }];
    vi.mocked(FabFile.deleteMany)
      .mockReset()
      .mockResolvedValue({ deletedCount: 1 } as never);
    // The handler chains `.setOptions({ includeDeleted: true })` onto the grant removal.
    vi.mocked(FabFile.updateMany)
      .mockReset()
      .mockReturnValue({ setOptions: vi.fn().mockResolvedValue({ modifiedCount: 1 }) } as never);
    // Only the caller's own file comes back from the owned lookup.
    vi.mocked(FabFile.find)
      .mockReset()
      .mockReturnValue({
        select: (projection: unknown) => ({
          session: async () => (
            selectProjections.push(projection),
            ownedFiles.map(file => project(file, String(projection)))
          ),
          lean: async () => [{ _id: 'mine' }],
        }),
      } as never);
    vi.mocked(User.findById)
      .mockReset()
      .mockReturnValue({
        session: async () => ({ id: CALLER, currentStorageSize: 500, save: vi.fn() }),
      } as never);
  });

  const run = async (logger = { error: vi.fn(), warn: vi.fn() }) => {
    const res = makeRes();
    await captured.handlers.delete({ user: { id: CALLER }, ability: { __ability: true }, logger }, res);
    return res;
  };

  it('removes the caller grant on files owned by others instead of destroying them', async () => {
    await run();

    expect(FabFile.updateMany).toHaveBeenCalled();
    const [filter, update] = vi.mocked(FabFile.updateMany).mock.calls[0];
    expect(JSON.stringify(filter)).toContain('$ne');
    expect(update).toEqual({ $pull: { users: { userId: CALLER } } });
  });

  it('never deletes bytes for a file the caller does not own', async () => {
    await run();

    // Only the owned file's path is destroyed in storage.
    expect(storageDelete).toHaveBeenCalledTimes(1);
    expect(storageDelete).toHaveBeenCalledWith('owned/mine.txt');
  });

  it("removes an owned generated file's inline chat copy too", async () => {
    ownedFiles = [{ filePath: 'generated-audio/a.mp3', sourceMetadata: { generatedCopyKey: 'a.mp3' } }];

    await run();

    expect(storageDelete).toHaveBeenCalledWith('generated-audio/a.mp3');
    expect(generatedDelete).toHaveBeenCalledWith('a.mp3');
  });

  // The legal-hold skip only works if the owned lookup projects the fields it reads.
  it('keeps the bytes of a blocked file and projects what the stored-object delete reads', async () => {
    ownedFiles = [{ filePath: 'owned/evidence.png', moderationStatus: 'blocked' }];

    await run();

    expect(storageDelete).not.toHaveBeenCalled();
    const projection = String(selectProjections[0]).split(' ');
    expect(projection).toEqual(
      expect.arrayContaining(['filePath', 'moderationStatus', 'blockReason', 'sourceMetadata.generatedCopyKey'])
    );
  });

  // The route's own projection is what lets the rule tell an unscannable block from a content block.
  it('frees the bytes of a file blocked only for an unscannable format', async () => {
    ownedFiles = [{ filePath: 'owned/a.heic', moderationStatus: 'blocked', blockReason: 'unsupported_format' }];

    await run();

    expect(storageDelete).toHaveBeenCalledWith('owned/a.heic');
  });

  it('scopes the document delete to files the caller owns', async () => {
    await run();

    const [deleteFilter] = vi.mocked(FabFile.deleteMany).mock.calls[0];
    expect(JSON.stringify(deleteFilter)).toContain(CALLER);
  });

  it('unlinks the deleted files from the owner and direct-share recipients, from the in-transaction read', async () => {
    ownedFiles = [{ _id: 'mine', userId: CALLER, users: [{ userId: 'recipient-1' }], filePath: 'owned/mine.txt' }];

    await run();

    const holders = [CALLER, 'recipient-1'];
    expect(cleanup.pullKnowledgeIdsForUsers).toHaveBeenCalledWith(holders, ['mine']);
    expect(cleanup.pullSystemFilesForUsers).toHaveBeenCalledWith(holders, ['mine']);
    expect(cleanup.pullFileReferences).toHaveBeenCalledWith(['mine'], { userIds: holders });
  });

  it('unlinks nothing when the delete transaction rolls back', async () => {
    vi.mocked(FabFile.deleteMany).mockRejectedValueOnce(new Error('write conflict'));

    await expect(run()).rejects.toThrow('write conflict');

    expect(cleanup.pullKnowledgeIdsForUsers).not.toHaveBeenCalled();
    expect(cleanup.pullSystemFilesForUsers).not.toHaveBeenCalled();
    expect(cleanup.pullFileReferences).not.toHaveBeenCalled();
  });

  it('keeps unlinking system files and projects when the session unlink fails', async () => {
    cleanup.pullKnowledgeIdsForUsers.mockRejectedValueOnce(new Error('write failed'));

    await run();

    expect(cleanup.pullSystemFilesForUsers).toHaveBeenCalledWith([CALLER], ['mine']);
    expect(cleanup.pullFileReferences).toHaveBeenCalledWith(['mine'], { userIds: [CALLER] });
  });

  it('still returns its normal success response when the reference cleanup throws', async () => {
    cleanup.groupDeletedFileReferences.mockImplementationOnce(() => {
      throw new Error('cleanup failed');
    });
    const logger = { error: vi.fn(), warn: vi.fn() };

    const res = await run(logger);

    expect(res.out.statusCode).toBe(204);
    expect(res.send).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    expect(storageDelete).toHaveBeenCalledWith('owned/mine.txt');
  });
});
