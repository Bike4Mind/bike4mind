// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** POST /api/data-lakes needs datalake:share for a readership gate field, as the PUT does. */
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
vi.mock('@bike4mind/server-utils/dataLakes/toAccessContext', () => ({ toAccessContext: vi.fn() }));
vi.mock('@server/dataLakes/resolveLakeListRetrievalScope', () => ({ resolveLakeListRetrievalScope: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/resolveActiveOrg', () => ({
  resolveActiveOrg: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/server-utils/dataLakes/lakeConfigAuditDb', () => ({ lakeConfigAuditDb: {} }));
vi.mock('@bike4mind/database', () => ({ dataLakeRepository: {}, dataLakeAccessGrantRepository: {} }));
vi.mock('@bike4mind/services', () => ({ dataLakeService: { createDataLake: h.createDataLake } }));

import '../index';

const makeRes = () => ({ json: vi.fn(), status: vi.fn().mockReturnThis() });
const post = (scopes: string[] | null, extra: Record<string, unknown> = {}) =>
  h.captured.post!(
    {
      user: { id: 'owner-1' },
      ...(scopes && { apiKeyInfo: { keyId: 'key-1', scopes } }),
      body: { name: 'Lake', slug: 'lake', fileTagPrefix: 'lk:', ...extra },
      logger: console,
    },
    makeRes()
  );

beforeEach(() => {
  h.createDataLake.mockReset().mockResolvedValue({ id: 'lake-1' });
  h.assertLakePlanAllowed.mockReset().mockResolvedValue(undefined);
});

describe('POST /api/data-lakes - gate fields need datalake:share', () => {
  it.each([{ requiredUserTag: 'team-a' }, { requiredEntitlement: 'lake:pro' }])(
    'refuses a write-only key that sends %o and creates nothing',
    async extra => {
      await expect(post(['datalake:write'], extra)).rejects.toMatchObject({ statusCode: 403 });
      expect(h.createDataLake).not.toHaveBeenCalled();
    }
  );

  it('creates for a share key, a session caller, and a write-only key with no gate field', async () => {
    await post(['datalake:write', 'datalake:share'], { requiredUserTag: 'team-a' });
    await post(null, { requiredUserTag: 'team-a' });
    await post(['datalake:write']);
    expect(h.createDataLake).toHaveBeenCalledTimes(3);
  });
});
