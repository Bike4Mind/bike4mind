import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DataLakeConfig } from '@bike4mind/common';

// Hoisted so the vi.mock factories (hoisted above imports) can reference them.
const { mockGetDynamicDataLakeAccess, mockGetRequestEntitlements, mockGetUserEntitlements, mockFindMembershipOrgIds } =
  vi.hoisted(() => ({
    mockGetDynamicDataLakeAccess: vi.fn(),
    mockGetRequestEntitlements: vi.fn(),
    mockGetUserEntitlements: vi.fn(),
    mockFindMembershipOrgIds: vi.fn().mockResolvedValue([]),
  }));

// The services barrel is mocked with a factory rather than vi.spyOn: under ESM a spy on a
// re-exported binding does not reliably intercept the consumer's reference.
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { getDynamicDataLakeAccess: mockGetDynamicDataLakeAccess },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { __marker: 'dataLakeRepository' },
  organizationRepository: { __marker: 'organizationRepository', findMembershipOrgIds: mockFindMembershipOrgIds },
}));
vi.mock('@server/entitlements', () => ({
  getRequestEntitlements: mockGetRequestEntitlements,
  getUserEntitlements: mockGetUserEntitlements,
}));

import {
  resolveRetrievalLakeScope,
  resolveRetrievalLakeScopeForUser,
  withStaticRegistryBypass,
} from './resolveRetrievalLakeScope';
import { dataLakeRepository, organizationRepository } from '@bike4mind/database';
import type { EntitlementRequest } from '@server/entitlements';

type Scope = Parameters<typeof withStaticRegistryBypass>[0];

const scopeOf = (over: Partial<Scope> = {}): Scope => ({
  dataLakeTags: [],
  dataLakeTagPrefixes: [],
  scopedTagPrefixes: [],
  lakes: [],
  ...over,
});

// Synthetic registry: the real DATA_LAKES gains premium entries through an env seam at module
// load, so asserting against it directly would make these tests environment-dependent.
const lake = (id: string, fileTagPrefix: string): DataLakeConfig =>
  ({ id, slug: id, name: id, fileTagPrefix, datalakeTag: `datalake:${id}` }) as DataLakeConfig;

const REGISTRY: DataLakeConfig[] = [lake('opti-knowledge', 'opti:'), lake('house-kb', 'house:')];

// resolveRetrievalLakeScope reads only these fields off req.user.
const asReq = (user: { id: string; tags?: string[] | null; organizationId?: string; isAdmin?: boolean }) =>
  ({ user }) as unknown as EntitlementRequest;

