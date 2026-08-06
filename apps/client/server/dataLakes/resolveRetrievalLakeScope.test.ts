import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DataLakeConfig } from '@bike4mind/common';

// Hoisted so the vi.mock factories (hoisted above imports) can reference them.
const { mockGetDynamicDataLakeAccess, mockGetRequestEntitlements } = vi.hoisted(() => ({
  mockGetDynamicDataLakeAccess: vi.fn(),
  mockGetRequestEntitlements: vi.fn(),
}));

// The services barrel is mocked with a factory rather than vi.spyOn: under ESM a spy on a
// re-exported binding does not reliably intercept the consumer's reference.
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { getDynamicDataLakeAccess: mockGetDynamicDataLakeAccess },
}));
vi.mock('@bike4mind/database', () => ({ dataLakeRepository: { __marker: 'dataLakeRepository' } }));
vi.mock('@server/entitlements', () => ({ getRequestEntitlements: mockGetRequestEntitlements }));

import { resolveRetrievalLakeScope, withStaticRegistryBypass } from './resolveRetrievalLakeScope';
import { dataLakeRepository } from '@bike4mind/database';
import type { EntitlementRequest } from '@server/entitlements';

type Scope = { dataLakeTags: string[]; dataLakeTagPrefixes: string[]; scopedTagPrefixes: string[] };

const scopeOf = (over: Partial<Scope> = {}): Scope => ({
  dataLakeTags: [],
  dataLakeTagPrefixes: [],
  scopedTagPrefixes: [],
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

  it('calls the shared resolver with exactly the context the chat tool passes', async () => {
    mockGetRequestEntitlements.mockResolvedValue(['optihashi:pro']);

    await resolveRetrievalLakeScope(asReq({ id: 'u1', tags: ['Opti'], organizationId: 'org1' }));

    // Deep equality, not objectContaining: an extra or missing field here IS the divergence
    // this ticket exists to close. This mirrors the ToolContext fields the chat tool hands the
    // same resolver; it is a literal, so a change on the chat side would not fail here.
    expect(mockGetDynamicDataLakeAccess).toHaveBeenCalledWith({
      db: { dataLakes: dataLakeRepository },
      user: { id: 'u1', tags: ['Opti'], organizationId: 'org1' },
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

  it('forwards absent tags and org explicitly rather than falsy-coercing them', async () => {
    await resolveRetrievalLakeScope(asReq({ id: 'u1', tags: null }));

    expect(mockGetDynamicDataLakeAccess).toHaveBeenCalledWith({
      db: { dataLakes: dataLakeRepository },
      user: { id: 'u1', tags: [], organizationId: undefined },
      entitlementKeys: [],
    });
  });

  it('normalizes a populated-document organizationId at the seam (#1343)', async () => {
    // A .populate('organizationId') upstream would hand req.user a full Organization doc. It must
    // reach the shared resolver as its hex string, not "[object Object]", mirroring toAccessContext.
    const populatedOrg = { _id: { toHexString: () => 'org-hex' }, name: 'Acme' } as unknown as string;
    await resolveRetrievalLakeScope(asReq({ id: 'u1', tags: ['Opti'], organizationId: populatedOrg }));

    expect(mockGetDynamicDataLakeAccess).toHaveBeenCalledWith({
      db: { dataLakes: dataLakeRepository },
      user: { id: 'u1', tags: ['Opti'], organizationId: 'org-hex' },
      entitlementKeys: [],
    });
  });

  it('normalizes an empty-string organizationId to undefined (org-less), not literal "" (#1343)', async () => {
    // An empty string is not a valid org id: normalizeId('') returns undefined, so the caller is
    // treated as org-less (only org-less lakes resolve) rather than filtering on a literal "".
    // This is the intended, safer behavior - locking it in so the delta from the old `?? undefined`
    // pass-through stays deliberate.
    await resolveRetrievalLakeScope(asReq({ id: 'u1', tags: ['Opti'], organizationId: '' }));

    expect(mockGetDynamicDataLakeAccess).toHaveBeenCalledWith({
      db: { dataLakes: dataLakeRepository },
      user: { id: 'u1', tags: ['Opti'], organizationId: undefined },
      entitlementKeys: [],
    });
  });
});
