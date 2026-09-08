// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DATA_LAKES } from '@bike4mind/common';

/**
 * Link 2 of the count/browse parity chain (#2265): the single-lake browse must scope a REGISTRY
 * lake through the shared `registryMembershipScope`, not a hand-rolled `dataLakeTags` +
 * `dataLakeTagPrefixes` pair.
 *
 * Why the chain rather than one test comparing two numbers: the two surfaces live in different
 * packages and neither can drive the other. So each link is asserted against the SHARED function,
 * and the chain closes transitively:
 *
 *   count tool  -> passes `ResolvedLakeAccess.membership` verbatim
 *                  (b4m-core/services/.../knowledgeBaseCount/index.test.ts)
 *   resolver    -> attaches `registryMembershipScope(config)` to a registry lake
 *                  (b4m-core/services/.../getDynamicDataLakeTags.test.ts)
 *   browse      -> builds `registryMembershipScope(lake)`               <- THIS FILE
 *
 * Every link compares against the real function; none of them restates the predicate as a literal.
 * A literal would be exactly the independently-written second copy whose drift produced the
 * `0 vs 86` under-count on a built-in lake, so asserting one here would defeat the test.
 *
 * The assertion is on the SCOPE, and on the Mongo predicate derived from it - never on a count.
 * `dataLakeMembershipParity.integration.test.ts` records why: its fixture has two liveness errors
 * that cancel to equal totals over different sets, so a cardinality assertion passes against a
 * broken predicate. The predicate determines the set; compare that.
 */

const { mockAssertLakeAccess, mockSearch, mockRecordLakeAccessEvent } = vi.hoisted(() => ({
  mockAssertLakeAccess: vi.fn(),
  mockSearch: vi.fn(),
  mockRecordLakeAccessEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = (fn: unknown) => fn;
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => undefined }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: vi.fn().mockResolvedValue({}) }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ getSignedUrl: vi.fn() }) }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
  dataLakeAccessGrantRepository: {},
  dataLakeRepository: {},
  fabFileRepository: {},
  projectRepository: {},
  userRepository: {},
  lakeAccessEventRepository: { record: vi.fn().mockResolvedValue(undefined) },
}));

// `isFallbackLake`, `lakeMembershipScope` and `registryMembershipScope` come from the REAL modules:
// they are the shared code whose use is the thing under test, so stubbing them would make this
// assert only that the route calls a mock. Only the access gate and the search primitive are faked.
vi.mock('@bike4mind/services', async () => {
  const assertLakeAccessModule =
    await import('../../../../../../../b4m-core/services/src/dataLakeService/assertLakeAccess');
  const scopeModule = await import('../../../../../../../b4m-core/services/src/dataLakeService/lakeMembershipScope');
  return {
    dataLakeService: {
      assertLakeAccess: mockAssertLakeAccess,
      isFallbackLake: assertLakeAccessModule.isFallbackLake,
      lakeMembershipScope: scopeModule.lakeMembershipScope,
      registryMembershipScope: scopeModule.registryMembershipScope,
      recordLakeAccessEvent: mockRecordLakeAccessEvent,
    },
    fabFilesService: { search: mockSearch },
  };
});

import handler from '@pages/api/data-lakes/[id]/articles';
// Deep relative, not via the package barrels: `@bike4mind/database` is mocked above, and
// `@bike4mind/services` is too - importing either by name here would resolve to the mock and the
// comparison would be against a stub instead of the real predicate.
import {
  registryMembershipScope,
  lakeMembershipScope,
} from '../../../../../../../b4m-core/services/src/dataLakeService/lakeMembershipScope';
import { buildDataLakeMembershipFilter } from '../../../../../../../packages/database/src/queries/dataLakeLifecycleScope';

type RouteHandler = (req: unknown, res: unknown) => Promise<unknown>;
const route = handler as unknown as RouteHandler;

/** A real registry entry, so `isFallbackLake` decides by its own config-id rule rather than a flag. */
const REGISTRY_LAKE = DATA_LAKES.find(dl => dl.id === 'opti-knowledge')!;

