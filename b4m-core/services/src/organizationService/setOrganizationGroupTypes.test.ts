import { setOrganizationGroupTypes } from './setOrganizationGroupTypes';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('setOrganizationGroupTypes', () => {
  let db: any;
  let logger: any;

  const org = (over: Record<string, unknown> = {}) => ({
    id: 'org-1',
    personal: false,
    allowedGroupTypes: [],
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    db = {
      organizations: { findById: vi.fn().mockResolvedValue(org()), update: vi.fn() },
      groups: {
        findByOrganization: vi.fn().mockResolvedValue([]),
        createIfMissing: vi.fn(),
        delete: vi.fn(),
      },
      users: { removeGroupsFromAllUsers: vi.fn() },
    };
    logger = { info: vi.fn() };
  });

  const run = (allowedGroupTypes: string[]) =>
    setOrganizationGroupTypes({ organizationId: 'org-1', allowedGroupTypes }, { db, logger });

  it('rejects unknown group type keys before any write', async () => {
    await expect(run(['sales', 'bogus'])).rejects.toThrow(BadRequestError);
    expect(db.groups.createIfMissing).not.toHaveBeenCalled();
    expect(db.organizations.update).not.toHaveBeenCalled();
  });

  it('rejects personal organizations', async () => {
    db.organizations.findById.mockResolvedValue(org({ personal: true }));
    await expect(run(['sales'])).rejects.toThrow(BadRequestError);
    expect(db.organizations.update).not.toHaveBeenCalled();
  });

  it('throws when the org is missing', async () => {
    db.organizations.findById.mockResolvedValue(null);
    await expect(run(['sales'])).rejects.toThrow(NotFoundError);
  });

  it('provisions a group instance for each newly-allowed type', async () => {
    const result = await run(['sales', 'research']);

    expect(db.groups.createIfMissing).toHaveBeenCalledTimes(2);
    expect(db.groups.createIfMissing).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sales', name: 'Sales', organizationId: 'org-1' })
    );
    expect(db.organizations.update).toHaveBeenCalledWith({ id: 'org-1', allowedGroupTypes: ['sales', 'research'] });
    expect(result.added).toEqual(['sales', 'research']);
    expect(result.removed).toEqual([]);
  });

  it('does not re-provision a type that already has a live instance (idempotent)', async () => {
    db.organizations.findById.mockResolvedValue(org({ allowedGroupTypes: ['sales'] }));
    db.groups.findByOrganization.mockResolvedValue([{ id: 'g-sales', type: 'sales' }]);

    await run(['sales', 'research']);

    // only the genuinely-new 'research' type is provisioned
    expect(db.groups.createIfMissing).toHaveBeenCalledTimes(1);
    expect(db.groups.createIfMissing).toHaveBeenCalledWith(expect.objectContaining({ type: 'research' }));
  });

  it('revokes a removed type: soft-deletes its instances AND purges member group ids', async () => {
    db.organizations.findById.mockResolvedValue(org({ allowedGroupTypes: ['sales', 'research'] }));
    db.groups.findByOrganization.mockResolvedValue([
      { id: 'g-sales', type: 'sales' },
      { id: 'g-research', type: 'research' },
    ]);

    const result = await run(['sales']); // research removed

    expect(db.groups.delete).toHaveBeenCalledWith('g-research');
    expect(db.users.removeGroupsFromAllUsers).toHaveBeenCalledWith(['g-research']);
    expect(db.groups.createIfMissing).not.toHaveBeenCalled();
    expect(result.removed).toEqual(['research']);
    expect(result.revokedGroupIds).toEqual(['g-research']);
    expect(db.organizations.update).toHaveBeenCalledWith({ id: 'org-1', allowedGroupTypes: ['sales'] });
  });

  // Fail-safe ordering, mirroring organizationService/delete.ts: user.groups[] is the
  // access-bearing artifact (the sharing layer matches groups.$elemMatch.groupId against
  // user.groups and never joins the Group row), so membership has to go first. Both orders commit
  // identically inside a transaction, which is exactly why only an explicit assertion stops a
  // refactor from silently reverting to the fail-open order.
  it('purges member group ids BEFORE soft-deleting the revoked groups', async () => {
    db.organizations.findById.mockResolvedValue(org({ allowedGroupTypes: ['sales', 'research'] }));
    db.groups.findByOrganization.mockResolvedValue([
      { id: 'g-sales', type: 'sales' },
      { id: 'g-research', type: 'research' },
    ]);

    const callOrder: string[] = [];
    db.users.removeGroupsFromAllUsers.mockImplementation(async () => {
      callOrder.push('removeGroupsFromAllUsers');
    });
    db.groups.delete.mockImplementation(async () => {
      callOrder.push('delete');
    });

    await run(['sales']); // research removed

    expect(callOrder).toEqual(['removeGroupsFromAllUsers', 'delete']);
  });

  it('does not touch groups/members when nothing is revoked', async () => {
    db.organizations.findById.mockResolvedValue(org({ allowedGroupTypes: ['sales'] }));
    db.groups.findByOrganization.mockResolvedValue([{ id: 'g-sales', type: 'sales' }]);

    await run(['sales']); // no change

    expect(db.groups.delete).not.toHaveBeenCalled();
    expect(db.users.removeGroupsFromAllUsers).not.toHaveBeenCalled();
    expect(db.groups.createIfMissing).not.toHaveBeenCalled();
  });

  it('re-provisions a missing group for an already-allowed type (repairability)', async () => {
    // Org already allows 'sales' but has no live instance (e.g. a prior revoke soft-deleted it).
    // Re-issuing the same PUT must re-provision it - iterating `added` (empty here) would not.
    db.organizations.findById.mockResolvedValue(org({ allowedGroupTypes: ['sales'] }));
    db.groups.findByOrganization.mockResolvedValue([]);

    const result = await run(['sales']);

    expect(db.groups.createIfMissing).toHaveBeenCalledTimes(1);
    expect(db.groups.createIfMissing).toHaveBeenCalledWith(expect.objectContaining({ type: 'sales' }));
    expect(result.added).toEqual([]);
  });

  it('dedupes and trims requested keys', async () => {
    await run([' sales ', 'sales']);
    expect(db.organizations.update).toHaveBeenCalledWith({ id: 'org-1', allowedGroupTypes: ['sales'] });
    expect(db.groups.createIfMissing).toHaveBeenCalledTimes(1);
  });
});
