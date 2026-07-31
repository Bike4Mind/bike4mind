import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InviteType, IUserDocument, Permission } from '@bike4mind/common';
import { BadRequestError, ForbiddenError } from '@bike4mind/utils';
import { createInvite } from './create';

/**
 * Authority tests for the InviteType.Group arm. Minting a group invite grants group membership,
 * so it requires the same org authority as the members route (assertCanManageOrgGroups).
 */
describe('sharingService - createInvite (group arm authority)', () => {
  const OWNER_ID = 'owner-1';
  const ADMIN_MEMBER_ID = 'org-admin-1';
  const PLAIN_MEMBER_ID = 'member-1';
  const OUTSIDER_ID = 'outsider-1';
  const GROUP_ID = 'group-1';
  const ORG_ID = 'org-1';
  const GROUP_NAME = 'Confidential Group';

  const group = { id: GROUP_ID, name: GROUP_NAME, organizationId: ORG_ID };

  const organization = {
    id: ORG_ID,
    name: 'Org',
    userId: OWNER_ID,
    adminUserIds: [ADMIN_MEMBER_ID],
    users: [
      { userId: ADMIN_MEMBER_ID, permissions: [] },
      { userId: PLAIN_MEMBER_ID, permissions: [] },
    ],
  };

  const asUser = (id: string, isAdmin = false) => ({ id, username: 'u', isAdmin }) as IUserDocument;

  let db: any;

  beforeEach(() => {
    db = {
      invites: { create: vi.fn(async (build: unknown) => ({ id: 'invite-1', ...(build as object) })) },
      users: { findAllByEmailsOrUsernames: vi.fn(async () => []) },
      fabFiles: { findByIdAndUserId: vi.fn(), shareable: { findShareAccessById: vi.fn() } },
      sessions: { findByIdAndUserId: vi.fn() },
      projects: { findById: vi.fn() },
      organizations: { findById: vi.fn(async () => organization) },
      groups: { findById: vi.fn(async () => group) },
    };
  });

  const create = (user: IUserDocument, id = GROUP_ID) =>
    createInvite(user, { id, type: InviteType.Group, permissions: [Permission.read] } as any, { db });

  it('allows the billing owner to create a group invite', async () => {
    const invite = await create(asUser(OWNER_ID));

    expect(invite.name).toBe(GROUP_NAME);
    expect(db.invites.create).toHaveBeenCalled();
  });

  it('allows an appointed org admin who is still a member', async () => {
    const invite = await create(asUser(ADMIN_MEMBER_ID));

    expect(invite.name).toBe(GROUP_NAME);
  });

  it('allows a platform admin', async () => {
    const invite = await create(asUser('platform-1', true));

    expect(invite.name).toBe(GROUP_NAME);
  });

  it('rejects a group invite created by a plain org member', async () => {
    await expect(create(asUser(PLAIN_MEMBER_ID))).rejects.toThrow(ForbiddenError);
    expect(db.invites.create).not.toHaveBeenCalled();
  });

  it('rejects a caller outside the organization and returns no group name', async () => {
    await expect(create(asUser(OUTSIDER_ID))).rejects.toSatisfy(
      (e: Error) => e instanceof ForbiddenError && !e.message.includes(GROUP_NAME)
    );
    expect(db.invites.create).not.toHaveBeenCalled();
  });

  it('rejects an appointed org admin who is no longer a member', async () => {
    db.organizations.findById = vi.fn(async () => ({
      ...organization,
      users: [{ userId: PLAIN_MEMBER_ID, permissions: [] }],
    }));

    await expect(create(asUser(ADMIN_MEMBER_ID))).rejects.toThrow(ForbiddenError);
  });

  it('fails closed for a group with no organizationId (pre-org-groups data)', async () => {
    db.groups.findById = vi.fn(async () => ({ id: GROUP_ID, name: GROUP_NAME }));

    await expect(create(asUser(OWNER_ID))).rejects.toThrow(BadRequestError);
    expect(db.organizations.findById).not.toHaveBeenCalled();
  });

  it('fails closed when the group is missing', async () => {
    db.groups.findById = vi.fn(async () => null);

    await expect(create(asUser(OWNER_ID))).rejects.toThrow(BadRequestError);
  });

  it('fails closed when the owning organization is missing', async () => {
    db.organizations.findById = vi.fn(async () => null);

    await expect(create(asUser(OWNER_ID))).rejects.toThrow(BadRequestError);
  });
});
