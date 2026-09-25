// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Proves `origin` reaches the LIST endpoint (GET /api/data-lakes), which is what the lake manager
 * UI actually renders from (see hooks/data/dataLakes.ts). The single-lake GET redaction path is
 * covered separately in id-get-redaction.test.ts; that route serves `redactLakeForActor` output,
 * a different projection. This exercises the real listAllDataLakes -> toManageableConfig ->
 * toDataLakeConfig chain the list route uses, with only the repositories stubbed.
 */

const { captured, mockToAccessContext } = vi.hoisted(() => ({
  captured: {} as { get?: (req: unknown, res: unknown) => Promise<unknown> },
  mockToAccessContext: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      captured.get = fn;
      return chain;
    };
    chain.post = () => chain;
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/dataLakes/dataLakeScopes', () => ({
  DATA_LAKE_READ_SCOPES: [],
  assertDataLakeWriteScope: vi.fn(),
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: mockToAccessContext }));
vi.mock('@server/utils/resolveActiveOrg', () => ({ resolveActiveOrg: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {
    find: vi.fn().mockResolvedValue([
      {
        id: 'lake-1',
        slug: 'lake-1',
        name: 'Lake One',
        fileTagPrefix: 'lk:',
        datalakeTag: 'datalake:lake-1',
        createdByUserId: 'owner-1',
        status: 'active',
        origin: 'connector-fed',
      },
    ]),
  },
  dataLakeAccessGrantRepository: { listActiveByLakes: vi.fn().mockResolvedValue([]) },
  dataLakeProposalRepository: { countPendingByLakes: vi.fn().mockResolvedValue({}) },
  organizationRepository: { findIdsWithAdminRights: vi.fn().mockResolvedValue([]) },
  userRepository: { findByIds: vi.fn().mockResolvedValue([]) },
  adminSettingsRepository: { getSettingsValue: vi.fn().mockResolvedValue(false) },
  fallbackLakeSettingsRepository: { findByLakeIds: vi.fn().mockResolvedValue([]) },
}));

import '../index';

const makeRes = () => ({ json: vi.fn(), status: vi.fn().mockReturnThis() });

beforeEach(() => {
  mockToAccessContext.mockReset().mockResolvedValue({ userId: 'admin', isAdmin: true, userTags: [] });
});

describe('GET /api/data-lakes - list projection', () => {
  it('serves origin on each returned lake config', async () => {
    const res = makeRes();

    await captured.get!({ query: {}, logger: { warn: vi.fn(), error: vi.fn() }, user: { id: 'admin' } }, res);

    const body = res.json.mock.calls[0][0] as { data: { id: string; origin?: string }[] };
    const lake = body.data.find(l => l.id === 'lake-1');
    expect(lake?.origin).toBe('connector-fed');
  });
});
