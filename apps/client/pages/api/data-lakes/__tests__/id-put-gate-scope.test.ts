import { describe, it, expect, vi, beforeEach } from 'vitest';

/** A PUT that sets or clears a readership gate field needs datalake:share, like the visibility route. */
const h = vi.hoisted(() => ({
  assertLakeAccessById: vi.fn(),
  assertLakeWritable: vi.fn(),
  updateDataLake: vi.fn(),
  toAccessContext: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      put: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.PUT = fns[fns.length - 1]), chain),
      delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/database', () => ({
  withTransaction: (fn: () => unknown) => fn(),
  dataLakeRepository: {},
  lakeConfigChangeEventRepository: { record: vi.fn().mockResolvedValue({}) },
  dataLakeBatchRepository: {},
  fabFileRepository: {},
  dataLakeAccessGrantRepository: {
    listByLake: vi.fn().mockResolvedValue([]),
    listActiveByLakes: vi.fn().mockResolvedValue([]),
    listByPrincipal: vi.fn().mockResolvedValue([]),
    findGrant: vi.fn().mockResolvedValue(null),
    upsertGrant: vi.fn().mockResolvedValue({}),
    removeGrant: vi.fn().mockResolvedValue(true),
    removeAllForLake: vi.fn().mockResolvedValue(0),
  },
  adminSettingsRepository: {
    getSettingsValue: vi.fn().mockResolvedValue(false),
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('@bike4mind/server-utils/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccessById: h.assertLakeAccessById,
    assertLakeWritable: h.assertLakeWritable,
    updateDataLake: h.updateDataLake,
  },
}));

import handler from '../[id]';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const put = (body: Record<string, unknown>, scopes: string[] | null) =>
  ({
    method: 'PUT',
    query: { id: 'lake1' },
    body,
    user: { id: 'owner' },
    ...(scopes && { apiKeyInfo: { keyId: 'k1', scopes } }),
  }) as never;
const run = (req: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, makeRes().res);

describe('PUT /api/data-lakes/[id] - gate fields need datalake:share', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'owner', isAdmin: false, userTags: [] });
    h.assertLakeAccessById.mockResolvedValue({ id: 'lake1', createdByUserId: 'owner' });
    h.updateDataLake.mockResolvedValue({ id: 'lake1' });
  });

  it.each([{ requiredUserTag: 'team-a' }, { requiredEntitlement: 'lake:pro' }, { requiredUserTag: '' }])(
    'refuses a write-only key that sends %o and writes nothing',
    async body => {
      await expect(run(put({ name: 'L', ...body }, ['datalake:write']))).rejects.toMatchObject({ statusCode: 403 });
      expect(h.updateDataLake).not.toHaveBeenCalled();
    }
  );

  it('accepts a key holding datalake:share as well', async () => {
    await run(put({ name: 'L', requiredUserTag: 'team-a' }, ['datalake:write', 'datalake:share']));
    expect(h.updateDataLake).toHaveBeenCalledTimes(1);
  });

  it('keeps a metadata-only PUT open to a write-only key, and gate fields open to a session', async () => {
    await run(put({ name: 'L' }, ['datalake:write']));
    await run(put({ name: 'L', requiredUserTag: 'team-a' }, null));
    expect(h.updateDataLake).toHaveBeenCalledTimes(2);
  });
});
