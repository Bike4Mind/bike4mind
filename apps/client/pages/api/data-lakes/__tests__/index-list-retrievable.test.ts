// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { captured, mockToAccessContext, mockResolveScope, mockListAll, mockList } = vi.hoisted(() => ({
  captured: {} as { get?: (req: unknown, res: unknown) => Promise<unknown> },
  mockToAccessContext: vi.fn(),
  mockResolveScope: vi.fn(),
  mockListAll: vi.fn(),
  mockList: vi.fn(),
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
vi.mock('@server/dataLakes/resolveRetrievalLakeScope', () => ({ resolveRetrievalLakeScope: mockResolveScope }));
vi.mock('@server/utils/resolveActiveOrg', () => ({ resolveActiveOrg: vi.fn() }));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { listAllDataLakes: mockListAll, listDataLakes: mockList },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  dataLakeProposalRepository: {},
  organizationRepository: {},
  userRepository: {},
  adminSettingsRepository: {},
  fallbackLakeSettingsRepository: {},
}));

import '../index';

const ROWS = [
  { id: 'own', datalakeTag: 'datalake:own' },
  { id: 'other', datalakeTag: 'datalake:other' },
];
const scopeOf = (tags: string[], lakeViewComplete?: boolean) => ({
  lakeViewComplete,
  lakes: tags.map(datalakeTag => ({ datalakeTag })),
});

const makeRes = () => ({ json: vi.fn(), status: vi.fn().mockReturnThis() });
const makeReq = (query: Record<string, unknown> = {}) => ({
  query,
  logger: { warn: vi.fn(), error: vi.fn() },
  user: { id: 'caller' },
});
const bodyOf = (res: ReturnType<typeof makeRes>) =>
  (res.json.mock.calls[0][0] as { data: { id: string; retrievable?: boolean }[] }).data;

beforeEach(() => {
  mockToAccessContext.mockReset().mockResolvedValue({ userId: 'caller', isAdmin: true, userTags: [] });
  mockListAll.mockReset().mockResolvedValue(ROWS);
  mockList.mockReset().mockResolvedValue(ROWS);
  mockResolveScope.mockReset().mockResolvedValue(scopeOf(['datalake:own']));
});

describe('GET /api/data-lakes - retrievable label', () => {
  it('labels admin rows against the chat scope, resolved without the registry bypass', async () => {
    const req = makeReq();
    const res = makeRes();
    await captured.get!(req, res);

    expect(mockResolveScope).toHaveBeenCalledWith(req, { staticRegistryBypass: false });
    expect(bodyOf(res)).toEqual([
      { id: 'own', datalakeTag: 'datalake:own', retrievable: true },
      { id: 'other', datalakeTag: 'datalake:other', retrievable: false },
    ]);
  });

  it('labels non-admin rows too', async () => {
    mockToAccessContext.mockResolvedValue({ userId: 'caller', isAdmin: false, userTags: [] });
    const res = makeRes();
    await captured.get!(makeReq(), res);

    expect(mockList).toHaveBeenCalled();
    expect(bodyOf(res).map(l => l.retrievable)).toEqual([true, false]);
  });

  it('keeps the CALLER label when ?preauthorizableFor relabels admission for another user', async () => {
    const req = makeReq({ preauthorizableFor: '507f1f77bcf86cd799439011' });
    const res = makeRes();
    await captured.get!(req, res);

    expect(mockResolveScope).toHaveBeenCalledWith(req, { staticRegistryBypass: false });
    expect(bodyOf(res).map(l => l.retrievable)).toEqual([true, false]);
  });

  it('serves unlabeled rows and warns when the scope cannot be resolved', async () => {
    mockResolveScope.mockRejectedValue(new Error('entitlements down'));
    const req = makeReq();
    const res = makeRes();
    await captured.get!(req, res);

    expect(bodyOf(res)).toEqual(ROWS);
    expect(req.logger.warn).toHaveBeenCalled();
  });

  it('serves unlabeled rows when the scope reports an incomplete lake view', async () => {
    mockResolveScope.mockResolvedValue(scopeOf([], false));
    const res = makeRes();
    await captured.get!(makeReq(), res);

    expect(bodyOf(res).every(l => l.retrievable === undefined)).toBe(true);
  });
});
