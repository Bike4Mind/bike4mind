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
  assertLakePlanAllowed: vi.fn(),
}));

// The plan gate has its own tests (server/entitlements/lakePlanGate.test.ts).
vi.mock('@server/entitlements/lakePlanGate', () => ({ assertLakePlanAllowed: h.assertLakePlanAllowed }));
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
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({
  requireFeatureEnabled: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/dataLakes/dataLakeScopes', () => ({ DATA_LAKE_READ_SCOPES: [], assertDataLakeWriteScope: vi.fn() }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: vi.fn() }));
vi.mock('@server/dataLakes/resolveLakeListRetrievalScope', () => ({ resolveLakeListRetrievalScope: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/resolveActiveOrg', () => ({
  resolveActiveOrg: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/server-utils/dataLakes/lakeConfigAuditDb', () => ({ lakeConfigAuditDb: {} }));
vi.mock('@bike4mind/database', () => ({ dataLakeRepository: {}, dataLakeAccessGrantRepository: {} }));
vi.mock('@bike4mind/services', () => ({ dataLakeService: { createDataLake: h.createDataLake } }));

import { ForbiddenError } from '@bike4mind/common';
import { resolveActiveOrg } from '@bike4mind/server-utils/utils/resolveActiveOrg';
import '../index';

const makeRes = () => ({ json: vi.fn(), status: vi.fn().mockReturnThis() });
const post = (apiKeyInfo?: { keyId: string }, res = makeRes()) =>
  h.captured.post!(
    {
      user: { id: 'owner-1' },
      apiKeyInfo,
      body: { name: 'Lake', slug: 'lake', fileTagPrefix: 'lk:' },
      logger: console,
    },
    res
  );

beforeEach(() => {
  h.createDataLake.mockReset().mockResolvedValue({ id: 'lake-1', _id: 'oid-1', __v: 1 });
  h.assertLakePlanAllowed.mockReset().mockResolvedValue(undefined);
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

  it('answers 201 with the lake stripped to the declared keys', async () => {
    const res = makeRes();
    await post(undefined, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ id: 'lake-1' });
  });
});

describe('POST /api/data-lakes - paid-plan gate', () => {
  it('checks the plan for a personal lake with no organization id', async () => {
    await post();
    expect(h.assertLakePlanAllowed).toHaveBeenCalledTimes(1);
    expect(h.assertLakePlanAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ user: { id: 'owner-1' } }),
      undefined
    );
  });

  it('checks the plan against the resolved active organization', async () => {
    vi.mocked(resolveActiveOrg).mockResolvedValueOnce('org-1');
    await post();
    expect(h.assertLakePlanAllowed).toHaveBeenCalledWith(expect.anything(), 'org-1');
  });

  it('rejects with the plan error and creates no lake when the gate refuses', async () => {
    const refusal = new ForbiddenError('Data lakes need a paid plan', { code: 'DATA_LAKE_PLAN_REQUIRED' });
    h.assertLakePlanAllowed.mockRejectedValueOnce(refusal);
    await expect(post()).rejects.toBe(refusal);
    expect(h.createDataLake).not.toHaveBeenCalled();
  });
});
