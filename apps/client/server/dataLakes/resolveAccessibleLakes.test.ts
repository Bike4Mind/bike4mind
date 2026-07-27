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

  it('threads the resolved entitlement keys into the DB filter', async () => {
    // Building the AccessContext inline used to drop entitlementKeys, so findAccessible got no
    // entitlement arm and browse lost a lake gated by requiredEntitlement alone - a lake
    // retrieval kept, inverting the documented "browse is the wider surface" invariant.
    mockGetRequestEntitlements.mockResolvedValue(['product:pro']);

    await resolveAccessibleLakes(asReq({ id: 'u1', tags: [], organizationId: 'org1' }));

    expect(mockListDataLakes).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', isAdmin: false, entitlementKeys: ['product:pro'] }),
      expect.anything()
    );
  });

  it('skips the entitlement read for an admin and takes the list-all path', async () => {
    await resolveAccessibleLakes(asReq({ id: 'admin', tags: [], isAdmin: true }));

    expect(mockListAllDataLakes).toHaveBeenCalledTimes(1);
    expect(mockListDataLakes).not.toHaveBeenCalled();
    expect(mockGetRequestEntitlements).not.toHaveBeenCalled();
  });

  it('scopes static registry lakes by the same keys rather than re-reading them', async () => {
    // The static filter and the DB filter must agree about which keys the caller holds.
    mockGetRequestEntitlements.mockResolvedValue(['optihashi:pro']);

    const lakes = await resolveAccessibleLakes(asReq({ id: 'u1', tags: [] }));

    // The built-in opti lake is entitlement-gated, so a key holder gets it with no tag.
    expect(lakes.map(l => l.id)).toContain('opti-knowledge');
    expect(mockGetRequestEntitlements).toHaveBeenCalledTimes(1);
  });

  it('a dynamic lake shadows a same-id static one', async () => {
    mockListDataLakes.mockResolvedValue([
      { id: 'opti-knowledge', slug: 'shadow', name: 'Shadow', fileTagPrefix: 'mine:', datalakeTag: 'datalake:shadow' },
    ]);
    mockGetRequestEntitlements.mockResolvedValue(['optihashi:pro']);

    const lakes = await resolveAccessibleLakes(asReq({ id: 'u1', tags: [] }));

    expect(lakes.filter(l => l.id === 'opti-knowledge')).toHaveLength(1);
    expect(lakes.find(l => l.id === 'opti-knowledge')?.slug).toBe('shadow');
  });
});