describe('withStaticRegistryBypass', () => {
  /**
   * The bypass rebuilds the scope object, so the completeness flag needs carrying across. Losing it
   * here would report an incomplete lake view for ADMINS ONLY - turning off the session-scope
   * narrowing that keys on it for exactly the accounts that reach the most lakes.
   */
  it('carries lakeViewComplete through the widening, in both states', () => {
    expect(withStaticRegistryBypass(scopeOf({ lakeViewComplete: false }), REGISTRY).lakeViewComplete).toBe(false);
    expect(withStaticRegistryBypass(scopeOf({ lakeViewComplete: true }), REGISTRY).lakeViewComplete).toBe(true);
  });

  it('returns scopedTagPrefixes byte-identical - privilege never promotes a dynamic prefix', () => {
    const scoped = ['tenantx:'];
    const out = withStaticRegistryBypass(scopeOf({ scopedTagPrefixes: scoped }), REGISTRY);

    expect(out.scopedTagPrefixes).toEqual(scoped);
    // Both directions: not.toContain alone would pass if the prefix vanished entirely.
    expect(out.dataLakeTagPrefixes).not.toContain('tenantx:');
  });

  it('adds every registry tag and prefix to the OPEN buckets', () => {
    const out = withStaticRegistryBypass(scopeOf(), REGISTRY);

    expect(out.dataLakeTags).toEqual(['datalake:opti-knowledge', 'datalake:house-kb']);
    expect(out.dataLakeTagPrefixes).toEqual(['opti:', 'house:']);
    expect(out.scopedTagPrefixes).toEqual([]);
  });

  it('sources OPEN prefixes from the registry, never from the scope, under a shadowed tag', () => {
    // Mirrors what a DB lake minting a registry meta-tag would put in the scope. Keeping the
    // registry as the only source of OPEN prefixes is what stops its prefix being bypassed.
    // (getDynamicDataLakeAccess drops such a tag upstream; this asserts the second line.)
    const shadowed = scopeOf({
      dataLakeTags: ['datalake:opti-knowledge'],
      scopedTagPrefixes: ['evil:'],
    });

    const out = withStaticRegistryBypass(shadowed, REGISTRY);

    expect(out.dataLakeTagPrefixes).toContain('opti:');
    expect(out.dataLakeTagPrefixes).not.toContain('evil:');
    expect(out.scopedTagPrefixes).toEqual(['evil:']);
    // The tag itself is passed through, so it must not be double-added by the union either.
    expect(out.dataLakeTags.filter(t => t === 'datalake:opti-knowledge')).toHaveLength(1);
  });

  it('does not promote a scoped prefix that collides with a registry prefix string', () => {
    const out = withStaticRegistryBypass(scopeOf({ scopedTagPrefixes: ['opti:'] }), REGISTRY);

    expect(out.scopedTagPrefixes).toEqual(['opti:']);
    // 'opti:' appears in OPEN because the REGISTRY put it there, and exactly once.
    expect(out.dataLakeTagPrefixes.filter(p => p === 'opti:')).toHaveLength(1);
  });

  it('dedupes scope-first so an already-entitled caller sees each entry once', () => {
    const out = withStaticRegistryBypass(
      scopeOf({ dataLakeTags: ['datalake:opti-knowledge'], dataLakeTagPrefixes: ['opti:'] }),
      REGISTRY
    );

    expect(out.dataLakeTags).toEqual(['datalake:opti-knowledge', 'datalake:house-kb']);
    expect(out.dataLakeTagPrefixes).toEqual(['opti:', 'house:']);
  });

  it('keeps scope entries ahead of registry entries', () => {
    // A scope-only entry makes the two concat orders distinguishable; without it every
    // fixture above is order-degenerate and the documented ordering is unpinned.
    const out = withStaticRegistryBypass(
      scopeOf({ dataLakeTags: ['datalake:dyn'], dataLakeTagPrefixes: ['dyn-open:'] }),
      REGISTRY
    );

    expect(out.dataLakeTags).toEqual(['datalake:dyn', 'datalake:opti-knowledge', 'datalake:house-kb']);
    expect(out.dataLakeTagPrefixes).toEqual(['dyn-open:', 'opti:', 'house:']);
  });

  it('widens the per-lake entries alongside the tags, so a privileged caller can count what it searches', () => {
    const out = withStaticRegistryBypass(scopeOf(), REGISTRY);

    expect(out.lakes.map(l => l.datalakeTag)).toEqual(['datalake:opti-knowledge', 'datalake:house-kb']);
    // Registry-sourced entries carry no membership scope - they have no creator to anchor one to.
    // A fourth pinned property (#2243): since lakeMembershipsFrom (getDynamicDataLakeTags.ts) is
    // exactly `lakes.flatMap(l => l.membership ? [l.membership] : [])`, "no lake here has a
    // membership" IS "lakeMembershipsFrom(out.lakes) === []" - the injected lakes contribute no
    // retrieval arm at all, unanchored or otherwise.
    expect(out.lakes.every(l => l.source === 'registry' && !l.membership)).toBe(true);
  });

  it('keeps a lake the scope already resolved, rather than replacing it with a registry entry', () => {
    // The scope's own entry may carry a membership scope; a registry copy of the same tag would
    // count the lake through the weaker prefix arm instead.
    const resolved = {
      id: 'opti-knowledge',
      name: 'Opti',
      slug: 'opti-knowledge',
      datalakeTag: 'datalake:opti-knowledge',
      fileTagPrefix: 'opti:',
      membership: { datalakeTag: 'datalake:opti-knowledge', fileTagPrefix: 'opti:', creatorUserId: 'owner1' },
      source: 'dynamic' as const,
    };

    const out = withStaticRegistryBypass(scopeOf({ lakes: [resolved] }), REGISTRY);

    expect(out.lakes.filter(l => l.datalakeTag === 'datalake:opti-knowledge')).toEqual([resolved]);
    expect(out.lakes).toHaveLength(2);
  });

  it('is a no-op on the OPEN buckets for an empty registry', () => {
    const scope = scopeOf({ dataLakeTags: ['datalake:dyn'], scopedTagPrefixes: ['dyn:'] });

    expect(withStaticRegistryBypass(scope, [])).toEqual(scope);
  });
});

