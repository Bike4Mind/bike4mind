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
      users: { findAllByEmailsOrUsernames: vi.fn(async () => []), findByIds: vi.fn(async () => []) },
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
      users: { findAllByEmailsOrUsernames: vi.fn(async () => []), findByIds: vi.fn(async () => []) },
      projects: { shareable: { findShareAccessById } },
    };
  });

  const create = (user: IUserDocument, id = PROJECT_ID) =>
    createInvite(user, { id, type: InviteType.Project, permissions: [Permission.read] } as any, { db });

  it('creates an invite when the caller has share access, scoped to that caller and id', async () => {
    findShareAccessById.mockResolvedValue({ id: PROJECT_ID, name: PROJECT_NAME, userId: 'owner-2' });
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
      users: { findAllByEmailsOrUsernames: vi.fn(async () => []), findByIds: vi.fn(async () => []) },
      fabFiles: {
        shareable: {
          findShareAccessById: vi.fn(async () => ({ id: FILE_ID, fileName: FILE_NAME, userId: 'owner-3' })),
        },
      },
      projects: {
        shareable: {
          findShareAccessById: vi.fn(async () => ({ id: PROJECT_ID, name: PROJECT_NAME, userId: 'owner-4' })),
        },
      },
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

  it('resolves an id-shaped Project recipient by _id into pending', async () => {
    // The add-members modals send `recipients: [userId]`, which findAllByEmailsOrUsernames cannot
    // resolve (it queries email and username only). Leaving pending empty made the invite read as
    // "names nobody", which is what let any authenticated holder of the id view and accept it.
    db.users.findAllByEmailsOrUsernames = vi.fn(async () => []);
    db.users.findByIds = vi.fn(async () => [{ id: 'user-id-123', email: 'member@x.com', username: 'member' }]);

    const invite = await createProject(['user-id-123']);

    expect(db.users.findByIds).toHaveBeenCalledWith(['user-id-123']);
    expect((invite as any).recipients.pending).toEqual(['member@x.com']);
    expect((invite as any).isLinkOnly).toBe(false);
  });

  it('throws rather than minting a Project invite whose recipients all fail to resolve', async () => {
    db.users.findAllByEmailsOrUsernames = vi.fn(async () => []);
    db.users.findByIds = vi.fn(async () => []);

    await expect(createProject(['user-id-123'])).rejects.toBeInstanceOf(BadRequestError);
    expect(db.invites.create).not.toHaveBeenCalled();
  });

  it('marks a recipientless share link as link-only and a named invite as not', async () => {
    db.users.findAllByEmailsOrUsernames = vi.fn(async () => [{ email: 'a@x.com', username: 'a' }]);

    expect(((await createFabFile([])) as any).isLinkOnly).toBe(true);
    expect(((await createFabFile(['a@x.com'])) as any).isLinkOnly).toBe(false);
  });

  it('throws for a recipient matched only by username with no email, instead of silently dropping them', async () => {
    // accept.ts keys recipients.pending/accepted on email and rejects an emailless accepter
    // outright, so a username-only match is not actually shareable - it must fail loudly here,
    // not vanish from pending while the sharer is told the share succeeded.
    db.users.findAllByEmailsOrUsernames = vi.fn(async () => [{ email: null, username: 'noemail' }]);

    await expect(createFabFile(['noemail'])).rejects.toSatisfy(
      (e: Error) => e instanceof BadRequestError && e.message.includes('noemail')
    );
    expect(db.invites.create).not.toHaveBeenCalled();
  });

  it('throws when one recipient string matches more than one distinct user (case-insensitive collision)', async () => {
    // Uniqueness on the User schema is case-sensitive, so "Bob" and "bob" can be two real,
    // distinct accounts. The now-case-insensitive lookup can return both for one input - that
    // must fail as ambiguous, not silently grant access to whichever one happened to match.
    db.users.findAllByEmailsOrUsernames = vi.fn(async () => [
      { email: 'bob@x.com', username: 'Bob' },
      { email: 'BOB@x.com', username: 'bob' },
    ]);

    await expect(createFabFile(['bob'])).rejects.toSatisfy(
      (e: Error) => e instanceof BadRequestError && e.message.includes('bob')
    );
    expect(db.invites.create).not.toHaveBeenCalled();
  });

  it('sets remaining to the number of distinct resolved recipients, not a flat 1, for a multi-recipient share', async () => {
    // Previously every By-Users invite defaulted to remaining:1 regardless of recipient count,
    // so only the first of several recipients could ever accept while the sharer was told all
    // of them succeeded (#1151 acceptance criteria 1).
    db.users.findAllByEmailsOrUsernames = vi.fn(async () => [
      { email: 'a@x.com', username: 'a' },
      { email: 'b@x.com', username: 'b' },
    ]);

    const invite = await createFabFile(['a@x.com', 'b@x.com']);

    expect((invite as any).remaining).toBe(2);
    expect((invite as any).recipients.pending).toEqual(['a@x.com', 'b@x.com']);
  });

  it('dedupes when two recipient strings resolve to the same person, and remaining matches the unique count', async () => {
    db.users.findAllByEmailsOrUsernames = vi.fn(async () => [{ email: 'a@x.com', username: 'a' }]);

    const invite = await createFabFile(['a@x.com', 'a']);

    expect((invite as any).remaining).toBe(1);
    expect((invite as any).recipients.pending).toEqual(['a@x.com']);
  });
});

/**
 * A sharee re-sharing a document must not be able to mint permissions they do not themselves
 * hold: with `share` alone they could otherwise issue a link carrying `update`/`delete` and
 * redeem it on their own account.
 */
