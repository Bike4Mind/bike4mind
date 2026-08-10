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
      projects: { shareable: { findShareAccessById: vi.fn() } },
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

  it('rejects a caller outside the organization indistinguishably from a missing group', async () => {
    // BadRequestError, not ForbiddenError: a 403 here would confirm to an outsider that this group
    // id exists. Same error and message as the missing-group case below.
    await expect(create(asUser(OUTSIDER_ID))).rejects.toSatisfy(
      (e: Error) => e instanceof BadRequestError && !e.message.includes(GROUP_NAME)
    );
    expect(db.invites.create).not.toHaveBeenCalled();
  });

  it('gives an org member 403 but an outsider the generic error, for the same group', async () => {
    // The pair is the point: authority failures inside the org stay legible, while existence stays
    // hidden from outside it. Asserting either alone would not pin the distinction.
    await expect(create(asUser(PLAIN_MEMBER_ID))).rejects.toThrow(ForbiddenError);
    await expect(create(asUser(OUTSIDER_ID))).rejects.toThrow(BadRequestError);
  });

  it('rejects an appointed org admin who is no longer a member', async () => {
    db.organizations.findById = vi.fn(async () => ({
      ...organization,
      users: [{ userId: PLAIN_MEMBER_ID, permissions: [] }],
    }));

    // A removed admin is no longer in the org, so they get the outsider error rather than a 403 -
    // a stale adminUserIds entry must not reveal that the group still exists.
    await expect(create(asUser(ADMIN_MEMBER_ID))).rejects.toThrow(BadRequestError);
    expect(db.invites.create).not.toHaveBeenCalled();
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

/**
 * Authority tests for the InviteType.Project arm. Scoped to the caller's share access
 * (shareable.findShareAccessById), matching the FabFile arm - previously an unscoped findById,
 * so any authenticated caller who knew a project id could mint an invite for it.
 */
describe('sharingService - createInvite (project arm authority)', () => {
  const PROJECT_ID = 'project-1';
  const PROJECT_NAME = 'Confidential Project';

  const asUser = (id: string) => ({ id, username: 'u', isAdmin: false }) as IUserDocument;

  let db: any;
  let findShareAccessById: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    findShareAccessById = vi.fn();
    db = {
      invites: { create: vi.fn(async (build: unknown) => ({ id: 'invite-2', ...(build as object) })) },
      users: { findAllByEmailsOrUsernames: vi.fn(async () => []) },
      projects: { shareable: { findShareAccessById } },
    };
  });

  const create = (user: IUserDocument, id = PROJECT_ID) =>
    createInvite(user, { id, type: InviteType.Project, permissions: [Permission.read] } as any, { db });

  it('creates an invite when the caller has share access, scoped to that caller and id', async () => {
    findShareAccessById.mockResolvedValue({ id: PROJECT_ID, name: PROJECT_NAME });
    const user = asUser('owner-2');

    const invite = await create(user);

    expect(invite.name).toBe(PROJECT_NAME);
    expect(findShareAccessById).toHaveBeenCalledWith(user, PROJECT_ID);
  });

  it('rejects when the scoped lookup finds nothing', async () => {
    // Deliberately NOT named "indistinguishably from a missing project": with a single mock,
    // "no access" and "does not exist" are the same input, so nothing here distinguishes them.
    // That property is real (findShareAccessById returns null for both) but only the e2e test can
    // demonstrate it - see projectInviteAuth.e2e.test.ts.
    findShareAccessById.mockResolvedValue(null);

    await expect(create(asUser('outsider-1'))).rejects.toThrow(BadRequestError);
    expect(db.invites.create).not.toHaveBeenCalled();
  });
});

/**
 * A recipient that findAllByEmailsOrUsernames does not resolve previously fell through
 * silently: the invite was still created with an empty pending list and the route returned
 * 200, so the recipient's inbox stayed empty with no visible failure anywhere (#1151). Scoped
 * to FabFile/Session, since Organization/Project send raw user ids through this same
 * recipients array via a different resolution path and must keep tolerating a 0-match result.
 */
describe('sharingService - createInvite (recipient resolution)', () => {
  const FILE_ID = 'file-1';
  const FILE_NAME = 'doc.pdf';
  const PROJECT_ID = 'project-9';
  const PROJECT_NAME = 'Some Project';

  const asUser = (id: string) => ({ id, username: 'u', isAdmin: false }) as IUserDocument;

  let db: any;

  beforeEach(() => {
    db = {
      invites: { create: vi.fn(async (build: unknown) => ({ id: 'invite-3', ...(build as object) })) },
      users: { findAllByEmailsOrUsernames: vi.fn(async () => []) },
      fabFiles: { shareable: { findShareAccessById: vi.fn(async () => ({ id: FILE_ID, fileName: FILE_NAME })) } },
      projects: { shareable: { findShareAccessById: vi.fn(async () => ({ id: PROJECT_ID, name: PROJECT_NAME })) } },
    };
  });

  const createFabFile = (recipients: string[]) =>
    createInvite(
      asUser('owner-3'),
      { id: FILE_ID, type: InviteType.FabFile, permissions: [Permission.read], recipients } as any,
      { db }
    );

  const createProject = (recipients: string[]) =>
    createInvite(
      asUser('owner-4'),
      { id: PROJECT_ID, type: InviteType.Project, permissions: [Permission.read], recipients } as any,
      { db }
    );

  it('throws for an unresolved recipient on a FabFile (By Users) invite instead of silently creating a 0-recipient share', async () => {
    db.users.findAllByEmailsOrUsernames = vi.fn(async () => [{ email: 'a@x.com', username: 'a' }]);

    await expect(createFabFile(['a@x.com', 'nobody@x.com'])).rejects.toSatisfy(
      (e: Error) => e instanceof BadRequestError && e.message.includes('nobody@x.com')
    );
    expect(db.invites.create).not.toHaveBeenCalled();
  });

  it('resolves a recipient against a matched user record with different casing', async () => {
    db.users.findAllByEmailsOrUsernames = vi.fn(async () => [{ email: 'Friend@Example.com', username: 'friend' }]);

    const invite = await createFabFile(['friend@example.com']);

    expect(db.invites.create).toHaveBeenCalled();
    expect((invite as any).recipients.pending).toEqual(['Friend@Example.com']);
  });

  it('does not throw on an Organization/Project invite with an unmatched, id-shaped recipient', async () => {
    // No match, same as today, for an id-shaped recipient - the point is this must not become
    // a hard failure just because milestone 2 added unresolved-recipient checking elsewhere.
    db.users.findAllByEmailsOrUsernames = vi.fn(async () => []);

    const invite = await createProject(['user-id-123']);

    expect(db.invites.create).toHaveBeenCalled();
    expect((invite as any).recipients.pending).toEqual([]);
  });
});
