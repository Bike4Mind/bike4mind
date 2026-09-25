import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The PUT handler is the authoritative write boundary for a lake's origin: it is the one place
 * that owns UpdateDataLakeRequestInput, so an unknown origin must be rejected here (fail loud)
 * rather than reaching the service with an undeclared value.
 */
const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
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
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  // The config-audit repos this route wires (see lakeConfigAuditDb). Stubbed rather than
  // omitted because the mock replaces the whole module: a missing export is an import-time
  // failure, not a silent undefined.
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
  // Stubbed rather than omitted because the mock replaces the whole module: a missing export is
  // an import-time failure, not a silent undefined. Only findBySettingNames/findAll are actually
  // read here, via updateDataLake's config-audit retention resolver (lakeConfigAuditDb) - this
  // file drives PUT only, so getSettingsValue's GET-route consumer never runs.
  adminSettingsRepository: {
    getSettingsValue: vi.fn().mockResolvedValue(false),
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
// Real allowlist predicate on purpose - the whole point is which ids pass.
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    assertLakeWritable: h.assertLakeWritable,
    updateDataLake: h.updateDataLake,
  },
}));

import handler from '../[id]';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const put = (body: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ method: 'PUT', query: { id: 'lake1' }, body, ...over }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

describe('PUT /api/data-lakes/[id] - origin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'owner', isAdmin: false, userTags: [] });
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1', createdByUserId: 'owner' });
    h.updateDataLake.mockResolvedValue({ id: 'lake1', origin: 'connector-fed' });
  });

  it('passes a valid origin through to updateDataLake', async () => {
    const { res } = makeRes();
    await run(put({ origin: 'connector-fed' }), res);
    expect(h.updateDataLake).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ origin: 'connector-fed' }),
      expect.anything()
    );
  });

  it('rejects an unknown origin before touching the service', async () => {
    const { res } = makeRes();
    await expect(run(put({ origin: 'machine-fed' }), res)).rejects.toThrow();
    expect(h.updateDataLake).not.toHaveBeenCalled();
  });
});
