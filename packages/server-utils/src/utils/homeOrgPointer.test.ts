import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindAccessibleById } = vi.hoisted(() => ({ mockFindAccessibleById: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  organizationRepository: { shareable: { findAccessibleById: mockFindAccessibleById } },
}));

import { accessibleHomeOrg } from './homeOrgPointer';

const org = { id: 'org-1', name: 'Acme' };
const member = { _id: 'user-1', groups: ['g-acme'], isAdmin: false };

describe('accessibleHomeOrg', () => {
  beforeEach(() => mockFindAccessibleById.mockReset());

  it("keeps the org while the pointer owner can still reach it, checked against the owner's id and groups", async () => {
    mockFindAccessibleById.mockResolvedValue({ id: 'org-1' });

    await expect(accessibleHomeOrg(member, org)).resolves.toBe(org);
    expect(mockFindAccessibleById).toHaveBeenCalledWith({ id: 'user-1', groups: ['g-acme'] }, 'org-1');
  });

  it('drops the org once the owner can no longer reach it', async () => {
    mockFindAccessibleById.mockResolvedValue(null);

    await expect(accessibleHomeOrg(member, org)).resolves.toBeNull();
  });

  it('keeps a platform admin pointer without an ACL read', async () => {
    await expect(accessibleHomeOrg({ _id: 'admin-1', isAdmin: true }, org)).resolves.toBe(org);
    expect(mockFindAccessibleById).not.toHaveBeenCalled();
  });

  it('checks an owner with no groups as an empty group list', async () => {
    mockFindAccessibleById.mockResolvedValue(null);

    await accessibleHomeOrg({ _id: 'user-2' }, org);

    expect(mockFindAccessibleById).toHaveBeenCalledWith({ id: 'user-2', groups: [] }, 'org-1');
  });

  it('returns null without an ACL read when there is no owner or no resolved org', async () => {
    await expect(accessibleHomeOrg(null, org)).resolves.toBeNull();
    await expect(accessibleHomeOrg(member, null)).resolves.toBeNull();
    expect(mockFindAccessibleById).not.toHaveBeenCalled();
  });
});