describe('resolveRetrievalLakeScope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRequestEntitlements.mockResolvedValue([]);
    mockGetDynamicDataLakeAccess.mockResolvedValue(scopeOf());
  });

  afterEach(() => {
    // A couple of tests below assign a spy directly onto the mocked module singleton (it has no
    // findMembershipOrgIds by default); strip it so a later test never inherits a leftover spy.
    delete (organizationRepository as unknown as { findMembershipOrgIds?: unknown }).findMembershipOrgIds;
  });

  it('calls the shared resolver with exactly the context the chat tool passes', async () => {
    mockGetRequestEntitlements.mockResolvedValue(['optihashi:pro']);

    await resolveRetrievalLakeScope(asReq({ id: 'u1', tags: ['Opti'], organizationId: 'org1' }));

    // Deep equality, not objectContaining: an extra or missing field here IS the divergence
    // this ticket exists to close. This mirrors the ToolContext fields the chat tool hands the
    // same resolver; it is a literal, so a change on the chat side would not fail here. Threads
    // organizationRepository so the resolver can derive membership itself - user.organizationId
    // (the selected-org pointer) is NOT forwarded (#1674).
    expect(mockGetDynamicDataLakeAccess).toHaveBeenCalledWith({
      db: {
        dataLakes: dataLakeRepository,
        organizations: expect.objectContaining({ findMembershipOrgIds: expect.any(Function) }),
      },
      user: { id: 'u1', tags: ['Opti'] },
      entitlementKeys: ['optihashi:pro'],
    });
  });

  it('returns the shared resolver output untouched for a non-privileged caller', async () => {
    const resolved = scopeOf({
      dataLakeTags: ['datalake:dyn'],
      dataLakeTagPrefixes: ['opti:'],
      scopedTagPrefixes: ['dyn:'],
    });
    mockGetDynamicDataLakeAccess.mockResolvedValue(resolved);

    const out = await resolveRetrievalLakeScope(asReq({ id: 'u1', tags: ['Opti'] }));

    // Identity with the chat tool's own scope is the acceptance criterion.
    expect(out).toEqual(resolved);
  });

  it('gives an admin the whole static registry while leaving scoped prefixes alone', async () => {
    mockGetDynamicDataLakeAccess.mockResolvedValue(scopeOf({ scopedTagPrefixes: ['dyn:'] }));

    const out = await resolveRetrievalLakeScope(asReq({ id: 'admin', isAdmin: true }));

    expect(out.dataLakeTags.length).toBeGreaterThan(0);
    expect(out.scopedTagPrefixes).toEqual(['dyn:']);
  });

  it('treats a developer tag as privileged too', async () => {
    const out = await resolveRetrievalLakeScope(asReq({ id: 'u1', tags: ['Developer'] }));

    expect(out.dataLakeTags.length).toBeGreaterThan(0);
  });

  it('resolves entitlements even for an admin, so a gated DYNAMIC lake still matches', async () => {
    // The registry bypass covers static lakes only; skipping key resolution would leave an
    // admin seeing fewer dynamic lakes than a plain subscriber holding the same key.
    mockGetRequestEntitlements.mockResolvedValue(['acme:pro']);

    await resolveRetrievalLakeScope(asReq({ id: 'admin', isAdmin: true }));

    expect(mockGetRequestEntitlements).toHaveBeenCalled();
    expect(mockGetDynamicDataLakeAccess.mock.calls[0][0].entitlementKeys).toEqual(['acme:pro']);
  });

  it('forwards absent tags explicitly rather than falsy-coercing them', async () => {
    await resolveRetrievalLakeScope(asReq({ id: 'u1', tags: null }));

    expect(mockGetDynamicDataLakeAccess).toHaveBeenCalledWith({
      db: {
        dataLakes: dataLakeRepository,
        organizations: expect.objectContaining({ findMembershipOrgIds: expect.any(Function) }),
      },
      user: { id: 'u1', tags: [] },
      entitlementKeys: [],
    });
  });

  it('never forwards user.organizationId, regardless of its shape (#1343 concern now lives in the shared resolver)', async () => {
    // A .populate('organizationId') upstream would hand req.user a full Organization doc; this
    // used to need normalizing at this seam (#1343). It no longer matters what shape arrives here -
    // organizationId is not part of what this seam forwards at all (#1674): membership is resolved
    // inside getDynamicDataLakeAccess from user.id via the threaded organizationRepository.
    const populatedOrg = { _id: { toHexString: () => 'org-hex' }, name: 'Acme' } as unknown as string;
    await resolveRetrievalLakeScope(asReq({ id: 'u1', tags: ['Opti'], organizationId: populatedOrg }));

    expect(mockGetDynamicDataLakeAccess).toHaveBeenCalledWith({
      db: {
        dataLakes: dataLakeRepository,
        organizations: expect.objectContaining({ findMembershipOrgIds: expect.any(Function) }),
      },
      user: { id: 'u1', tags: ['Opti'] },
      entitlementKeys: [],
    });
  });

  it('serves the resolver membership lookup from the request memo for the requesting user', async () => {
    const req = asReq({ id: 'u1', tags: ['Opti'] }) as EntitlementRequest & { membershipOrgIds?: string[] };
    // The repository mock is the __marker stub; give it a spy so a fall-through call is visible.
    organizationRepository.findMembershipOrgIds = vi.fn().mockResolvedValue([]);

    await resolveRetrievalLakeScope(req);
    const { db } = mockGetDynamicDataLakeAccess.mock.calls.at(-1)![0];

    req.membershipOrgIds = ['memoized-org'];
    await expect(db.organizations.findMembershipOrgIds(req.user!.id)).resolves.toEqual(['memoized-org']);
    expect(organizationRepository.findMembershipOrgIds).not.toHaveBeenCalled();
  });

  it('does not serve another user id from the request memo (cross-user leak guard)', async () => {
    const req = asReq({ id: 'u1', tags: ['Opti'] }) as EntitlementRequest & { membershipOrgIds?: string[] };
    organizationRepository.findMembershipOrgIds = vi.fn().mockResolvedValue(['other-org']);

    await resolveRetrievalLakeScope(req);
    const { db } = mockGetDynamicDataLakeAccess.mock.calls.at(-1)![0];

    // The memo was seeded for 'u1'; a lookup for a different user must still hit the repository
    // rather than fall through to the memoized value - collapsing this to "always use the memo"
    // would leak one user's org membership onto another's request.
    req.membershipOrgIds = ['memoized-org'];
    await expect(db.organizations.findMembershipOrgIds('other-user')).resolves.toEqual(['other-org']);
    expect(organizationRepository.findMembershipOrgIds).toHaveBeenCalledWith('other-user');
  });
});

