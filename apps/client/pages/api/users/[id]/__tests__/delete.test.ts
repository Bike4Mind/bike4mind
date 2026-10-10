import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockAdminDeleteUser, mockRepoDelete, mockPurge } = vi.hoisted(() => ({
  mockAdminDeleteUser: vi.fn(),
  mockRepoDelete: vi.fn(),
  mockPurge: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    delete: (fn: (req: unknown, res: unknown) => unknown) => fn,
  }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@server/integrations/slack/slack', () => ({ postMessageToSlack: vi.fn() }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: vi.fn() } } }));
vi.mock('@bike4mind/services', () => ({
  userService: { adminDeleteUser: (...a: unknown[]) => mockAdminDeleteUser(...a) },
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { delete: (...a: unknown[]) => mockRepoDelete(...a) },
  adminSettingsRepository: {},
}));
vi.mock('@server/services/purgeDeletedUserData', () => ({
  purgeDeletedUserData: (...a: unknown[]) => mockPurge(...a),
}));

import handler from '../delete';

type DeleteAdapters = { db: { users: { delete: (id: string) => Promise<unknown> } } };

async function run() {
  const { req, res } = createMocks({ method: 'DELETE', query: { id: 'u1' } });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  Object.assign(req, { user: { id: 'admin1' }, logger });
  const call = (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return { res, call };
}

beforeEach(() => {
  mockAdminDeleteUser.mockReset();
  mockRepoDelete.mockReset().mockResolvedValue({ deletedCount: 1 });
  mockPurge.mockReset().mockResolvedValue(undefined);
});

describe('DELETE /api/users/[id]/delete', () => {
  it('purges the user data after the delete commits', async () => {
    mockAdminDeleteUser.mockImplementation(async (_admin: string, _p: unknown, { db }: DeleteAdapters) => {
      await db.users.delete('u1');
      return { id: 'u1' };
    });

    const { res, call } = await run();
    await call;

    expect(mockRepoDelete).toHaveBeenCalledWith('u1');
    expect(mockPurge).toHaveBeenCalledWith('u1', expect.objectContaining({ deletedBy: 'admin1' }));
    expect(res._getJSONData()).toEqual({ id: 'u1' });
  });

  it('still purges when a notification throws after the delete committed', async () => {
    mockAdminDeleteUser.mockImplementation(async (_admin: string, _p: unknown, { db }: DeleteAdapters) => {
      await db.users.delete('u1');
      throw new Error('mailer down');
    });

    const { call } = await run();

    await expect(call).rejects.toThrow('mailer down');
    expect(mockPurge).toHaveBeenCalledWith('u1', expect.objectContaining({ deletedBy: 'admin1' }));
  });

  it('does not purge when the delete never ran (unauthorized or not found)', async () => {
    mockAdminDeleteUser.mockRejectedValue(new Error('You are not authorized to delete users'));

    const { call } = await run();

    await expect(call).rejects.toThrow('not authorized');
    expect(mockRepoDelete).not.toHaveBeenCalled();
    expect(mockPurge).not.toHaveBeenCalled();
  });
});
