import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => handlers[req.method ?? 'GET']?.(req, res), {
      get: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.GET = fn), chain),
      _config: config,
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

const mockFindById = vi.fn();
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: { findById: (...args: unknown[]) => mockFindById(...args) },
}));

const mockListForSubscription = vi.fn();
vi.mock('@bike4mind/database', () => ({
  adminAuditLogRepository: { listForSubscription: (...args: unknown[]) => mockListForSubscription(...args) },
}));

import { encodeAuditCursor } from '@server/utils/adminAuditQuery';
import handler from '../admin-log';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
const ID = 'b'.repeat(24);
type Handler = (req: unknown, res: unknown) => Promise<unknown>;

async function call(query: Record<string, string> = {}, user: Record<string, unknown> = ADMIN, id = ID) {
  const { req, res } = createMocks({ method: 'GET', query: { id, ...query } });
  Object.assign(req, { user });
  await (handler as unknown as Handler)(req, res);
  return res;
}

describe('GET /api/admin/subscriptions/[id]/admin-log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue({ id: ID, ownerType: 'User', ownerId: 'u1', subscriptionId: 'sub_1' });
    mockListForSubscription.mockResolvedValue({ entries: [], nextCursor: null });
  });

  it('requires JWT auth with admin scope', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
    });
  });

  it('refuses a non-admin', async () => {
    await expect(call({}, { ...ADMIN, isAdmin: false })).rejects.toThrow('Admin access required');
    expect(mockListForSubscription).not.toHaveBeenCalled();
  });

  it('404s for a missing subscription or a malformed id', async () => {
    mockFindById.mockResolvedValue(null);
    await expect(call()).rejects.toMatchObject({ statusCode: 404 });
    await expect(call({}, ADMIN, 'nope')).rejects.toMatchObject({ statusCode: 404 });
    expect(mockListForSubscription).not.toHaveBeenCalled();
  });

  it('scopes a user-owned row to its owner and both subscription ids', async () => {
    const res = await call({ limit: '20' });
    expect(mockListForSubscription).toHaveBeenCalledWith(
      { owner: { kind: 'user', id: 'u1' }, subscriptionIds: ['sub_1', ID] },
      { limit: 20, cursor: undefined }
    );
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(res._getJSONData()).toEqual({ entries: [], nextCursor: null });
  });

  it('scopes an organization-owned row to the organization', async () => {
    mockFindById.mockResolvedValue({ id: ID, ownerType: 'Organization', ownerId: 'o1', subscriptionId: 'sub_1' });
    await call();
    expect(mockListForSubscription.mock.calls[0][0].owner).toEqual({ kind: 'organization', id: 'o1' });
  });

  it('encodes the next cursor and decodes an incoming one', async () => {
    const occurredAt = new Date('2026-05-01T00:00:00Z');
    const entryId = 'd'.repeat(24);
    mockListForSubscription.mockResolvedValue({ entries: [], nextCursor: { occurredAt, id: entryId } });
    const res = await call({ cursor: encodeAuditCursor({ occurredAt, id: entryId }) });
    expect(mockListForSubscription.mock.calls[0][1].cursor).toEqual({ occurredAt, id: entryId });
    expect(res._getJSONData().nextCursor).toBe(encodeAuditCursor({ occurredAt, id: entryId }));
  });

  it('400s on a tampered cursor', async () => {
    await expect(call({ cursor: '%%%' })).rejects.toMatchObject({ statusCode: 400 });
  });
});
