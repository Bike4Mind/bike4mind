import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';
import { encodeAuditCursor } from '@server/utils/adminAuditQuery';

const mocks = vi.hoisted(() => ({ findById: vi.fn(), listUserActivity: vi.fn(), hasAdminHistory: vi.fn() }));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (config?: unknown) => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@bike4mind/database', () => ({ userRepository: { findById: (...a: unknown[]) => mocks.findById(...a) } }));
vi.mock('@server/utils/userActivity', () => ({
  listUserActivity: (...a: unknown[]) => mocks.listUserActivity(...a),
  hasAdminHistory: (...a: unknown[]) => mocks.hasAdminHistory(...a),
}));

import handler from '../activity';

const USER_ID = 'b'.repeat(24);
const ENTRY_ID = 'c'.repeat(24);

const call = (query: Record<string, string | string[]> = {}, user: unknown = { id: 'admin1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId: USER_ID, ...query } });
  if (user) (req as Record<string, unknown>).user = user;
  return { req, res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findById.mockResolvedValue({ id: USER_ID, name: 'Ada', email: 'ada@example.com', isAdmin: false });
  mocks.listUserActivity.mockResolvedValue({ entries: [], nextCursor: null });
  mocks.hasAdminHistory.mockResolvedValue(false);
});

describe('GET /api/admin/users/[userId]/activity', () => {
  it('declares requiredScopes [ApiKeyScope.ADMIN]', () => {
    expect((handler as unknown as { _config?: { requiredScopes?: string[] } })._config?.requiredScopes).toEqual([
      ApiKeyScope.ADMIN,
    ]);
  });

  it('rejects a non-admin with 403 before reading anything', async () => {
    await expect(call({}, { id: 'u2', isAdmin: false }).promise).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it('rejects a malformed user id with 400', async () => {
    await expect(call({ userId: 'not-an-id' }).promise).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects an unknown direction and a non-boolean includeSecurity with 400', async () => {
    await expect(call({ direction: 'both' }).promise).rejects.toMatchObject({ statusCode: 400 });
    await expect(call({ includeSecurity: 'yes' }).promise).rejects.toMatchObject({ statusCode: 400 });
  });

  it('returns 404 for a missing user', async () => {
    mocks.findById.mockResolvedValue(null);
    await expect(call().promise).rejects.toMatchObject({ statusCode: 404 });
  });

  it('defaults to the target direction without security events', async () => {
    const { res, promise } = call();
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.listUserActivity).toHaveBeenCalledWith(
      { id: USER_ID, name: 'Ada', email: 'ada@example.com', isAdmin: false },
      { direction: 'target', includeSecurity: false, limit: 50, cursor: undefined }
    );
    expect(res._getJSONData()).toEqual({ entries: [], nextCursor: null, actorViewAvailable: false });
  });

  it('passes direction, includeSecurity and the decoded cursor through, and encodes the next cursor', async () => {
    const occurredAt = new Date('2026-10-01T00:00:00Z');
    mocks.listUserActivity.mockResolvedValue({ entries: [], nextCursor: { occurredAt, id: ENTRY_ID } });
    mocks.hasAdminHistory.mockResolvedValue(true);

    const { res, promise } = call({
      direction: 'actor',
      includeSecurity: 'true',
      cursor: encodeAuditCursor({ occurredAt, id: ENTRY_ID }),
    });
    await promise;

    expect(mocks.listUserActivity).toHaveBeenCalledWith(expect.anything(), {
      direction: 'actor',
      includeSecurity: true,
      limit: 50,
      cursor: { occurredAt, id: ENTRY_ID },
    });
    expect(res._getJSONData()).toEqual({
      entries: [],
      nextCursor: encodeAuditCursor({ occurredAt, id: ENTRY_ID }),
      actorViewAvailable: true,
    });
  });

  it('rejects a tampered cursor with 400', async () => {
    await expect(call({ cursor: 'garbage' }).promise).rejects.toMatchObject({ statusCode: 400 });
  });
});
