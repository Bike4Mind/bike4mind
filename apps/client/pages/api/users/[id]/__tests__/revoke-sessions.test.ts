import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindById, mockRevoke, mockRevokeDevices, mockLogAuth, mockRecord } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockRevoke: vi.fn(),
  mockRevokeDevices: vi.fn(),
  mockLogAuth: vi.fn(),
  mockRecord: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: (req: unknown, res: unknown) => unknown) => fn,
  }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@bike4mind/services', () => ({
  userService: { adminRevokeUserSessions: (...a: unknown[]) => mockRevoke(...a) },
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mockFindById(...a) },
  authSessionRepository: {},
  trustedDeviceRepository: { revokeAllForUser: (...a: unknown[]) => mockRevokeDevices(...a) },
  realtimeConnectionRepository: {},
}));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: (...a: unknown[]) => mockLogAuth(...a) }));
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: (...a: unknown[]) => mockRecord(...a),
}));

import handler from '../revoke-sessions';

const run = async () => {
  const { req, res } = createMocks({ method: 'POST', query: { id: 'u1' } });
  Object.assign(req, {
    user: { id: 'admin1', isAdmin: true },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return { req, res };
};

beforeEach(() => {
  mockFindById.mockReset().mockResolvedValue({ id: 'u1', name: 'Target', username: 'target', email: 't@x.com' });
  mockRevoke.mockReset().mockResolvedValue(4);
  mockRevokeDevices.mockReset().mockResolvedValue(2);
  mockLogAuth.mockReset().mockResolvedValue(undefined);
  mockRecord.mockReset().mockResolvedValue(null);
});

describe('POST /api/users/[id]/revoke-sessions', () => {
  it('records user.sessions.revoked with the target and revoke details', async () => {
    const { req } = await run();

    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'user.sessions.revoked',
        target: { kind: 'user', id: 'u1', displayName: 'Target' },
        details: { tokenVersion: 4, revokedDevices: 2 },
      })
    );
  });

  it('reads the target before the revoke', async () => {
    await run();
    expect(mockFindById.mock.invocationCallOrder[0]).toBeLessThan(mockRevoke.mock.invocationCallOrder[0]);
  });

  it.each([
    ['username', { id: 'u1', username: 'target', email: 't@x.com' }, 'target'],
    ['email', { id: 'u1', email: 't@x.com' }, 't@x.com'],
    ['id', null, 'u1'],
  ])('falls back to the %s for the display name', async (_label, user, displayName) => {
    mockFindById.mockResolvedValue(user);
    await run();
    expect(mockRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ target: { kind: 'user', id: 'u1', displayName } })
    );
  });

  it('keeps the 200 response unchanged', async () => {
    const { res } = await run();
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ message: 'Sessions revoked', userId: 'u1', tokenVersion: 4 });
  });

  it('still answers 200 when the best-effort audit write resolves null', async () => {
    mockRecord.mockResolvedValue(null);
    const { res } = await run();
    expect(res._getStatusCode()).toBe(200);
  });
});
