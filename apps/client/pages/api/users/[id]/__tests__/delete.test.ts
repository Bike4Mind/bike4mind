import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockAdminDeleteUser, mockRepoDelete, mockPurge, mockReadGrants } = vi.hoisted(() => ({
  mockAdminDeleteUser: vi.fn(),
  mockRepoDelete: vi.fn(),
  mockPurge: vi.fn(),
  mockReadGrants: vi.fn(),
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
const { mockPublish } = vi.hoisted(() => ({ mockPublish: vi.fn() }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: mockPublish } } }));
vi.mock('@bike4mind/services', () => ({
  userService: { adminDeleteUser: (...a: unknown[]) => mockAdminDeleteUser(...a) },
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { delete: (...a: unknown[]) => mockRepoDelete(...a) },
  adminSettingsRepository: {},
}));
vi.mock('@server/services/purgeDeletedUserData', () => ({
  purgeDeletedUserData: (...a: unknown[]) => mockPurge(...a),
  readUserIntegrationGrants: (...a: unknown[]) => mockReadGrants(...a),
}));

import { USER_SECRET_FIELDS } from '@bike4mind/common';
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
  mockReadGrants.mockReset().mockResolvedValue(null);
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
    expect(res._getJSONData()).toMatchObject({ id: 'u1' });
  });

  it('escapes names and email in the admin notification body', async () => {
    mockAdminDeleteUser.mockImplementation(
      async (
        _admin: string,
        _p: unknown,
        { mailer }: { mailer: { sendDeleteUserEmail: (to: string[], u: unknown, a: unknown) => Promise<void> } }
      ) => {
        await mailer.sendDeleteUserEmail(
          ['ops@example.com'],
          { name: '<b>U</b>', email: 'u&x@example.com' },
          { name: '<i>A</i>' }
        );
        return { id: 'u1' };
      }
    );

    const { call } = await run();
    await call;

    const body: string = mockPublish.mock.calls[0][0].body;
    expect(body).not.toContain('<b>');
    expect(body).not.toContain('<i>');
    expect(body).toContain('&lt;b&gt;U&lt;/b&gt;');
    expect(body).toContain('u&amp;x@example.com');
    expect(body).toContain('&lt;i&gt;A&lt;/i&gt;');
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

  it('reads the integration grants before the delete and hands them to the purge', async () => {
    const grants = { googleDrive: { refreshToken: 'enc-refresh' }, atlassianConnect: { accessToken: 'enc-access' } };
    mockReadGrants.mockImplementation(async () => {
      expect(mockRepoDelete).not.toHaveBeenCalled();
      return grants;
    });
    mockAdminDeleteUser.mockImplementation(async (_admin: string, _p: unknown, { db }: DeleteAdapters) => {
      await db.users.delete('u1');
      return { id: 'u1' };
    });

    const { call } = await run();
    await call;

    expect(mockReadGrants).toHaveBeenCalledWith('u1');
    expect(mockPurge).toHaveBeenCalledWith('u1', expect.objectContaining({ integrationGrants: grants }));
  });

  it('does not delete when the grants cannot be read, so the revoke is never lost', async () => {
    mockReadGrants.mockRejectedValue(new Error('mongo down'));
    mockAdminDeleteUser.mockImplementation(async (_admin: string, _p: unknown, { db }: DeleteAdapters) => {
      await db.users.delete('u1');
      return { id: 'u1' };
    });

    const { call } = await run();

    await expect(call).rejects.toThrow('mongo down');
    expect(mockRepoDelete).not.toHaveBeenCalled();
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it('returns the serialized user shape with none of the USER_SECRET_FIELDS', async () => {
    const secrets = Object.fromEntries(USER_SECRET_FIELDS.map(f => [f, 'x']));
    mockAdminDeleteUser.mockResolvedValue({ id: 'u1', name: 'N', email: 'n@example.com', ...secrets });

    const { res, call } = await run();
    await call;

    const body = res._getJSONData();
    expect(body).toMatchObject({ id: 'u1', name: 'N' });
    expect(body).not.toHaveProperty('email');
    for (const f of USER_SECRET_FIELDS) expect(body).not.toHaveProperty(f);
  });
});
