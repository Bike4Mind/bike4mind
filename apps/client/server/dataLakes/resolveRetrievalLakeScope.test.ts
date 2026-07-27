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

  it('sources OPEN prefixes from the registry, never from the scope, even under id shadowing', () => {
    // A DB lake shadowing a registry id must not get its user-controlled prefix bypassed.
    const shadowed = scopeOf({
      dataLakeTags: ['datalake:opti-knowledge'],
      scopedTagPrefixes: ['evil:'],
    });

    const out = withStaticRegistryBypass(shadowed, REGISTRY);

    expect(out.dataLakeTagPrefixes).toContain('opti:');
    expect(out.dataLakeTagPrefixes).not.toContain('evil:');
    expect(out.scopedTagPrefixes).toEqual(['evil:']);
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
    // this ticket exists to close.
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

  it('KNOWN GAP: an owner does not get their own gated lake back', async () => {
    // getDynamicDataLakeAccess re-filters DB lakes through lakeMatchesAccess, so a lake the
    // caller created but whose requiredUserTag they lack is dropped. The browse resolver in
    // ./index.ts deliberately does NOT do this, so /articles still lists such a lake while
    // semantic search hides it. Pre-existing in the shared resolver, tracked separately -
    // pinned here so the fix shows up as a deliberate diff. Tracked in #976.
    mockGetDynamicDataLakeAccess.mockResolvedValue(scopeOf());

    const out = await resolveRetrievalLakeScope(asReq({ id: 'owner', tags: [] }));

    expect(out.dataLakeTags).toEqual([]);
  });
});
