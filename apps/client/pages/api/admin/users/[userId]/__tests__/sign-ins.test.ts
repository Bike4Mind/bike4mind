import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';
import { decodeAuditCursor, encodeAuditCursor } from '@server/utils/adminAuditQuery';

const mocks = vi.hoisted(() => ({ findById: vi.fn(), listUserSignIns: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
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
vi.mock('@server/utils/userSignIns', () => ({
  listUserSignIns: (...a: unknown[]) => mocks.listUserSignIns(...a),
}));

import handler from '../sign-ins';

const USER_ID = 'b'.repeat(24);
const ENTRY_ID = 'c'.repeat(24);
const LOGIN_RECORDS = [{ loginTime: new Date('2026-10-20T10:00:00.000Z'), location: 'Lisbon, PT' }];

const call = (query: Record<string, string> = {}, user: unknown = { id: 'admin1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId: USER_ID, ...query } });
  if (user) (req as Record<string, unknown>).user = user;
  return { req, res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findById.mockResolvedValue({ id: USER_ID, loginRecords: LOGIN_RECORDS });
  mocks.listUserSignIns.mockResolvedValue({ entries: [], nextCursor: null });
});

describe('GET /api/admin/users/[userId]/sign-ins', () => {
  it('declares requiredScopes [ApiKeyScope.ADMIN]', () => {
    expect((handler as unknown as { _config?: { requiredScopes?: string[] } })._config?.requiredScopes).toEqual([
      ApiKeyScope.ADMIN,
    ]);
  });

  it('rejects a non-admin with 403 before reading anything', async () => {
    await expect(call({}, { id: 'u2', isAdmin: false }).promise).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it('rejects a malformed user id or cursor with 400 and a missing user with 404', async () => {
    await expect(call({ userId: 'nope' }).promise).rejects.toMatchObject({ statusCode: 400 });
    await expect(call({ cursor: 'garbage' }).promise).rejects.toMatchObject({ statusCode: 400 });
    mocks.findById.mockResolvedValue(null);
    await expect(call().promise).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lists with the user login records and encodes the next cursor', async () => {
    const cursor = { occurredAt: new Date('2026-10-20T10:00:00.000Z'), id: ENTRY_ID };
    const next = { occurredAt: new Date('2026-10-18T10:00:00.000Z'), id: ENTRY_ID };
    mocks.listUserSignIns.mockResolvedValue({ entries: [], nextCursor: next });
    const { res, promise } = call({ limit: '25', cursor: encodeAuditCursor(cursor) });
    await promise;

    expect(mocks.listUserSignIns).toHaveBeenCalledWith(USER_ID, LOGIN_RECORDS, { limit: 25, cursor });
    expect(decodeAuditCursor((res._getJSONData() as { nextCursor: string }).nextCursor)).toEqual(next);
  });
});
