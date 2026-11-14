import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@client/app/contexts/ApiContext';
import { renameOrganizationGroup, setOrganizationGroupTypes } from './groupsAPICalls';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { put: vi.fn(), patch: vi.fn() } }));

describe('setOrganizationGroupTypes', () => {
  it('sends the composed audit reason with allowed types', async () => {
    vi.mocked(api.put).mockResolvedValue({ data: { added: ['sales'], removed: [], revokedGroupIds: [] } });

    await expect(setOrganizationGroupTypes('org1', ['sales'], 'Pilot or partner access')).resolves.toEqual({
      added: ['sales'],
      removed: [],
      revokedGroupIds: [],
    });
    expect(api.put).toHaveBeenCalledWith('/api/admin/organizations/org1/group-types', {
      allowedGroupTypes: ['sales'],
      reason: 'Pilot or partner access',
    });
  });
});

/** Losing expectedName in transport would turn a guarded Undo into an unconditional rename. */
describe('group rename transport', () => {
  const group = { id: 'group1', organizationId: 'org1', name: 'Sales', type: 'sales' };
  beforeEach(() => vi.mocked(api.patch).mockReset().mockResolvedValue({ data: { group } }));

  it('sends the exact successful name when Undo is conditional', async () => {
    expect(await renameOrganizationGroup('org1', 'group1', 'Sales', { expectedName: ' Revenue ' })).toBe(group);
    expect(api.patch).toHaveBeenCalledWith('/api/organizations/org1/groups/group1', {
      name: 'Sales',
      expectedName: ' Revenue ',
    });
  });

  it('keeps an ordinary rename payload compatible', async () => {
    expect(await renameOrganizationGroup('org1', 'group1', 'Sales')).toBe(group);
    expect(api.patch).toHaveBeenCalledWith('/api/organizations/org1/groups/group1', { name: 'Sales' });
  });
});
