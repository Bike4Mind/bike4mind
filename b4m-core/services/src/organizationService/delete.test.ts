import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deleteOrganization } from './delete';
import {
  IDataLakeAccessGrantDocument,
  IDataLakeDocument,
  IOrganizationDocument,
  IUserDocument,
  WithId,
} from '@bike4mind/common';
import * as getOrganization from './get';

describe('organizationService - delete', () => {
  let mockAdapters: any;

  const mockOrganization: WithId<IOrganizationDocument> = {
    id: 'org1',
    name: 'Test Organization',
    userId: 'user1',
    personal: false,
    description: 'Test Description',
    billingContact: 'contact@example.com',
    currentCredits: 0,
    seats: 10,
    userDetails: null,
    users: [{ userId: 'user1', permissions: [] }],
    groups: [],
    isGlobalRead: false,
    isGlobalWrite: false,
    createdAt: new Date('2023-01-01'),
    updatedAt: new Date('2023-01-01'),
  };

  // Create a base mock repository with all required methods
  const createMockRepository = () => ({
    delete: vi.fn(),
    shareable: {
      findAccessibleById: vi.fn(),
    },
  });

  let lakes: IDataLakeDocument[];
  let grants: IDataLakeAccessGrantDocument[];

  const isActive = (grant: IDataLakeAccessGrantDocument, asOf?: Date) =>
    !asOf || grant.expiresAt == null || new Date(grant.expiresAt) > asOf;

  // In-memory grant store, so a second run sees the first run's writes the way a retry would.
  const lakeAdapters = () => ({
    dataLakes: {
      findByOrganizationId: vi.fn(async (orgId: string) => lakes.filter(lake => lake.organizationId === orgId)),
      update: vi.fn(async (input: { id: string }) => ({ id: input.id })),
      touchIfStable: vi.fn().mockResolvedValue(true),
    },
    dataLakeAccessGrants: {
      listByPrincipal: vi.fn(),
      listActiveByLakes: vi.fn(async (ids: string[], opts?: { activeAsOf?: Date }) =>
        grants
          .filter(grant => ids.includes(grant.dataLakeId) && isActive(grant, opts?.activeAsOf))
          .map(grant => ({ ...grant }))
      ),
      upsertGrant: vi.fn(async (input: IDataLakeAccessGrantDocument) => {
        const key = (g: IDataLakeAccessGrantDocument) => `${g.dataLakeId}|${g.principalType}|${g.principalId}`;
        const existing = grants.find(g => key(g) === key(input));
        if (existing) Object.assign(existing, input);
        else grants.push({ ...input });
        return input;
      }),
    },
    lakeConfigChangeEvents: { record: vi.fn().mockResolvedValue(undefined) },
  });

  beforeEach(() => {
    lakes = [];
    grants = [];
    mockAdapters = {
      db: {
        ...lakeAdapters(),
        organizations: createMockRepository(),
        groups: {
          findByOrganization: vi.fn().mockResolvedValue([]),
          delete: vi.fn(),
        },
        users: {
          removeGroupsFromAllUsers: vi.fn(),
          clearOrganizationPointer: vi.fn(),
        },
      },
    };
    vi.spyOn(getOrganization, 'get').mockResolvedValue(mockOrganization);
  });

  it('should successfully delete an organization', async () => {
    const mockAdminUser: Partial<IUserDocument> = {
      id: 'admin1',
      isAdmin: true,
    };

    mockAdapters.db.organizations.delete.mockResolvedValue(undefined);

    await deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters);

    expect(getOrganization.get).toHaveBeenCalledWith(mockAdminUser, { id: 'org1' }, mockAdapters);
    expect(mockAdapters.db.organizations.delete).toHaveBeenCalledWith('org1');
  });

  it('should fail if validation fails', async () => {
    const mockAdminUser: Partial<IUserDocument> = {
      id: 'admin1',
      isAdmin: true,
    };

    // Add validation that always fails
    mockAdapters.validation = {
      canDeleteOrganization: vi.fn().mockResolvedValue({ canDelete: false, reason: 'Test validation failure' }),
    };

    await expect(deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters)).rejects.toThrow(
      'Organization deletion validation failed: Test validation failure'
    );

    expect(getOrganization.get).toHaveBeenCalledWith(mockAdminUser, { id: 'org1' }, mockAdapters);
    expect(mockAdapters.validation.canDeleteOrganization).toHaveBeenCalledWith(mockOrganization);
    expect(mockAdapters.db.organizations.delete).not.toHaveBeenCalled();
  });

  it('should fail if validation fails without reason', async () => {
    const mockAdminUser: Partial<IUserDocument> = {
      id: 'admin1',
      isAdmin: true,
    };

    // Add validation that always fails without reason
    mockAdapters.validation = {
      canDeleteOrganization: vi.fn().mockResolvedValue({ canDelete: false }),
    };

    await expect(deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters)).rejects.toThrow(
      'Organization deletion validation failed'
    );

    expect(getOrganization.get).toHaveBeenCalledWith(mockAdminUser, { id: 'org1' }, mockAdapters);
    expect(mockAdapters.validation.canDeleteOrganization).toHaveBeenCalledWith(mockOrganization);
    expect(mockAdapters.db.organizations.delete).not.toHaveBeenCalled();
  });

  it('should succeed if validation passes', async () => {
    const mockAdminUser: Partial<IUserDocument> = {
      id: 'admin1',
      isAdmin: true,
    };

    // Add validation that always succeeds
    mockAdapters.validation = {
      canDeleteOrganization: vi.fn().mockResolvedValue({ canDelete: true }),
    };

    mockAdapters.db.organizations.delete.mockResolvedValue(undefined);

    await deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters);

    expect(getOrganization.get).toHaveBeenCalledWith(mockAdminUser, { id: 'org1' }, mockAdapters);
    expect(mockAdapters.validation.canDeleteOrganization).toHaveBeenCalledWith(mockOrganization);
    expect(mockAdapters.db.organizations.delete).toHaveBeenCalledWith('org1');
  });

  it('should proceed with deletion if no validation is provided', async () => {
    const mockAdminUser: Partial<IUserDocument> = {
      id: 'admin1',
      isAdmin: true,
    };

    mockAdapters.db.organizations.delete.mockResolvedValue(undefined);

    await deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters);

    expect(getOrganization.get).toHaveBeenCalledWith(mockAdminUser, { id: 'org1' }, mockAdapters);
    expect(mockAdapters.db.organizations.delete).toHaveBeenCalledWith('org1');
  });

  describe('delete authority', () => {
    // `get` resolves via findAccessibleById, which any member holding read satisfies, so these pin
    // that deletion additionally requires the billing owner or a platform admin.
    it('should allow the billing owner to delete', async () => {
      const owner: Partial<IUserDocument> = { id: 'user1', isAdmin: false };

      mockAdapters.db.organizations.delete.mockResolvedValue(undefined);

      await deleteOrganization(owner as IUserDocument, { id: 'org1' }, mockAdapters);

      expect(mockAdapters.db.organizations.delete).toHaveBeenCalledWith('org1');
    });

    it('should reject a read-only member and perform no writes', async () => {
      const member: Partial<IUserDocument> = { id: 'member1', isAdmin: false };
      mockAdapters.validation = { canDeleteOrganization: vi.fn() };

      await expect(deleteOrganization(member as IUserDocument, { id: 'org1' }, mockAdapters)).rejects.toThrow(
        'Not authorized to delete this organization'
      );

      expect(mockAdapters.db.organizations.delete).not.toHaveBeenCalled();
      expect(mockAdapters.db.users.clearOrganizationPointer).not.toHaveBeenCalled();
      // The gate precedes the subscription check, so a caller without authority cannot read the
      // org's billing state out of the validation reason.
      expect(mockAdapters.validation.canDeleteOrganization).not.toHaveBeenCalled();
    });

    it('should reject an appointed org admin who is not the billing owner', async () => {
      // orgAdmin1 must ALSO be in users[]: assertCanManageOrgGroups requires adminUserIds AND
      // membership, so a non-member org admin would fail that predicate too and the test would
      // pass even if the gate were consolidated onto it. Membership is what makes this pin the
      // narrowness the gate deliberately keeps.
      vi.spyOn(getOrganization, 'get').mockResolvedValue({
        ...mockOrganization,
        adminUserIds: ['orgAdmin1'],
        users: [...mockOrganization.users, { userId: 'orgAdmin1', permissions: [] }],
      } as WithId<IOrganizationDocument>);
      const orgAdmin: Partial<IUserDocument> = { id: 'orgAdmin1', isAdmin: false };

      await expect(deleteOrganization(orgAdmin as IUserDocument, { id: 'org1' }, mockAdapters)).rejects.toThrow(
        'Not authorized to delete this organization'
      );

      expect(mockAdapters.db.organizations.delete).not.toHaveBeenCalled();
    });
  });

  it('should throw if delete operation fails', async () => {
    const mockAdminUser: Partial<IUserDocument> = {
      id: 'admin1',
      isAdmin: true,
    };

    // Mock delete to throw an error
    const deleteError = new Error('Failed to delete organization');
    mockAdapters.db.organizations.delete.mockRejectedValue(deleteError);

    await expect(deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters)).rejects.toThrow(
      deleteError
    );

    expect(getOrganization.get).toHaveBeenCalledWith(mockAdminUser, { id: 'org1' }, mockAdapters);
    expect(mockAdapters.db.organizations.delete).toHaveBeenCalledWith('org1');
  });

  it('aborts the delete when the pointer reset fails', async () => {
    const mockAdminUser: Partial<IUserDocument> = { id: 'admin1', isAdmin: true };
    mockAdapters.db.users.clearOrganizationPointer.mockRejectedValue(new Error('pointer reset failed'));

    await expect(deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters)).rejects.toThrow(
      'pointer reset failed'
    );

    expect(mockAdapters.db.organizations.delete).not.toHaveBeenCalled();
  });

  // Regression coverage for #1219: deleteOrganization previously had NO reference to groups or
  // users at all, so a deleted org's groups stayed live (soft-delete never applied) and every
  // member kept the group ids in user.groups - continuing to satisfy the sharing layer's
  // `groups.$elemMatch.groupId $in user.groups` match against a group whose org no longer exists.
  describe('group footprint purge', () => {
    const mockAdminUser: Partial<IUserDocument> = { id: 'admin1', isAdmin: true };

    it('purges member group ids and soft-deletes the org groups when the org has live groups', async () => {
      mockAdapters.db.groups.findByOrganization.mockResolvedValue([
        { id: 'group-a', type: 'sales' },
        { id: 'group-b', type: 'research' },
      ]);
      mockAdapters.db.organizations.delete.mockResolvedValue(undefined);

      await deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters);

      // includeDeleted so the purge reaches already-soft-deleted groups whose ids may linger (#1230).
      expect(mockAdapters.db.groups.findByOrganization).toHaveBeenCalledWith('org1', { includeDeleted: true });
      expect(mockAdapters.db.users.removeGroupsFromAllUsers).toHaveBeenCalledWith(['group-a', 'group-b']);
      // Each group soft-deleted individually via the inherited delete() (#1228 revert of the bulk workaround).
      expect(mockAdapters.db.groups.delete).toHaveBeenCalledTimes(2);
      expect(mockAdapters.db.groups.delete).toHaveBeenCalledWith('group-a');
      expect(mockAdapters.db.groups.delete).toHaveBeenCalledWith('group-b');
      expect(mockAdapters.db.organizations.delete).toHaveBeenCalledWith('org1');
    });

    it('purges an already-soft-deleted group id surfaced via includeDeleted (#1230)', async () => {
      // findByOrganization(includeDeleted) returns a stale (previously soft-deleted) group whose id
      // may still sit in user.groups; org deletion must purge it, not just the live groups.
      mockAdapters.db.groups.findByOrganization.mockResolvedValue([{ id: 'stale-group', type: 'sales' }]);

      await deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters);

      expect(mockAdapters.db.groups.findByOrganization).toHaveBeenCalledWith('org1', { includeDeleted: true });
      expect(mockAdapters.db.users.removeGroupsFromAllUsers).toHaveBeenCalledWith(['stale-group']);
    });

    it('purges membership BEFORE soft-deleting the groups and clears pointers before the org delete', async () => {
      const callOrder: string[] = [];
      mockAdapters.db.groups.findByOrganization.mockResolvedValue([{ id: 'group-a', type: 'sales' }]);
      mockAdapters.db.users.removeGroupsFromAllUsers.mockImplementation(async () => {
        callOrder.push('removeGroupsFromAllUsers');
      });
      mockAdapters.db.groups.delete.mockImplementation(async () => {
        callOrder.push('groups.delete');
      });
      mockAdapters.db.users.clearOrganizationPointer.mockImplementation(async () => {
        callOrder.push('clearOrganizationPointer');
      });
      mockAdapters.db.organizations.delete.mockImplementation(async () => {
        callOrder.push('organizations.delete');
      });

      await deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters);

      expect(mockAdapters.db.users.clearOrganizationPointer).toHaveBeenCalledWith('org1');
      expect(callOrder).toEqual([
        'removeGroupsFromAllUsers',
        'groups.delete',
        'clearOrganizationPointer',
        'organizations.delete',
      ]);
    });

    it('does not call the purge or soft-delete when the org has no live groups', async () => {
      mockAdapters.db.groups.findByOrganization.mockResolvedValue([]);
      mockAdapters.db.organizations.delete.mockResolvedValue(undefined);

      await deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters);

      expect(mockAdapters.db.users.removeGroupsFromAllUsers).not.toHaveBeenCalled();
      expect(mockAdapters.db.groups.delete).not.toHaveBeenCalled();
      expect(mockAdapters.db.users.clearOrganizationPointer).toHaveBeenCalledWith('org1');
      expect(mockAdapters.db.organizations.delete).toHaveBeenCalledWith('org1');
    });

    it('does not purge groups if validation rejects the delete', async () => {
      mockAdapters.validation = {
        canDeleteOrganization: vi.fn().mockResolvedValue({ canDelete: false, reason: 'blocked' }),
      };
      mockAdapters.db.groups.findByOrganization.mockResolvedValue([{ id: 'group-a', type: 'sales' }]);

      await expect(deleteOrganization(mockAdminUser as IUserDocument, { id: 'org1' }, mockAdapters)).rejects.toThrow(
        'Organization deletion validation failed: blocked'
      );

      expect(mockAdapters.db.groups.findByOrganization).not.toHaveBeenCalled();
      expect(mockAdapters.db.users.removeGroupsFromAllUsers).not.toHaveBeenCalled();
      expect(mockAdapters.db.groups.delete).not.toHaveBeenCalled();
      expect(mockAdapters.db.users.clearOrganizationPointer).not.toHaveBeenCalled();
    });
  });
  describe('data-lake access lapse', () => {
    const owner: Partial<IUserDocument> = { id: 'user1', isAdmin: false };
    const lake = (id: string, organizationId: string, createdByUserId: string) =>
      ({ id, organizationId, createdByUserId }) as IDataLakeDocument;
    const grant = (
      dataLakeId: string,
      principalId: string,
      role: IDataLakeAccessGrantDocument['role'],
      principalType: IDataLakeAccessGrantDocument['principalType'] = 'user'
    ) =>
      ({
        dataLakeId,
        principalType,
        principalId,
        role,
        grantedByUserId: 'granter',
        expiresAt: null,
      }) as IDataLakeAccessGrantDocument;
    const find = (dataLakeId: string, principalId: string) =>
      grants.find(g => g.dataLakeId === dataLakeId && g.principalId === principalId);

    beforeEach(() => {
      vi.spyOn(getOrganization, 'get').mockResolvedValue({
        ...mockOrganization,
        adminUserIds: ['manager1'],
        users: [
          { userId: 'user1', permissions: [] },
          { userId: 'member1', permissions: [] },
          { userId: 'manager1', permissions: [] },
        ],
      } as WithId<IOrganizationDocument>);
      lakes = [lake('lakeA', 'org1', 'user1'), lake('lakeB', 'org1', 'member1'), lake('otherLake', 'org2', 'x')];
      grants = [
        grant('lakeA', 'member1', 'reader'),
        grant('lakeA', 'manager1', 'curator'),
        grant('lakeA', 'user1', 'curator'),
        grant('lakeA', 'outsider', 'reader'),
        grant('lakeA', 'org1', 'reader', 'organization'),
        grant('lakeB', 'manager1', 'owner'),
        grant('otherLake', 'member1', 'curator'),
      ];
    });

    it("expires members' grants on the org's lakes and leaves everything else active", async () => {
      await deleteOrganization(owner as IUserDocument, { id: 'org1' }, mockAdapters);

      expect(find('lakeA', 'member1')?.expiresAt).toBeInstanceOf(Date);
      expect(find('lakeA', 'manager1')?.expiresAt).toBeInstanceOf(Date);
      expect(find('lakeB', 'manager1')?.expiresAt).toBeInstanceOf(Date);
      // Billing owner, a non-member, the org-principal grant, and a grant on another org's lake.
      expect(find('lakeA', 'user1')?.expiresAt).toBeNull();
      expect(find('lakeA', 'outsider')?.expiresAt).toBeNull();
      expect(find('lakeA', 'org1')?.expiresAt).toBeNull();
      expect(find('otherLake', 'member1')?.expiresAt).toBeNull();
    });

    it('hands a lake to the billing owner when every other owner lapsed, so it does not fall back to its creator', async () => {
      await deleteOrganization(owner as IUserDocument, { id: 'org1' }, mockAdapters);

      // lakeB was created by member1 and owned by manager1; both lapse in the same delete.
      expect(find('lakeB', 'user1')).toEqual(expect.objectContaining({ role: 'owner', expiresAt: null }));
      expect(find('lakeA', 'user1')?.role).toBe('curator');
    });

    it('lapses before the org row is soft-deleted', async () => {
      const callOrder: string[] = [];
      mockAdapters.db.dataLakeAccessGrants.upsertGrant.mockImplementation(async () => {
        callOrder.push('upsertGrant');
      });
      mockAdapters.db.organizations.delete.mockImplementation(async () => {
        callOrder.push('organizations.delete');
      });

      await deleteOrganization(owner as IUserDocument, { id: 'org1' }, mockAdapters);

      expect(callOrder.at(-1)).toBe('organizations.delete');
      expect(callOrder).toContain('upsertGrant');
    });

    it("clears the members' org pointers only after the lapse", async () => {
      const callOrder: string[] = [];
      mockAdapters.db.dataLakeAccessGrants.upsertGrant.mockImplementation(async () => {
        callOrder.push('upsertGrant');
      });
      mockAdapters.db.users.clearOrganizationPointer.mockImplementation(async () => {
        callOrder.push('clearOrganizationPointer');
      });

      await deleteOrganization(owner as IUserDocument, { id: 'org1' }, mockAdapters);

      expect(callOrder.indexOf('clearOrganizationPointer')).toBeGreaterThan(callOrder.lastIndexOf('upsertGrant'));
    });

    it("hands a roster creator's lake to the billing owner even though the creator held its seeded owner grant", async () => {
      // createDataLake seeds the creator as owner; the hand-off must judge the post-lapse grants,
      // or this expired grant would mark lakeB creator-owned and member1 would resolve as owner again.
      // adminOnly sits in adminUserIds with no users[] row and must lapse like any member.
      vi.spyOn(getOrganization, 'get').mockResolvedValue({
        ...mockOrganization,
        adminUserIds: ['manager1', 'adminOnly'],
        users: [
          { userId: 'user1', permissions: [] },
          { userId: 'member1', permissions: [] },
          { userId: 'manager1', permissions: [] },
        ],
      } as WithId<IOrganizationDocument>);
      grants.push(grant('lakeB', 'member1', 'owner'), grant('lakeA', 'adminOnly', 'curator'));

      await deleteOrganization(owner as IUserDocument, { id: 'org1' }, mockAdapters);

      expect(find('lakeB', 'member1')?.expiresAt).toBeInstanceOf(Date);
      expect(find('lakeB', 'user1')).toEqual(expect.objectContaining({ role: 'owner', expiresAt: null }));
      expect(find('lakeA', 'adminOnly')?.expiresAt).toBeInstanceOf(Date);
    });

    it('hands a lake created by someone off the roster to the billing owner, without lapsing their grants', async () => {
      lakes.push(lake('lakeC', 'org1', 'formerMember'));
      grants.push(grant('lakeC', 'formerMember', 'curator'));

      await deleteOrganization(owner as IUserDocument, { id: 'org1' }, mockAdapters);

      expect(find('lakeC', 'user1')).toEqual(expect.objectContaining({ role: 'owner', expiresAt: null }));
      expect(find('lakeC', 'formerMember')?.expiresAt).toBeNull();
    });

    it('leaves a lake alone when its off-roster creator still holds their seeded owner grant', async () => {
      lakes.push(lake('lakeC', 'org1', 'formerMember'));
      grants.push(grant('lakeC', 'formerMember', 'owner'));

      await deleteOrganization(owner as IUserDocument, { id: 'org1' }, mockAdapters);

      expect(find('lakeC', 'user1')).toBeUndefined();
      expect(find('lakeC', 'formerMember')).toEqual(expect.objectContaining({ role: 'owner', expiresAt: null }));
      // Only lakeB (roster creator, roster owner) is succeeded.
      const successions = mockAdapters.db.lakeConfigChangeEvents.record.mock.calls.filter(
        ([event]: [{ action: string }]) => event.action === 'membership-succession'
      );
      expect(successions).toHaveLength(1);
    });

    it("reads the org's grants once for both phases", async () => {
      await deleteOrganization(owner as IUserDocument, { id: 'org1' }, mockAdapters);

      expect(mockAdapters.db.dataLakeAccessGrants.listActiveByLakes).toHaveBeenCalledTimes(1);
    });

    it('is idempotent: a re-run writes and records nothing further', async () => {
      await deleteOrganization(owner as IUserDocument, { id: 'org1' }, mockAdapters);
      const snapshot = structuredClone(grants);
      mockAdapters.db.dataLakeAccessGrants.upsertGrant.mockClear();
      mockAdapters.db.lakeConfigChangeEvents.record.mockClear();

      await deleteOrganization(owner as IUserDocument, { id: 'org1' }, mockAdapters);

      expect(mockAdapters.db.dataLakeAccessGrants.upsertGrant).not.toHaveBeenCalled();
      expect(mockAdapters.db.lakeConfigChangeEvents.record).not.toHaveBeenCalled();
      expect(grants).toEqual(snapshot);
    });

    it('records one revoke-access audit event per lapsed grant, attributed to the deleting user', async () => {
      await deleteOrganization(owner as IUserDocument, { id: 'org1' }, mockAdapters);

      const actions = mockAdapters.db.lakeConfigChangeEvents.record.mock.calls.map(
        ([event]: [{ action: string }]) => event.action
      );
      expect(actions.filter((a: string) => a === 'revoke-access')).toHaveLength(3);
      expect(actions.filter((a: string) => a === 'membership-succession')).toHaveLength(1);
    });

    it('touches no grants when validation rejects the delete', async () => {
      mockAdapters.validation = {
        canDeleteOrganization: vi.fn().mockResolvedValue({ canDelete: false, reason: 'blocked' }),
      };

      await expect(deleteOrganization(owner as IUserDocument, { id: 'org1' }, mockAdapters)).rejects.toThrow(
        'Organization deletion validation failed: blocked'
      );

      expect(mockAdapters.db.dataLakeAccessGrants.upsertGrant).not.toHaveBeenCalled();
    });
  });
});
