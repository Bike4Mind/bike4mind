import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, USER_TIMELINE_TYPES } from '@bike4mind/common';
import { decodeAuditCursor, encodeAuditCursor } from '@server/utils/adminAuditQuery';

const mocks = vi.hoisted(() => ({ findById: vi.fn(), listUserTimeline: vi.fn() }));

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
vi.mock('@server/utils/userTimeline', () => ({
  listUserTimeline: (...a: unknown[]) => mocks.listUserTimeline(...a),
}));

import handler from '../timeline';

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
  mocks.listUserTimeline.mockResolvedValue({ entries: [], nextCursor: null });
});

describe('GET /api/admin/users/[userId]/timeline', () => {
  it('declares requiredScopes [ApiKeyScope.ADMIN]', () => {
    expect((handler as unknown as { _config?: { requiredScopes?: string[] } })._config?.requiredScopes).toEqual([
      ApiKeyScope.ADMIN,
    ]);
  });

  it('rejects a non-admin with 403 before reading anything', async () => {
    await expect(call({}, { id: 'u2', isAdmin: false }).promise).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it('rejects a malformed user id, an unknown type, a bad date and an inverted range with 400', async () => {
    await expect(call({ userId: 'nope' }).promise).rejects.toMatchObject({ statusCode: 400 });
    await expect(call({ types: 'signin,chat' }).promise).rejects.toMatchObject({ statusCode: 400 });
    await expect(call({ from: '2026-10-01' }).promise).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      call({ from: '2026-10-02T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }).promise
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(call({ cursor: 'garbage' }).promise).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.listUserTimeline).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing user', async () => {
    mocks.findById.mockResolvedValue(null);
    await expect(call().promise).rejects.toMatchObject({ statusCode: 404 });
  });

  it('queries every source by default with the default page size', async () => {
    const { res, promise } = call();
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.listUserTimeline).toHaveBeenCalledWith(
      { id: USER_ID, name: 'Ada', email: 'ada@example.com', isAdmin: false },
      { types: [...USER_TIMELINE_TYPES], range: { from: undefined, to: undefined }, limit: 50, cursor: undefined }
    );
  });

  it('passes types, range, a capped limit and the decoded cursor through', async () => {
    const cursor = { occurredAt: new Date('2026-10-20T10:00:00.000Z'), id: ENTRY_ID };
    await call({
      types: 'admin,signin,admin',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-31T23:59:59.999Z',
      limit: '500',
      cursor: encodeAuditCursor(cursor),
    }).promise;

    expect(mocks.listUserTimeline).toHaveBeenCalledWith(expect.anything(), {
      types: ['admin', 'signin'],
      range: { from: new Date('2026-10-01T00:00:00.000Z'), to: new Date('2026-10-31T23:59:59.999Z') },
      limit: 100,
      cursor,
    });
  });

  it('encodes the next cursor', async () => {
    const next = { occurredAt: new Date('2026-10-19T08:00:00.000Z'), id: ENTRY_ID };
    mocks.listUserTimeline.mockResolvedValue({ entries: [], nextCursor: next });
    const { res, promise } = call();
    await promise;

    const body = res._getJSONData() as { nextCursor: string };
    expect(decodeAuditCursor(body.nextCursor)).toEqual(next);
  });
});
