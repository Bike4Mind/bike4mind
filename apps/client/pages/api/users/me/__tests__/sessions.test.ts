import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET/DELETE /api/users/me/sessions - the self-serve active-sessions surface (issue #1194).
 * GET lists the caller's own sessions as a client-safe DTO (never the refresh-token hash) and flags
 * the current one. DELETE revokes a single owned session by sid; a foreign or unknown sid 404s so it
 * is not an existence oracle, and it never bumps tokenVersion (other sessions untouched).
 */
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  deleteHandler: null as null | ((req: any, res: any) => unknown),
  findBySid: null as null | ReturnType<typeof vi.fn>,
  listUserSessions: null as null | ReturnType<typeof vi.fn>,
  revokeSession: null as null | ReturnType<typeof vi.fn>,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    delete: (fn: any) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database', () => {
  mockRefs.findBySid = vi.fn();
  return { authSessionRepository: { findBySid: mockRefs.findBySid } };
});
vi.mock('@bike4mind/services', () => {
  mockRefs.listUserSessions = vi.fn();
  mockRefs.revokeSession = vi.fn().mockResolvedValue({ sid: 'sid-2' });
  return {
    authSessionService: {
      listUserSessions: mockRefs.listUserSessions,
      revokeSession: mockRefs.revokeSession,
    },
  };
});
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn().mockResolvedValue(undefined) }));

import '@pages/api/users/me/sessions';

const NOW = new Date('2026-08-10T00:00:00.000Z');
const sessionRow = (over: Record<string, unknown>) => ({
  sid: 'sid-1',
  userId: 'user-1',
  createdVia: 'otc',
  device: { userAgent: 'UA', ip: '1.2.3.4' },
  refreshTokenHash: 'SECRET-HASH-MUST-NOT-LEAK',
  previousRefreshTokenHash: 'PREV-HASH',
  lastUsedAt: NOW,
  createdAt: NOW,
  expiresAt: NOW,
  impersonatedBy: null,
  ...over,
});

function mocks(method: 'GET' | 'DELETE', user: unknown, query?: Record<string, string>) {
  const { req, res } = createMocks({ method, query });
  (req as any).user = user;
  return { req, res };
}

describe('GET /api/users/me/sessions', () => {
  beforeEach(() => mockRefs.listUserSessions?.mockReset());

  it('returns a client-safe DTO (no hashes) and flags the current session', async () => {
    mockRefs.listUserSessions!.mockResolvedValue([sessionRow({ sid: 'sid-1' }), sessionRow({ sid: 'sid-2' })]);
    const { req, res } = mocks('GET', { id: 'user-1', sid: 'sid-2' });
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    const { items } = res._getJSONData();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ sid: 'sid-1', current: false });
    expect(items[1]).toMatchObject({ sid: 'sid-2', current: true });
    // No secret material of any kind crosses the wire.
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain('SECRET-HASH-MUST-NOT-LEAK');
    expect(serialized).not.toContain('PREV-HASH');
    expect(items[0]).not.toHaveProperty('refreshTokenHash');
  });
});

describe('DELETE /api/users/me/sessions', () => {
  beforeEach(() => {
    mockRefs.findBySid?.mockReset();
    mockRefs.revokeSession?.mockClear();
  });

  it('revokes an owned session by sid', async () => {
    mockRefs.findBySid!.mockResolvedValue(sessionRow({ sid: 'sid-2', userId: 'user-1' }));
    const { req, res } = mocks('DELETE', { id: 'user-1', sid: 'sid-1' }, { sid: 'sid-2' });
    await mockRefs.deleteHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockRefs.revokeSession).toHaveBeenCalledWith('sid-2', expect.anything());
  });

  it('422s when sid is missing', async () => {
    const { req, res } = mocks('DELETE', { id: 'user-1', sid: 'sid-1' });
    await expect(mockRefs.deleteHandler!(req, res)).rejects.toMatchObject({ statusCode: 422 });
    expect(mockRefs.revokeSession).not.toHaveBeenCalled();
  });

  it('404s (and does not revoke) when the sid belongs to another user', async () => {
    mockRefs.findBySid!.mockResolvedValue(sessionRow({ sid: 'sid-9', userId: 'someone-else' }));
    const { req, res } = mocks('DELETE', { id: 'user-1', sid: 'sid-1' }, { sid: 'sid-9' });
    await expect(mockRefs.deleteHandler!(req, res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockRefs.revokeSession).not.toHaveBeenCalled();
  });

  it('404s when the sid does not exist', async () => {
    mockRefs.findBySid!.mockResolvedValue(null);
    const { req, res } = mocks('DELETE', { id: 'user-1', sid: 'sid-1' }, { sid: 'ghost' });
    await expect(mockRefs.deleteHandler!(req, res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockRefs.revokeSession).not.toHaveBeenCalled();
  });
});
