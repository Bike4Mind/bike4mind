import { assignUserToGroup, removeUserFromGroup, renameGroup, listOrganizationGroups } from './groupMembership';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/utils';
import { IUserDocument } from '@bike4mind/common';
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('group membership (assign / remove)', () => {
  const ORG = 'org-1';
  const GROUP = 'group-1';
  const TARGET = 'target-user';

  const billingOwner = { id: 'owner-1', isAdmin: false } as IUserDocument;
  const orgAdmin = { id: 'orgadmin-1', isAdmin: false } as IUserDocument;
  const platformAdmin = { id: 'admin-1', isAdmin: true } as IUserDocument;
  const outsiderAdmin = { id: 'stranger-1', isAdmin: false } as IUserDocument;

  let db: any;

  const org = (over: Record<string, unknown> = {}) => ({
    id: ORG,
    userId: 'owner-1',
    adminUserIds: ['orgadmin-1'],
    // orgadmin-1 is a current member: an appointed org admin must also still be in users[].
    users: [{ userId: TARGET }, { userId: 'owner-1' }, { userId: 'orgadmin-1' }],
    ...over,
  });
  const group = (over: Record<string, unknown> = {}) => ({ id: GROUP, organizationId: ORG, type: 'sales', ...over });

  beforeEach(() => {
    vi.clearAllMocks();
    db = {
      organizations: { findById: vi.fn().mockResolvedValue(org()) },
      groups: {
        findById: vi.fn().mockResolvedValue(group()),
        update: vi.fn().mockImplementation(async ({ id, name }: { id: string; name: string }) => ({
          ...group(),
          id,
          name,
        })),
      },
      users: { addGroupToUser: vi.fn(), removeGroupFromUser: vi.fn() },
    };
  });

  const assign = (actor: IUserDocument) =>
    assignUserToGroup(actor, { organizationId: ORG, groupId: GROUP, userId: TARGET }, { db });

  it('assigns a member to a group for the billing owner, org admin, and platform admin', async () => {
    for (const actor of [billingOwner, orgAdmin, platformAdmin]) {
      await assign(actor);
    }
    expect(db.users.addGroupToUser).toHaveBeenCalledTimes(3);
    expect(db.users.addGroupToUser).toHaveBeenCalledWith(TARGET, GROUP);
  });

  it('forbids a plain member / non-admin from assigning', async () => {
    await expect(assign(outsiderAdmin)).rejects.toThrow(ForbiddenError);
    expect(db.users.addGroupToUser).not.toHaveBeenCalled();
  });

  // Defence in depth: an id left in adminUserIds for someone no longer in users[] (a purge miss,
  // or a row predating the removal-purge fix) must NOT confer group-management authority.
  it('forbids an appointed org admin who is no longer a member of the org', async () => {
    db.organizations.findById.mockResolvedValue(
      org({ adminUserIds: ['orgadmin-1'], users: [{ userId: TARGET }, { userId: 'owner-1' }] })
    );
    await expect(assign(orgAdmin)).rejects.toThrow(ForbiddenError);
    expect(db.users.addGroupToUser).not.toHaveBeenCalled();
  });

  // Write-path invariant, negative A: cannot attach an OUTSIDER (fails condition 2).
  it('rejects assigning a user who is not a member of the organization', async () => {
    db.organizations.findById.mockResolvedValue(org({ users: [{ userId: 'someone-else' }] }));
    await expect(assign(billingOwner)).rejects.toThrow(BadRequestError);
    expect(db.users.addGroupToUser).not.toHaveBeenCalled();
  });

  // Write-path invariant, negative B: cannot attach a member to ANOTHER TENANT's group (fails
  // condition 1). Returns NotFound (same as a missing group) so it is not an existence oracle.
  it('rejects assigning to a group that belongs to a different organization (as NotFound)', async () => {
    db.groups.findById.mockResolvedValue(group({ organizationId: 'other-org' }));
    await expect(assign(billingOwner)).rejects.toThrow(NotFoundError);
    expect(db.users.addGroupToUser).not.toHaveBeenCalled();
  });

  it('throws NotFound when the org or group is missing', async () => {
    db.organizations.findById.mockResolvedValue(null);
    await expect(assign(billingOwner)).rejects.toThrow(NotFoundError);

    db.organizations.findById.mockResolvedValue(org());
    db.groups.findById.mockResolvedValue(null);
    await expect(assign(billingOwner)).rejects.toThrow(NotFoundError);
  });

  it('removes a member from a group (invariant 1 enforced, membership not required)', async () => {
    // even a user no longer in users[] can be unassigned (cleanup), as long as the group is this org's
    db.organizations.findById.mockResolvedValue(org({ users: [] }));
    await removeUserFromGroup(billingOwner, { organizationId: ORG, groupId: GROUP, userId: TARGET }, { db });
    expect(db.users.removeGroupFromUser).toHaveBeenCalledWith(TARGET, GROUP);
  });

  it("remove still rejects another tenant's group and unauthorized actors", async () => {
    db.groups.findById.mockResolvedValue(group({ organizationId: 'other-org' }));
    await expect(
      removeUserFromGroup(billingOwner, { organizationId: ORG, groupId: GROUP, userId: TARGET }, { db })
    ).rejects.toThrow(NotFoundError);

    db.groups.findById.mockResolvedValue(group());
    await expect(
      removeUserFromGroup(outsiderAdmin, { organizationId: ORG, groupId: GROUP, userId: TARGET }, { db })
    ).rejects.toThrow(ForbiddenError);
  });

  describe('renameGroup', () => {
    const rename = (actor: IUserDocument) =>
      renameGroup(actor, { organizationId: ORG, groupId: GROUP, name: 'Renamed' }, { db });

    it('renames for the billing owner, org admin, and platform admin', async () => {
      for (const actor of [billingOwner, orgAdmin, platformAdmin]) {
        const updated = await rename(actor);
        expect(updated?.name).toBe('Renamed');
      }
      expect(db.groups.update).toHaveBeenCalledWith({ id: GROUP, name: 'Renamed' });
    });

    it('forbids an unauthorized actor', async () => {
      await expect(rename(outsiderAdmin)).rejects.toThrow(ForbiddenError);
      expect(db.groups.update).not.toHaveBeenCalled();
    });

    it("rejects renaming another tenant's group (as NotFound, no membership required)", async () => {
      db.groups.findById.mockResolvedValue(group({ organizationId: 'other-org' }));
      await expect(rename(billingOwner)).rejects.toThrow(NotFoundError);
      expect(db.groups.update).not.toHaveBeenCalled();
    });
  });
});

