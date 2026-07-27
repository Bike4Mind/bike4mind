import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EntitlementRequest } from '@server/entitlements';

// Hoisted so the vi.mock factories (hoisted above imports) can reference them.
const { mockListDataLakes, mockListAllDataLakes, mockGetRequestEntitlements } = vi.hoisted(() => ({
  mockListDataLakes: vi.fn(),
  mockListAllDataLakes: vi.fn(),
  mockGetRequestEntitlements: vi.fn(),
}));

// toAccessContext is deliberately NOT mocked - the point of these tests is that
// resolveAccessibleLakes goes through it, so the entitlement keys reach the DB filter.
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { listDataLakes: mockListDataLakes, listAllDataLakes: mockListAllDataLakes },
  fabFilesService: { search: vi.fn() },
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  dataLakeRepository: {},
  fabFileRepository: {},
  projectRepository: {},
  userRepository: {},
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
  });

  it('threads the resolved entitlement keys into the DB filter, and scopes static lakes by the same keys', async () => {
    // Building the AccessContext inline used to drop entitlementKeys, so findAccessible got no
    // entitlement arm and browse lost a lake gated by requiredEntitlement alone - a lake
    // retrieval kept, inverting the documented "browse is the wider surface" invariant. This is
    // the assertion that discriminates: the old inline literal carried no keys at all.
    mockGetRequestEntitlements.mockResolvedValue(['optihashi:pro']);

    const lakes = await resolveAccessibleLakes(asReq({ id: 'u1', tags: [], organizationId: 'org1' }));

    expect(mockListDataLakes).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', isAdmin: false, entitlementKeys: ['optihashi:pro'] }),
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
});
