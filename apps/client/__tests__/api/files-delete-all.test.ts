import { describe, it, expect, vi, beforeEach } from 'vitest';

const captured = vi.hoisted(() => ({ handlers: {} as Record<string, any> }));

vi.mock('@bike4mind/database', () => ({
  FabFile: { find: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
  User: { findById: vi.fn() },
  adminSettingsRepository: {},
  fabFileRepository: {},
  projectRepository: {},
  userRepository: {},
  withTransaction: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn('txn')),
}));

vi.mock('@bike4mind/services', () => ({ fabFilesService: {} }));

// The caller holds delete on their own file and on a file shared in from another owner - the
// scope the endpoint used to hard-delete wholesale.
vi.mock('@casl/mongoose', () => ({
  accessibleBy: () => ({ ofType: () => ({ __deleteScope: true }) }),
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/utils/storage', () => ({
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

const { storageDelete } = vi.hoisted(() => ({ storageDelete: vi.fn() }));

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
    storageDelete.mockReset().mockResolvedValue(undefined);
    vi.mocked(FabFile.deleteMany)
      .mockReset()
      .mockResolvedValue({ deletedCount: 1 } as never);
    vi.mocked(FabFile.updateMany)
      .mockReset()
      .mockResolvedValue({ modifiedCount: 1 } as never);
    // Only the caller's own file comes back from the owned lookup.
    vi.mocked(FabFile.find)
      .mockReset()
      .mockReturnValue({
        select: () => ({ session: async () => [{ filePath: 'owned/mine.txt' }] }),
      } as never);
    vi.mocked(User.findById)
      .mockReset()
      .mockReturnValue({
        session: async () => ({ id: CALLER, currentStorageSize: 500, save: vi.fn() }),
      } as never);
  });

  const run = async () => {
    const res = makeRes();
    await captured.handlers.delete(
      { user: { id: CALLER }, ability: { __ability: true }, logger: { error: vi.fn() } },
      res
    );
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

  it('scopes the document delete to files the caller owns', async () => {
    await run();

    const [deleteFilter] = vi.mocked(FabFile.deleteMany).mock.calls[0];
    expect(JSON.stringify(deleteFilter)).toContain(CALLER);
  });
});