describe('sharingService - createInvite (permission capping)', () => {
  const FILE_ID = 'file-cap';
  const OWNER = 'owner-cap';
  const SHAREE = 'sharee-cap';

  const asUser = (id: string, groups: string[] = []) =>
    ({ id, username: 'u', isAdmin: false, groups }) as unknown as IUserDocument;

  const file = (overrides: Record<string, unknown>) => ({
    id: FILE_ID,
    fileName: 'doc.pdf',
    userId: OWNER,
    users: [],
    groups: [],
    ...overrides,
  });

  const dbFor = (doc: unknown) => ({
    invites: { create: vi.fn(async (build: unknown) => ({ id: 'invite-cap', ...(build as object) })) },
    users: { findAllByEmailsOrUsernames: vi.fn(async () => []), findByIds: vi.fn(async () => []) },
    fabFiles: { shareable: { findShareAccessById: vi.fn(async () => doc) } },
  });

  const mint = (user: IUserDocument, db: unknown, permissions: Permission[]) =>
    createInvite(user, { id: FILE_ID, type: InviteType.FabFile, permissions } as any, { db } as any);

  it('refuses a permission the sharer does not hold, naming it', async () => {
    const db = dbFor(file({ users: [{ userId: SHAREE, permissions: [Permission.read, Permission.share] }] }));

    await expect(mint(asUser(SHAREE), db, [Permission.update])).rejects.toSatisfy(
      (e: Error) => e instanceof BadRequestError && e.message.includes('update')
    );
    expect(db.invites.create).not.toHaveBeenCalled();
  });

  it('allows the permissions the sharer does hold', async () => {
    const db = dbFor(file({ users: [{ userId: SHAREE, permissions: [Permission.read, Permission.share] }] }));

    const invite = await mint(asUser(SHAREE), db, [Permission.read]);

    expect((invite as any).permissions).toEqual([Permission.read]);
  });

  it('lets the owner mint anything', async () => {
    const db = dbFor(file({}));

    const invite = await mint(asUser(OWNER), db, [Permission.update, Permission.delete]);

    expect((invite as any).permissions).toEqual([Permission.update, Permission.delete]);
  });

  it('counts a grant the sharer holds through a group', async () => {
    const db = dbFor(file({ groups: [{ groupId: 'g1', permissions: [Permission.read, Permission.share] }] }));

    const invite = await mint(asUser(SHAREE, ['g1']), db, [Permission.read]);

    expect((invite as any).permissions).toEqual([Permission.read]);
  });

  it('lets a share-only sharee grant read, which is what a share grant is for', async () => {
    const db = dbFor(file({ users: [{ userId: SHAREE, permissions: [Permission.share] }] }));

    const invite = await mint(asUser(SHAREE), db, [Permission.read]);

    expect((invite as any).permissions).toEqual([Permission.read]);
  });

  it('still refuses update from a share-only sharee', async () => {
    const db = dbFor(file({ users: [{ userId: SHAREE, permissions: [Permission.share] }] }));

    await expect(mint(asUser(SHAREE), db, [Permission.update])).rejects.toThrow(BadRequestError);
  });

  it('does not count a grant on a group the sharer is not in', async () => {
    const db = dbFor(file({ groups: [{ groupId: 'g-other', permissions: [Permission.read, Permission.update] }] }));

    await expect(mint(asUser(SHAREE, ['g1']), db, [Permission.update])).rejects.toThrow(BadRequestError);
  });
});

/**
 * Usernames are self-set and unvalidated, so an account may hold a username that is another
 * person's email address. An email-shaped recipient must resolve against the email field only,
 * or a share addressed to that person lands in the impostor's account instead.
 */
describe('sharingService - createInvite (email-shaped recipients)', () => {
  const FILE_ID = 'file-resolve';
  const OWNER = 'owner-resolve';

  let db: any;

  beforeEach(() => {
    db = {
      invites: { create: vi.fn(async (build: unknown) => ({ id: 'invite-resolve', ...(build as object) })) },
      users: { findAllByEmailsOrUsernames: vi.fn(async () => []), findByIds: vi.fn(async () => []) },
      fabFiles: {
        shareable: { findShareAccessById: vi.fn(async () => ({ id: FILE_ID, fileName: 'doc.pdf', userId: OWNER })) },
      },
    };
  });

  const share = (recipients: string[]) =>
    createInvite(
      { id: OWNER, username: 'u', isAdmin: false } as IUserDocument,
      { id: FILE_ID, type: InviteType.FabFile, permissions: [Permission.read], recipients } as any,
      { db }
    );

  it('does not resolve an email-shaped recipient against a self-set username', async () => {
    // The impostor's username IS the victim's email address; only the victim's real account
    // should ever satisfy 'victim@x.com'.
    db.users.findAllByEmailsOrUsernames = vi.fn(async () => [{ email: 'impostor@x.com', username: 'victim@x.com' }]);

    await expect(share(['victim@x.com'])).rejects.toSatisfy(
      (e: Error) => e instanceof BadRequestError && e.message.includes('victim@x.com')
    );
    expect(db.invites.create).not.toHaveBeenCalled();
  });

  it('still resolves an email-shaped recipient against the real email holder', async () => {
    db.users.findAllByEmailsOrUsernames = vi.fn(async () => [
      { email: 'impostor@x.com', username: 'victim@x.com' },
      { email: 'victim@x.com', username: 'victim' },
    ]);

    const invite = await share(['victim@x.com']);

    expect((invite as any).recipients.pending).toEqual(['victim@x.com']);
  });

  it('still resolves a plain username', async () => {
    db.users.findAllByEmailsOrUsernames = vi.fn(async () => [{ email: 'a@x.com', username: 'alice' }]);

    const invite = await share(['alice']);

    expect((invite as any).recipients.pending).toEqual(['a@x.com']);
  });
});
