// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `?preauthorizableFor=<userId>` on GET /api/data-lakes (#2945).
 *
 * The admin key-mint picker needs `canPreauthorize` resolved against the user the key is being
 * minted FOR, because `generate-api-key` screens the requested binding against that user
 * (`filterStillManagedLakes(lakes, targetUserId)`). Labelled with the caller's own rung instead,
 * the picker offered a platform admin every lake on the instance and the mint route then refused
 * almost all of them with a 400.
 *
 * What this pins at this seam: the parameter reaches the service, it is admin-only, and a
 * malformed id is refused before it can reach the org-admin lookup as a CastError.
 */

// `captured` is hoisted with the mocks: vi.mock factories are lifted above ordinary consts, so a
// plain declaration here is still in its TDZ when the baseApi factory below runs.
const { mockListAll, mockList, mockToAccessContext, REPO, captured } = vi.hoisted(() => ({
  mockListAll: vi.fn().mockResolvedValue([]),
  mockList: vi.fn().mockResolvedValue([]),
  mockToAccessContext: vi.fn(),
  REPO: { __tag: 'repo' },
  captured: {} as { get?: (req: unknown, res: unknown) => Promise<unknown> },
}));

// The route is baseApi().use(...).get(fn).post(fn), so `get` must return the chain for `.post` to
// exist. Capture the GET handler on the way through rather than reading it off the default export.
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
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { listAllDataLakes: mockListAll, listDataLakes: mockList, createDataLake: vi.fn() },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: REPO,
  dataLakeAccessGrantRepository: REPO,
  dataLakeProposalRepository: REPO,
  organizationRepository: REPO,
  userRepository: REPO,
  adminSettingsRepository: REPO,
  fallbackLakeSettingsRepository: REPO,
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: mockToAccessContext }));
vi.mock('@server/utils/resolveActiveOrg', () => ({ resolveActiveOrg: vi.fn() }));

import '@pages/api/data-lakes/index';

const TARGET = '6a6b019b3f760341bec99409';

const makeRes = () => ({ json: vi.fn(), status: vi.fn().mockReturnThis() });
const run = (query: Record<string, unknown>) =>
  captured.get!({ query, logger: { warn: vi.fn(), error: vi.fn() }, user: { id: 'caller' } }, makeRes());

beforeEach(() => {
  mockListAll.mockClear().mockResolvedValue([]);
  mockList.mockClear().mockResolvedValue([]);
  mockToAccessContext.mockReset().mockResolvedValue({ userId: 'admin', isAdmin: true });
});

describe('GET /api/data-lakes - preauthorizableFor', () => {
  it('threads the target id to listAllDataLakes for an admin', async () => {
    await run({ preauthorizableFor: TARGET });

    expect(mockListAll).toHaveBeenCalledTimes(1);
    expect(mockListAll.mock.calls[0][1]).toMatchObject({ preauthorizeForUserId: TARGET });
  });

  it('leaves the option undefined when the parameter is absent', async () => {
    await run({});

    expect(mockListAll.mock.calls[0][1].preauthorizeForUserId).toBeUndefined();
  });

  it('refuses a non-admin outright rather than silently dropping the parameter', async () => {
    // Dropping it would answer with the CALLER's admission labels, which is the exact mislabeling
    // the parameter exists to remove - so it has to fail loudly, not degrade.
    mockToAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false });

    await expect(run({ preauthorizableFor: TARGET })).rejects.toThrow('preauthorizableFor is admin-only');
    expect(mockListAll).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  // Every value class that is PRESENT but not one well-formed id, in one table. Each is refused
  // rather than dropped: a dropped param answers with the caller's own admission labels, and the
  // admin would first learn of it as a 400 from the mint route, long after the picker misled them.
  it.each([
    ['a malformed id, which would reach the org-admin lookup as a CastError', 'not-an-id'],
    // A bare `?preauthorizableFor=` is a present, EMPTY string - a truthiness guard would skip both
    // checks and hand '' to the service, where it reads as "no override" only because the service
    // normalizes it.
    ['a present-but-empty value, which is a string and so passes a truthiness guard', ''],
    // Express gives `?a=1&a=2` as an array.
    ['a repeated parameter, which arrives as an array', [TARGET, TARGET]],
    ['a nested object parameter', { $ne: null }],
  ])('refuses %s', async (_label, value) => {
    await expect(run({ preauthorizableFor: value })).rejects.toThrow('preauthorizableFor must be a single user id');
    expect(mockListAll).not.toHaveBeenCalled();
  });

  it('still routes a non-admin to the access-scoped list', async () => {
    mockToAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false });

    await run({});

    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockListAll).not.toHaveBeenCalled();
  });
});
