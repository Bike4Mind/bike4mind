import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setOrganizationMemberRole } from './setOrganizationMemberRole';
import { type AssignableOrgRole, IOrganizationDocument, IUserDocument, Permission } from '@bike4mind/common';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/utils';

describe('organizationService - setOrganizationMemberRole', () => {
  const owner = { id: 'owner1', isAdmin: false } as IUserDocument;
  const manager = { id: 'admin1', isAdmin: false } as IUserDocument;
  const billingManager = { id: 'billing1', isAdmin: false } as IUserDocument;
  const plainMember = { id: 'user2', isAdmin: false } as IUserDocument;
  const platformAdmin = { id: 'staff1', isAdmin: true } as IUserDocument;

  const freshOrg = (over: Partial<IOrganizationDocument> = {}) =>
    ({
      id: 'org1',
      name: 'Team',
      userId: 'owner1',
      personal: false,
      users: [
        { userId: 'admin1', permissions: [Permission.read] },
        { userId: 'billing1', permissions: [Permission.read] },
        { userId: 'user2', permissions: [Permission.read] },
        { userId: 'user3', permissions: [Permission.read] },
        { userId: 'norights', permissions: [] },
      ],
      adminUserIds: ['admin1'],
      billingManagerUserIds: ['billing1'],
      ...over,
    }) as IOrganizationDocument;

  let org: IOrganizationDocument;

  const buildAdapters = () => ({
    db: {
      organizations: {
        findById: vi.fn(async (): Promise<IOrganizationDocument | null> => org),
        setMemberRole: vi.fn(async (_orgId: string, userId: string, role: AssignableOrgRole) => {
          const without = (ids: string[] = []) => ids.filter(id => id !== userId);
          org = {
            ...org,
            adminUserIds: role === 'manager' ? [...without(org.adminUserIds), userId] : without(org.adminUserIds),
            billingManagerUserIds:
              role === 'billingManager'
                ? [...without(org.billingManagerUserIds), userId]
                : without(org.billingManagerUserIds),
          } as IOrganizationDocument;
          return true;
        }),
      },
    },
  });
  let adapters: ReturnType<typeof buildAdapters>;

  beforeEach(() => {
    org = freshOrg();
    adapters = buildAdapters();
  });

  const run = (actor: IUserDocument, userId: string, role: AssignableOrgRole) =>
    setOrganizationMemberRole(actor, { organizationId: 'org1', userId, role }, adapters);

  it('lets the owner make a member a billing manager', async () => {
    const change = await run(owner, 'user2', 'billingManager');

    expect(adapters.db.organizations.setMemberRole).toHaveBeenCalledWith('org1', 'user2', 'billingManager');
    expect(change).toMatchObject({ previousRole: 'member', role: 'billingManager', changed: true });
    expect(change.organization.billingManagerUserIds).toEqual(['billing1', 'user2']);
  });

  it('lets the owner move a manager to member', async () => {
    const change = await run(owner, 'admin1', 'member');

    expect(change).toMatchObject({ previousRole: 'manager', role: 'member', changed: true });
    expect(change.organization.adminUserIds).toEqual([]);
  });

  it('lets a platform admin who is not on the roster assign a role', async () => {
    await expect(run(platformAdmin, 'user2', 'manager')).resolves.toMatchObject({ changed: true });
  });

  it('lets a manager make a member a manager', async () => {
    await expect(run(manager, 'user2', 'manager')).resolves.toMatchObject({ role: 'manager', changed: true });
  });

  it.each([
    ['a billing manager role', 'user2', 'billingManager'],
    ['a demotion of a billing manager', 'billing1', 'member'],
  ] as const)('refuses a manager %s without writing', async (_label, target, role) => {
    await expect(run(manager, target, role)).rejects.toThrow(ForbiddenError);
    expect(adapters.db.organizations.setMemberRole).not.toHaveBeenCalled();
  });

  it.each([
    ['a billing manager', billingManager],
    ['a plain member', plainMember],
  ])('answers %s like a missing org', async (_label, actor) => {
    await expect(run(actor, 'user3', 'manager')).rejects.toThrow(NotFoundError);
    expect(adapters.db.organizations.setMemberRole).not.toHaveBeenCalled();
  });

  it("refuses to change the owner's role", async () => {
    await expect(run(owner, 'owner1', 'member')).rejects.toThrow(BadRequestError);
  });

  it('refuses someone off the roster', async () => {
    await expect(run(owner, 'outsider', 'manager')).rejects.toThrow(BadRequestError);
  });

  it('refuses a role for a row that confers no membership, but allows member', async () => {
    await expect(run(owner, 'norights', 'manager')).rejects.toThrow(BadRequestError);
    await expect(run(owner, 'norights', 'member')).resolves.toMatchObject({ changed: false });
  });

  it('refuses a personal organization', async () => {
    org = freshOrg({ personal: true });
    await expect(run(owner, 'user2', 'manager')).rejects.toThrow(BadRequestError);
  });

  it('reports a no-op without writing', async () => {
    const change = await run(owner, 'admin1', 'manager');

    expect(change.changed).toBe(false);
    expect(adapters.db.organizations.setMemberRole).not.toHaveBeenCalled();
  });

  it('refuses when the member was removed between the read and the write', async () => {
    adapters.db.organizations.setMemberRole.mockResolvedValueOnce(false);
    await expect(run(owner, 'user2', 'manager')).rejects.toThrow(BadRequestError);
  });

  it('answers a missing org with NotFoundError', async () => {
    adapters.db.organizations.findById.mockResolvedValueOnce(null);
    await expect(run(owner, 'user2', 'manager')).rejects.toThrow(NotFoundError);
  });
});
