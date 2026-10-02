// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /api/data-lakes accepts API-key auth, so the `create` History row must name the key, not the
 * key's owner as though they had created the lake by hand. The real `lakeConfigAuditPrincipal` runs
 * here; only `createDataLake` is stubbed, so this pins the route's wiring of the principal.
 */

const h = vi.hoisted(() => ({
  captured: {} as { post?: (req: unknown, res: unknown) => Promise<unknown> },
  createDataLake: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = () => chain;
    chain.post = (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.captured.post = fn;
      return chain;
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/dataLakes/dataLakeScopes', () => ({ DATA_LAKE_READ_SCOPES: [], assertDataLakeWriteScope: vi.fn() }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: vi.fn() }));
vi.mock('@server/dataLakes/resolveLakeListRetrievalScope', () => ({ resolveLakeListRetrievalScope: vi.fn() }));
vi.mock('@server/utils/resolveActiveOrg', () => ({ resolveActiveOrg: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/dataLakes/lakeConfigAuditDb', () => ({ lakeConfigAuditDb: {} }));
vi.mock('@bike4mind/database', () => ({ dataLakeRepository: {}, dataLakeAccessGrantRepository: {} }));
vi.mock('@bike4mind/services', () => ({ dataLakeService: { createDataLake: h.createDataLake } }));

import '../index';

const makeRes = () => ({ json: vi.fn(), status: vi.fn().mockReturnThis() });
const post = (apiKeyInfo?: { keyId: string }) =>
  h.captured.post!(
    {
      user: { id: 'owner-1' },
      apiKeyInfo,
      body: { name: 'Lake', slug: 'lake', fileTagPrefix: 'lk:' },
      logger: console,
    },
    makeRes()
  );

beforeEach(() => {
  h.createDataLake.mockReset().mockResolvedValue({ id: 'lake-1' });
});

describe('POST /api/data-lakes - audit principal', () => {
  it('passes the API-key principal through to createDataLake', async () => {
    await post({ keyId: 'key-1' });
    expect(h.createDataLake).toHaveBeenCalledTimes(1);
    expect(h.createDataLake.mock.calls[0][4]).toEqual({
      principalKind: 'apiKey',
      principalId: 'key-1',
      onBehalfOfUserId: 'owner-1',
    });
  });

  it('passes no principal for a session caller, leaving the user id to stand for itself', async () => {
    await post();
    expect(h.createDataLake.mock.calls[0][4]).toBeUndefined();
  });
});