/**
 * The request-free entry point. It exists because most session-creation call sites are not
 * request-scoped (a manager taking { user, logger }, a queue handler, an overlay service), and
 * deriving a session's lake scope only where a `req` happened to be in hand meant the lake-aware
 * derivation ran on one of ten createSession call sites.
 */
describe('resolveRetrievalLakeScopeForUser', () => {
  beforeEach(() => {
    // Re-attached per test: an earlier describe in this file deletes this method off the shared
    // mock object as part of its own setup, and that mutation persists across tests.
    (organizationRepository as unknown as { findMembershipOrgIds: unknown }).findMembershipOrgIds =
      mockFindMembershipOrgIds;
    mockFindMembershipOrgIds.mockClear().mockResolvedValue([]);
    mockGetUserEntitlements.mockClear().mockResolvedValue([]);
    mockGetDynamicDataLakeAccess.mockClear().mockResolvedValue({
      dataLakeTags: ['datalake:acme'],
      dataLakeTagPrefixes: [],
      scopedTagPrefixes: [],
      lakes: [],
    });
  });

  it('resolves entitlements from the USER when no request memo is supplied', async () => {
    await resolveRetrievalLakeScopeForUser({ id: 'u1', tags: [] } as never);
    expect(mockGetUserEntitlements).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }));
  });

  it('prefers a caller-supplied memo over re-resolving - the request path must not pay twice', async () => {
    await resolveRetrievalLakeScopeForUser({ id: 'u1', tags: [] } as never, { entitlementKeys: ['k'] });
    expect(mockGetUserEntitlements).not.toHaveBeenCalled();
    expect(mockGetDynamicDataLakeAccess).toHaveBeenCalledWith(expect.objectContaining({ entitlementKeys: ['k'] }));
  });

  it('falls back to the organization repository for membership when given no memo', async () => {
    await resolveRetrievalLakeScopeForUser({ id: 'u1', tags: [] } as never);
    const arg = mockGetDynamicDataLakeAccess.mock.calls[0][0];
    await arg.db.organizations.findMembershipOrgIds('u1');
    expect(mockFindMembershipOrgIds).toHaveBeenCalledWith('u1');
  });

  it('applies the same static-registry bypass for a privileged caller as the request path', async () => {
    const out = await resolveRetrievalLakeScopeForUser({ id: 'u1', tags: [], isAdmin: true } as never);
    // Non-privileged callers get the resolved set verbatim; an admin additionally gets the registry.
    expect(out.dataLakeTags).toContain('datalake:acme');
  });
});
