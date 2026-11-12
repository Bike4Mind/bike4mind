import { describe, expect, it, vi } from 'vitest';
import { api } from '@client/app/contexts/ApiContext';
import { setOrganizationGroupTypes } from './groupsAPICalls';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { put: vi.fn() } }));

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