const makeReq = (id: string) => ({
  query: { id },
  user: { id: 'viewer-1', groups: ['g1'] },
  logger: { warn: vi.fn(), error: vi.fn() },
});
const makeRes = () => {
  const json = vi.fn();
  return { json, res: { json } as never };
};

/**
 * The scope the route handed the search primitive on its single `lakeMemberships` arm.
 * Argument 3 is fabFilesService.search's ownership-options bag (0 userId, 1 query, 2 adapters).
 */
const capturedScope = () => {
  expect(mockSearch).toHaveBeenCalledTimes(1);
  const options = mockSearch.mock.calls[0][3];
  expect(options.lakeMemberships).toHaveLength(1);
  return { options, scope: options.lakeMemberships[0] };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSearch.mockResolvedValue({ data: [], total: 0, hasMore: false });
});

describe('GET /api/data-lakes/:id/articles registry-lake scope (count/browse parity)', () => {
  it('scopes a registry lake through registryMembershipScope, with no hand-rolled tag pair', async () => {
    mockAssertLakeAccess.mockResolvedValue(REGISTRY_LAKE);

    await route(makeReq(REGISTRY_LAKE.id), makeRes().res);

    const { options, scope } = capturedScope();
    expect(scope).toEqual(registryMembershipScope(REGISTRY_LAKE));
    // The carve-out this replaced. Both surfaces used to pass these instead, and the count's copy
    // is what drifted - so their absence here is half of what keeps the two in step.
    expect(options).not.toHaveProperty('dataLakeTags');
    expect(options).not.toHaveProperty('dataLakeTagPrefixes');
    // Single-lake view: the broad owner/shared arms stay dropped, or the number stops being
    // this lake's total.
    expect(options.restrictToDataLake).toBe(true);
  });

  it('resolves the SAME predicate the count surface builds from the same lake', async () => {
    mockAssertLakeAccess.mockResolvedValue(REGISTRY_LAKE);

    await route(makeReq(REGISTRY_LAKE.id), makeRes().res);

    // `count_knowledge_base` passes `ResolvedLakeAccess.membership` through untouched, and the
    // resolver sets that to `registryMembershipScope(config)` - so this IS the count's scope.
    // Comparing the derived Mongo predicate rather than the scope alone catches a drift that
    // changes what matches while leaving the scope shape intact.
    const countScope = registryMembershipScope(REGISTRY_LAKE);
    const { scope: browseScope } = capturedScope();

    expect(buildDataLakeMembershipFilter(browseScope)).toEqual(buildDataLakeMembershipFilter(countScope));
    // Both arms present: an unanchored prefix arm beside the meta-tag is precisely what a registry
    // lake needs and what narrowing it "for safety" would drop - the original under-count. Asserted
    // by shape and by what the regex MATCHES, not against a literal pattern, so the anchoring and
    // escaping stay `buildDataLakeMembershipFilter`'s business.
    const predicate = buildDataLakeMembershipFilter(browseScope) as { $or: Record<string, never>[] };
    expect(predicate.$or).toHaveLength(2);
    expect(predicate.$or[0]).toEqual({ 'tags.name': REGISTRY_LAKE.datalakeTag });
    const prefixArm = predicate.$or[1] as unknown as { 'tags.name': { $regex: RegExp } };
    expect(prefixArm['tags.name'].$regex.test(`${REGISTRY_LAKE.fileTagPrefix}solvers`)).toBe(true);
    // No ownership conjunct on that arm - a registry lake is a shared KB with many contributors.
    expect(Object.keys(prefixArm)).toEqual(['tags.name']);
  });

  it('still scopes a DB lake through the creator-anchored scope, so the kinds are not collapsed', async () => {
    const dbLake = {
      id: '507f1f77bcf86cd799439011',
      name: 'Acme Docs',
      slug: 'acme',
      datalakeTag: 'datalake:org1:acme',
      fileTagPrefix: 'acme:',
      createdByUserId: 'creator-1',
    };
    mockAssertLakeAccess.mockResolvedValue(dbLake);

    await route(makeReq(dbLake.id), makeRes().res);

    const { scope } = capturedScope();
    expect(scope).toEqual(lakeMembershipScope(dbLake));
    expect(scope.kind).toBe('owned');
  });
});
