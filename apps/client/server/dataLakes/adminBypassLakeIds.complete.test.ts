import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntitlementRequest } from '@bike4mind/server-utils/entitlements/index';

const mocks = vi.hoisted(() => ({
  findAccessible: vi.fn(),
  findIdsCreatedBy: vi.fn(),
  listActiveByLakes: vi.fn(),
  listByPrincipal: vi.fn(),
  getSettingsValue: vi.fn(),
  membership: vi.fn(),
  administered: vi.fn(),
  entitlements: vi.fn(),
  completeEntitlements: vi.fn(),
}));
vi.mock('@bike4mind/services', async () => ({
  dataLakeService: await import('../../../../b4m-core/services/src/dataLakeService/listDataLakes'),
  fabFilesService: { search: vi.fn() },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { findAccessible: mocks.findAccessible, findIdsCreatedBy: mocks.findIdsCreatedBy },
  dataLakeAccessGrantRepository: { listActiveByLakes: mocks.listActiveByLakes, listByPrincipal: mocks.listByPrincipal },
  adminSettingsRepository: { getSettingsValue: mocks.getSettingsValue },
  organizationRepository: { findMembershipOrgIds: mocks.membership, findIdsWithAdminRights: mocks.administered },
  fabFileRepository: {},
  projectRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/server-utils/entitlements/index', () => ({
  getRequestEntitlements: mocks.entitlements,
  getCompleteRequestEntitlements: mocks.completeEntitlements,
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({ getFilesStorage: () => ({ getSignedUrl: vi.fn() }) }));
import { adminBypassLakeIds } from '@bike4mind/server-utils/dataLakes/index';

const request = (isAdmin = true) => ({ user: { id: 'admin', isAdmin, tags: [] } }) as unknown as EntitlementRequest;
const ownedLake = {
  id: 'owned',
  slug: 'owned',
  name: 'Owned',
  createdByUserId: 'admin',
  status: 'active',
  datalakeTag: 'datalake:owned',
  fileTagPrefix: 'owned:',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findAccessible.mockResolvedValue([ownedLake]);
  mocks.findIdsCreatedBy.mockResolvedValue(['owned']);
  mocks.listActiveByLakes.mockResolvedValue([]);
  mocks.listByPrincipal.mockResolvedValue([]);
  mocks.getSettingsValue.mockResolvedValue(true);
  mocks.membership.mockResolvedValue([]);
  mocks.administered.mockResolvedValue([]);
  mocks.entitlements.mockResolvedValue([]);
  mocks.completeEntitlements.mockResolvedValue([]);
});

describe('admin bypass classification through the real listDataLakes resolver', () => {
  it.each(['dynamic', 'creator', 'supersession', 'settings', 'entitlements'] as const)(
    'refuses to classify an unknown %s result as admin bypass',
    async source => {
      const failure = new Error('Access lookup unavailable');
      if (source === 'dynamic') mocks.findAccessible.mockRejectedValue(failure);
      if (source === 'creator') mocks.findIdsCreatedBy.mockRejectedValue(failure);
      if (source === 'supersession') mocks.listActiveByLakes.mockRejectedValue(failure);
      if (source === 'settings') mocks.getSettingsValue.mockRejectedValue(failure);
      if (source === 'entitlements') mocks.completeEntitlements.mockRejectedValue(failure);
      await expect(adminBypassLakeIds(request(), ['owned'])).rejects.toThrow();
    }
  );

  it('marks only actual nonmembers, retaining an owning admin as a member', async () => {
    await expect(adminBypassLakeIds(request(), ['owned', 'outside'])).resolves.toEqual(['outside']);
    expect(mocks.findAccessible).toHaveBeenCalledWith(expect.objectContaining({ isAdmin: false }), expect.anything());
  });

  it.each(['membership', 'administered', 'listByPrincipal'] as const)(
    'also propagates a failed %s read',
    async source => {
      mocks[source].mockRejectedValue(new Error('Access lookup unavailable'));
      await expect(adminBypassLakeIds(request(), ['owned'])).rejects.toThrow();
    }
  );

  it('does no resolution for a nonadmin or an empty candidate set', async () => {
    await expect(adminBypassLakeIds(request(false), ['owned'])).resolves.toEqual([]);
    await expect(adminBypassLakeIds(request(), [])).resolves.toEqual([]);
    expect(mocks.findAccessible).not.toHaveBeenCalled();
    expect(mocks.completeEntitlements).not.toHaveBeenCalled();
    expect(mocks.entitlements).not.toHaveBeenCalled();
  });
});