describe('listOrganizationGroups', () => {
  const ORG = 'org-1';
  const owner = { id: 'owner-1', isAdmin: false } as IUserDocument;
  const outsider = { id: 'stranger-1', isAdmin: false } as IUserDocument;

  const org = (over: Record<string, unknown> = {}) => ({
    id: ORG,
    userId: 'owner-1',
    adminUserIds: [],
    users: [{ userId: 'owner-1' }],
    ...over,
  });
  const group = (id: string, type: string) => ({ id, type, organizationId: ORG, name: type });

  let db: any;
  beforeEach(() => {
    vi.clearAllMocks();
    db = {
      organizations: { findById: vi.fn().mockResolvedValue(org()) },
      groups: {
        findByOrganization: vi.fn().mockResolvedValue([group('g-sales', 'sales'), group('g-research', 'research')]),
      },
      users: { findUserIdsByGroupIds: vi.fn().mockResolvedValue({ 'g-sales': ['u1', 'u2'] }) },
    };
  });

  it('returns each group with its member ids and a count derived from those ids', async () => {
    const result = await listOrganizationGroups(owner, { organizationId: ORG }, { db });

    expect(result).toEqual([
      { id: 'g-sales', type: 'sales', organizationId: ORG, name: 'sales', memberIds: ['u1', 'u2'], memberCount: 2 },
      { id: 'g-research', type: 'research', organizationId: ORG, name: 'research', memberIds: [], memberCount: 0 },
    ]);
    expect(db.users.findUserIdsByGroupIds).toHaveBeenCalledWith(['g-sales', 'g-research']);
  });

  it('throws NotFound when the org does not exist, before any authz or group read', async () => {
    db.organizations.findById.mockResolvedValue(null);
    await expect(listOrganizationGroups(owner, { organizationId: ORG }, { db })).rejects.toThrow(NotFoundError);
    expect(db.groups.findByOrganization).not.toHaveBeenCalled();
  });

  it('rejects a caller who cannot manage the org (the MANAGE gate, not read)', async () => {
    await expect(listOrganizationGroups(outsider, { organizationId: ORG }, { db })).rejects.toThrow(ForbiddenError);
    expect(db.groups.findByOrganization).not.toHaveBeenCalled();
  });
});
