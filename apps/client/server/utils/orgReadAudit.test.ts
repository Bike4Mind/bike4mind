import { describe, it, expect, vi, beforeEach } from 'vitest';

const { recordAdminActionFromRequest, findMembershipOrgIds } = vi.hoisted(() => ({
  recordAdminActionFromRequest: vi.fn(),
  findMembershipOrgIds: vi.fn(async (): Promise<string[]> => []),
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest }));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { findMembershipOrgIds } }));

import { recordOrganizationRead } from './orgReadAudit';

const adminRequest = { user: { id: 'admin1', isAdmin: true } };

describe('recordOrganizationRead', () => {
  beforeEach(() => {
    recordAdminActionFromRequest.mockReset();
    findMembershipOrgIds.mockReset().mockResolvedValue([]);
  });

  it('writes nothing for a caller who is not a platform admin', async () => {
    await recordOrganizationRead({ user: { id: 'u1', isAdmin: false } }, [{ id: 'org1', name: 'Acme' }]);
    expect(findMembershipOrgIds).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('writes nothing when nothing was returned', async () => {
    await recordOrganizationRead(adminRequest, []);
    expect(findMembershipOrgIds).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('writes nothing when the admin reads only organizations they belong to', async () => {
    findMembershipOrgIds.mockResolvedValue(['org1']);
    await recordOrganizationRead(adminRequest, [{ id: 'org1', name: 'Acme' }]);
    expect(findMembershipOrgIds).toHaveBeenCalledWith('admin1');
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('targets the organization when the admin reads one they are not in', async () => {
    await recordOrganizationRead(adminRequest, [{ id: 'org1', name: 'Acme' }], { view: 'detail' });
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(adminRequest, {
      action: 'org.viewed',
      target: { kind: 'organization', id: 'org1', displayName: 'Acme' },
      organizationId: 'org1',
      summary: 'viewed organization Acme',
      details: { view: 'detail' },
    });
  });

  it('writes one entry per non-member organization in a list read, skipping the admin own', async () => {
    findMembershipOrgIds.mockResolvedValue(['own']);
    await recordOrganizationRead(
      adminRequest,
      [
        { id: 'own', name: 'Mine' },
        { id: 'org1', name: 'Acme' },
        { id: { toString: () => 'org2' }, name: 'Globex' },
      ],
      { view: 'list' }
    );
    expect(recordAdminActionFromRequest).toHaveBeenCalledTimes(2);
    const targets = recordAdminActionFromRequest.mock.calls.map(([, input]) => [input.target.id, input.organizationId]);
    expect(targets).toEqual([
      ['org1', 'org1'],
      ['org2', 'org2'],
    ]);
    expect(recordAdminActionFromRequest.mock.calls[1][1]).toMatchObject({ details: { view: 'list' } });
  });

  it('falls back to the id when the organization has no name', async () => {
    await recordOrganizationRead(adminRequest, [{ id: 'org1' }]);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      adminRequest,
      expect.objectContaining({ target: { kind: 'organization', id: 'org1', displayName: 'org1' } })
    );
  });

  it('propagates a failed audit write so the read fails with it', async () => {
    recordAdminActionFromRequest.mockRejectedValue(new Error('audit down'));
    await expect(recordOrganizationRead(adminRequest, [{ id: 'org1', name: 'Acme' }])).rejects.toThrow('audit down');
  });
});
