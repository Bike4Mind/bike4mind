import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EntitlementRequest } from '@server/entitlements';

// Hoisted so the vi.mock factories (hoisted above imports) can reference them.
const { mockListDataLakes, mockListAllDataLakes, mockGetRequestEntitlements, mockFindMembershipOrgIds } = vi.hoisted(
  () => ({
    mockListDataLakes: vi.fn(),
    mockListAllDataLakes: vi.fn(),
    mockGetRequestEntitlements: vi.fn(),
    mockFindMembershipOrgIds: vi.fn(),
  })
);

// toAccessContext is deliberately NOT mocked - the point of these tests is that
// resolveAccessibleLakes goes through it, so the entitlement keys reach the DB filter.
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { listDataLakes: mockListDataLakes, listAllDataLakes: mockListAllDataLakes },
  fabFilesService: { search: vi.fn() },
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { settings: true },
  dataLakeAccessGrantRepository: { grants: true },
  dataLakeRepository: {},
  fabFileRepository: {},
  projectRepository: {},
  userRepository: {},
  // toAccessContext resolves the membership set (#1674) and the org-admin set (#1668) here.
  organizationRepository: {
    findMembershipOrgIds: mockFindMembershipOrgIds,
    findIdsWithAdminRights: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('@server/entitlements', () => ({ getRequestEntitlements: mockGetRequestEntitlements }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ getSignedUrl: vi.fn() }) }));

import { resolveAccessibleLakes } from './index';

const asReq = (user: Record<string, unknown>) => ({ user }) as unknown as EntitlementRequest;

describe('resolveAccessibleLakes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListDataLakes.mockResolvedValue([]);
    mockListAllDataLakes.mockResolvedValue([]);
    mockGetRequestEntitlements.mockResolvedValue([]);
    mockFindMembershipOrgIds.mockResolvedValue([]);
  });

  it('threads the resolved entitlement keys into the DB filter, and scopes static lakes by the same keys', async () => {
    // Building the AccessContext inline used to drop entitlementKeys, so findAccessible got no
    // entitlement arm and browse lost a lake gated by requiredEntitlement alone - a lake
    // retrieval kept, inverting the documented "browse is the wider surface" invariant. This is
    // the assertion that discriminates: the old inline literal carried no keys at all.
    mockGetRequestEntitlements.mockResolvedValue(['optihashi:pro']);
    mockFindMembershipOrgIds.mockResolvedValue(['org1']);

    const lakes = await resolveAccessibleLakes(asReq({ id: 'u1', tags: [], organizationId: 'org1' }));

    expect(mockListDataLakes).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        isAdmin: false,
        entitlementKeys: ['optihashi:pro'],
        organizationIds: ['org1'],
      }),
      expect.anything()
    );
    // The same keys drive the static filter, so the two halves of the merge cannot disagree about
    // what the caller holds - the built-in opti lake is entitlement-gated and needs no tag.
    expect(lakes.map(l => l.id)).toContain('opti-knowledge');
  });

  it('skips the entitlement read for an admin and takes the list-all path', async () => {
    // A regression pin rather than coverage of the context change: the admin path behaved this
    // way before it too, and must keep doing so - the entitlement read is pure overhead for an
    // admin, whose gates grant regardless.
    await resolveAccessibleLakes(asReq({ id: 'admin', tags: [], isAdmin: true }));

    expect(mockListAllDataLakes).toHaveBeenCalledTimes(1);
    expect(mockListDataLakes).not.toHaveBeenCalled();
    expect(mockGetRequestEntitlements).not.toHaveBeenCalled();
  });

  // listDataLakes degrades both grant reads to empty when the repo is absent, so a lake held by
  // an owner or curator grant was missing from every browse surface - articles, tag-counts, the
  // rlm-answer gate, and the file-access check in pages/api/files/[id] - while the read gate
  // admitted it. Non-admin only: listAllDataLakes never calls resolveEnforceReadGrants or
  // grantedLakeIdsFor, so an admin already sees every draft/active lake with or without either
  // adapter - passing them would just discard a wasted grant read (see the admin case below).
  it('threads the grants and settings adapters on the non-admin path', async () => {
    await resolveAccessibleLakes(asReq({ id: 'u1', tags: [] }));

    expect(mockListDataLakes).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        db: expect.objectContaining({
          dataLakeAccessGrants: { grants: true },
          // Settings too, unlike the Slack `list` reply which omits it on purpose: browse is a READ
          // surface, so it must follow the EnforceLakeReadGrants cutover instead of freezing at
          // owner/curator and hiding a reader-granted lake the gate would admit.
          settings: { settings: true },
        }),
      })
    );
  });

  // The admin branch gets neither adapter: listAllDataLakes can't be "silently degraded" by their
  // absence because it never narrows by grant or settings in the first place (find() over every
  // draft/active lake). Pinned so a well-meant "add them for consistency" doesn't reintroduce a
  // wide indexed grants read whose result is never used on this branch.
  it('passes no grants or settings adapter on the admin path', async () => {
    await resolveAccessibleLakes(asReq({ id: 'admin', tags: [], isAdmin: true }));

    expect(mockListAllDataLakes).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        db: { dataLakes: expect.anything() },
      })
    );
  });

  it('still passes no `users` adapter, which browse must not pay for', async () => {
    // The owner-name lookup exists for the manager list, which renders an owner; browse never does.
    // Pinned because the grants/settings addition edits exactly this adapter object.
    await resolveAccessibleLakes(asReq({ id: 'u1', tags: [] }));

    const [, adapters] = mockListDataLakes.mock.calls[0] as [unknown, { db: Record<string, unknown> }];
    expect(adapters.db).not.toHaveProperty('users');
  });
});
