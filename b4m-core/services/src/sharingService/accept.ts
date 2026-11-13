import {
  grantablePermissions,
  IFabFileRepository,
  IGroupDocument,
  IInvite,
  IInviteRepository,
  InviteType,
  IOrganizationDocument,
  IOrganizationRepository,
  IProjectRepository,
  ISessionRepository,
  IShareableDocument,
  IUserDocument,
  Permission,
  ShareableAccessShape,
  isLinkOnlyInvite,
  ConflictError,
  isOrgMember,
  isOrgOwnerOrCurrentAdmin,
  isOrgOwnerOrPlatformAdmin,
  roleForPermissions,
} from '@bike4mind/common';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  secureParameters,
  UnprocessableEntityError,
} from '@bike4mind/utils';
import { z } from 'zod';
import { pendingOrgInviteRecipients } from './orgSeatReservations';
import { resolveRedeemableInvite } from './resolveRedeemableInvite';
import { assertContentInvitePolicy } from './organizationPolicy';

const acceptInviteSchema = z.object({
  id: z.string(),
});

type AcceptInviteParameters = z.infer<typeof acceptInviteSchema>;

interface AcceptInviteAdapters {
  db: {
    invites: IInviteRepository;
    sessions: ISessionRepository;
    projects: IProjectRepository;
    fabFiles: IFabFileRepository;
    // Same shape authorizeByInviteType.ts already uses to resolve a group's parent org.
    groups: {
      findById: (id: string) => Promise<IGroupDocument | null>;
    };
    organization: {
      findById: (id: string) => Promise<IOrganizationDocument | null>;
      addMemberIfUnderCeiling: IOrganizationRepository['addMemberIfUnderCeiling'];
      ensureUserDetails: (organizationId: string, member: { id: string; email: string; name: string }) => Promise<void>;
    };
    users: {
      findById: (id: string) => Promise<IUserDocument | null>;
      update: (data: Partial<IUserDocument>) => Promise<unknown>;
    };
  };
}

// Invite types a non-owner can mint, so their accept re-checks the inviter's current access.
const RESHAREABLE_INVITE_TYPES: ReadonlySet<InviteType> = new Set([
  InviteType.Session,
  InviteType.FabFile,
  InviteType.Project,
]);

type Inviter = Pick<IUserDocument, 'id' | 'groups'> | null;

// 'already-member': a named org invite reached someone already in the org; it was consumed, nothing granted.
export type AcceptInviteOutcome = 'accepted' | 'already-member';

/**
 * Accepts an invite from a user.
 *
 * @param userId - The ID of the user accepting the invite.
 * @param params - The parameters for the accept invite operation.
 * @param adapters - The adapters for the database operations.
 * @returns The invite after accepting, and whether the accept granted access or found an existing org member.
 */
export const acceptInvite = async (
  userId: string,
  params: AcceptInviteParameters,
  { db }: AcceptInviteAdapters
): Promise<{ invite: IInvite; outcome: AcceptInviteOutcome }> => {
  const { id } = secureParameters(params, acceptInviteSchema);

  const user = await db.users.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  if (!user.email) throw new UnprocessableEntityError('User has no email');

  // Holding the key IS the authorization on a link invite, so it resolves through the redemption
  // door rather than findById: a tokenized invite is addressable only by its token, and a legacy
  // tokenless one still answers to its id until it expires.
  const invite = await resolveRedeemableInvite(id, { db });
  if (!invite) throw new NotFoundError('Invite not found');

  if (invite.revokedAt) throw new UnprocessableEntityError('Invite has been revoked');

  // createInvite defaults expiresAt 100 years out, so this only bites a real expiration.
  if (invite.expiresAt && invite.expiresAt < new Date()) {
    throw new UnprocessableEntityError('Invite has expired');
  }

  const acceptedEmail = user.email.toLowerCase();
  if (
    invite.type === InviteType.Organization &&
    isLinkOnlyInvite(invite) &&
    (invite.remaining <= 0 || invite.recipients?.accepted?.some(address => address.toLowerCase() === acceptedEmail))
  ) {
    const organization = await db.organization.findById(invite.documentId);
    if (organization && isMemberOf(organization, user.id))
      throw new ConflictError('You are already a member of this organization');
  }

  if (invite.remaining <= 0) {
    throw new UnprocessableEntityError('Invite has no remaining users');
  }

  // Checked before the pending-membership gate below: a user who already accepted has moved
  // out of `pending` into `accepted`, so on a multi-recipient invite where others are still
  // pending, checking membership first would misreport a re-accept as "not sent to your
  // account" instead of "already accepted".
  if ((invite.recipients?.accepted || []).some(email => email.toLowerCase() === acceptedEmail)) {
    throw new UnprocessableEntityError('User has already accepted the invite');
  }

  // A named invite names specific recipients in `pending`; only they may consume a slot, or
  // `remaining` (now sized to the recipient count, not a flat 1) lets an unintended accepter claim
  // a share meant for someone else while a named recipient still hasn't accepted.
  //
  // Keyed on isLinkOnly rather than `pending.length > 0`, which fell open in exactly the case that
  // needed it most: Project and Organization invites carry raw user ids that createInvite could not
  // resolve, so `pending` was empty and a stranger holding the id could accept and join. Rows
  // minted before the flag and before that resolution landed have no recipients to check against,
  // so they now fail closed here and have to be re-sent. Once every named recipient has accepted,
  // `pending` is empty and the `remaining <= 0` check above blocks further accepts anyway.
  //
  // Case-insensitive: a Project invite to an address with no account stores it lowercased, while an
  // SSO signup stores the provider's casing verbatim (the listing in InviteModel already matches
  // case-insensitively, so without this the invitee sees an invite they cannot accept).
  const email = user.email.toLowerCase();
  const isEmail = (entry: string) => entry.toLowerCase() === email;
  if (!isLinkOnlyInvite(invite) && !invite.recipients?.pending?.some(isEmail)) {
    throw new ForbiddenError('This invite was not sent to your account');
  }

  // Exact host match on a verified address: an unverified email is only a claim, and a subdomain is
  // not the domain the inviter named.
  if (invite.allowedDomains?.length) {
    const domain = email.slice(email.lastIndexOf('@') + 1);
    if (!user.emailVerified || !invite.allowedDomains.includes(domain)) {
      throw new ForbiddenError(
        `This invite is limited to verified email addresses at ${invite.allowedDomains.join(', ')}`
      );
    }
  }

  // Assumes the invite carries permissions.
  const inviteWithPermissions = invite as IInvite & { permissions: Permission[] };

  const invitePermissions = inviteWithPermissions.permissions;

  const inviter =
    invite.inviterId && RESHAREABLE_INVITE_TYPES.has(invite.type) ? await db.users.findById(invite.inviterId) : null;

  let outcome: AcceptInviteOutcome = 'accepted';
  switch (invite.type) {
    case InviteType.Group: {
      const group = await db.groups.findById(invite.documentId);
      if (!group) throw new NotFoundError('Group not found');

      const organization = await db.organization.findById(group.organizationId);
      if (!organization) throw new NotFoundError('Organization not found');

      // Write-path invariant (organizationService/groupMembership.ts): every group-membership
      // write must confirm the target user is a member of the group's owning organization.
      // This case previously had NO check at all - anyone holding (or guessing) an invite id
      // could attach themselves to a group and inherit whatever it gates, since user.groups is
      // read by CASL sharing, both data-lake paths, and KB retrieve/search (#1224). Matching
      // invariant (2)'s error, not a distinct message: a different error for "wrong org" vs.
      // "not a member" would leak which is true for a caller probing invite ids.
      const isMember = organization.users.some(member => member.userId === userId);
      if (!isMember) {
        throw new BadRequestError('User is not a member of this organization');
      }

      // Dedupe before appending: a user can hold the same invite link twice (e.g. two browser
      // tabs), and a duplicate id would double-count them in memberCount and duplicate list
      // rendering. This is a read-modify-write of `groups`, NOT a `$addToSet` - so
      // the guard alone does not make concurrent accepts safe. Two accepts racing on the same user
      // are serialized by the caller's transaction (they conflict on the same document, and the
      // loser retries against the winner's committed state); the read side is defended separately
      // by the `$addToSet` in UserModel.findUserIdsByGroupIds.
      user.groups ||= [];
      if (!user.groups.includes(group.id)) {
        user.groups.push(group.id);
      }
      await db.users.update({ id: user.id, groups: user.groups });
      break;
    }
    case InviteType.Session: {
      const session = await db.sessions.findById(invite.documentId);
      if (!session) throw new NotFoundError('Session not found');
      await assertContentInvitePolicy(session, [user], db.organization, isLinkOnlyInvite(invite));
      const granted = permissionsInviterCanStillGrant(session, invite, invitePermissions, inviter);

      // A session's knowledgeIds can point at files the inviter neither owns nor holds
      // share on (e.g. attached from someone else's shared session), so accepting must
      // not launder access to those files through the invite. Cap each file's grant at
      // what the INVITER actually holds on it, not the invite's face-value permissions.
      // A legacy invite with no inviterId falls back to the conservative case: only
      // propagate to files the session owner themselves owns.
      if (session.knowledgeIds && session.knowledgeIds.length > 0) {
        await Promise.all(
          session.knowledgeIds.map(async knowledgeId => {
            const fabfile = await db.fabFiles.findById(knowledgeId);
            if (!fabfile) return;

            let grantPermissions: Permission[];
            if (inviter) {
              // Gate THEN cap. Propagating a file grant is a re-share of that file, so the inviter
              // must hold share on it, not merely hold the permission being passed on; without the
              // gate a read-only sharee could launder read onto everyone they invite to a session.
              grantPermissions = reshareableBy(fabfile, inviter, granted).granted;
              if (grantPermissions.length === 0) return;
            } else if (fabfile.userId === session.userId) {
              // Legacy path: invites minted before `inviterId` existed. Strictly narrower than the
              // gated branch above, so it fails closed. The backfill-invite-inviter-id migration populates
              // inviterId from the username every invite already carries; once that has run
              // everywhere this arm has no remaining input and should be deleted.
              grantPermissions = granted;
            } else {
              return;
            }

            await db.fabFiles.shareable.updateUserShares(fabfile.id, {
              add: [{ userId, permissions: grantPermissions, sessionId: session.id }],
            });
          })
        );
      }
      await db.sessions.shareable.updateUserShares(session.id, { add: [{ userId, permissions: granted }] });
      break;
    }
    case InviteType.FabFile: {
      const fabfile = await db.fabFiles.findById(invite.documentId);
      if (!fabfile) {
        throw new NotFoundError('Fabfile not found');
      }

      const granted = permissionsInviterCanStillGrant(fabfile, invite, invitePermissions, inviter);
      await db.fabFiles.shareable.updateUserShares(fabfile.id, { add: [{ userId, permissions: granted }] });
      break;
    }
    case InviteType.Organization:
      outcome = await acceptOrganization(
        user,
        {
          organizationId: invite.documentId,
          permissions: inviteWithPermissions.permissions,
          isLink: isLinkOnlyInvite(invite),
          inviterId: invite.inviterId,
        },
        { db }
      );
      break;
    case InviteType.Project:
      await acceptProject(user, inviteWithPermissions, inviter, { db });
      break;
    default:
      throw new Error('Invalid invite type');
  }

  // Written after the grant so a refused accept (e.g. the inviter lost share) leaves the slot unspent
  // even without the route's transaction.
  const accepted = await db.invites.acceptRecipient(invite.id, user.email);
  if (!accepted) throw new UnprocessableEntityError('Invite has no remaining users');

  return { invite: accepted, outcome };
};

interface AcceptOrganizationParameters {
  organizationId: string;
  permissions: Permission[];
  isLink: boolean;
  inviterId?: string;
}

const isMemberOf = (organization: IOrganizationDocument, userId: string) =>
  organization.userId === userId || organization.users.some(member => member.userId === userId);

const acceptOrganization = async (
  user: IUserDocument,
  params: AcceptOrganizationParameters,
  { db }: AcceptInviteAdapters
): Promise<AcceptInviteOutcome> => {
  const { organizationId, permissions, isLink } = params;
  const organization = await db.organization.findById(organizationId);

  if (!organization) {
    throw new NotFoundError('Organization not found');
  }
  // A named invite to an existing member is still consumed (by the caller's acceptRecipient), so its
  // address leaves recipients.pending and stops reserving a seat; only a link join reports the 409.
  // The member keeps their current role: an invite never changes it, only an org owner does.
  if (isMemberOf(organization, user.id)) {
    if (isLink) throw new ConflictError('You are already a member of this organization');
    if (organization.users.some(member => member.userId === user.id)) {
      await db.organization.ensureUserDetails(organizationId, {
        id: user.id,
        email: user.email ?? user.username,
        name: user.name,
      });
    }
    return 'already-member';
  }

  if (isLink) {
    const minter = params.inviterId ? await db.users.findById(params.inviterId) : null;
    if (
      !minter ||
      !isOrgMember(minter, organization) ||
      !isOrgOwnerOrCurrentAdmin(minter, organization) ||
      (roleForPermissions(permissions) !== 'viewer' && !isOrgOwnerOrPlatformAdmin(minter, organization))
    ) {
      throw new ForbiddenError('The inviter can no longer grant access to this organization');
    }
  }

  // A named invite's seat was reserved when it was minted, so only a link join holds the others back.
  // The reservation is read from Invite docs while the conditional update reads only the Organization,
  // so concurrent bulk minting and link joins can over-reserve pending seats; the accepted roster
  // remains bounded by the conditional Organization update.
  const ownEmail = (user.email ?? '').trim().toLowerCase();
  const orgInvites = isLink ? await db.invites.findAllByDocumentId(organizationId) : [];
  const reservedSeats = pendingOrgInviteRecipients(orgInvites).filter(address => address !== ownEmail).length;
  // One conditional update, so concurrent joins cannot both pass the seat check; it runs inside the
  // caller's transaction, so a later acceptRecipient failure rolls the join back.
  const added = await db.organization.addMemberIfUnderCeiling(
    organizationId,
    { userId: user.id, permissions },
    reservedSeats
  );
  if (!added) {
    const current = await db.organization.findById(organizationId);
    if (!current) throw new NotFoundError('Organization not found');
    if (isMemberOf(current, user.id)) {
      if (isLink) throw new ConflictError('You are already a member of this organization');
      if (current.users.some(member => member.userId === user.id)) {
        await db.organization.ensureUserDetails(organizationId, {
          id: user.id,
          email: user.email ?? user.username,
          name: user.name,
        });
      }
      return 'already-member';
    }
    throw new ForbiddenError('Organization is full');
  }

  // A named invite addressed to someone who joined by link would otherwise keep holding a seat for a
  // member who already has one. Inside the caller's transaction, so a rolled-back join restores it.
  if (ownEmail) {
    const ownNamedInvites = orgInvites.filter(invite =>
      (invite.recipients?.pending ?? []).some(address => address.trim().toLowerCase() === ownEmail)
    );
    for (const invite of ownNamedInvites) await db.invites.cancelPendingRecipient(invite.id, ownEmail);
  }

  // Seed the credit side-table via the idempotent guarded $push - keeps users[]/userDetails[] in sync
  // and, unlike the previous unconditional push, never creates a duplicate row on a re-accept.
  await db.organization.ensureUserDetails(organizationId, {
    id: user.id,
    email: user.email ?? user.username,
    name: user.name,
  });

  // Establish the selected-org display preference on the user document. This is
  // the field the UI reads for the active-org switcher; lake authorization reads
  // the membership set via findMembershipOrgIds (#1674), not this pointer. Without
  // this, the accepting user's `organizationId` stays null and has no org selected
  // in the UI. Mirrors the InviteType.Group path above and organizationService.addMember,
  // which set the selected organization as a required side effect of joining.
  user.organizationId = organizationId;
  await db.users.update({ id: user.id, organizationId: user.organizationId });
  return 'accepted';
};

const acceptProject = async (
  user: IUserDocument,
  invite: IInvite & { permissions: Permission[] },
  inviter: Inviter,
  adapters: AcceptInviteAdapters
) => {
  const projectId = invite.documentId;
  const { db } = adapters;

  const project = await db.projects.findById(projectId);

  if (!project) {
    throw new NotFoundError('Project not found');
  }

  const permissions = permissionsInviterCanStillGrant(project, invite, invite.permissions, inviter);
  await assertContentInvitePolicy(project, [user], db.organization);

  await db.projects.shareable.updateUserShares(project.id, { add: [{ userId: user.id, permissions }] });

  const files = await db.fabFiles.findAllByIds([
    ...project.fileIds,
    ...project.systemPrompts.map(prompt => prompt.fileId),
  ]);
  const sessions = await db.sessions.findAllByIds(project.sessionIds);

  const grant = { add: [{ userId: user.id, permissions, projectId }] };
  for (const file of files) await db.fabFiles.shareable.updateUserShares(file.id, grant);
  for (const session of sessions) await db.sessions.shareable.updateUserShares(session.id, grant);
};

/**
 * What an invite may still grant on `doc`. An invite minted by a non-owner is a re-share, so it is only
 * as good as the minter's CURRENT access: revoking their share kills the links they handed out, and
 * narrowing it narrows them. Owner-minted and legacy (no inviterId) invites pass through unchanged.
 * A deleted inviter (null) holds nothing, so their links are refused.
 */
const permissionsInviterCanStillGrant = (
  doc: IShareableDocument & { userId: string },
  invite: IInvite,
  permissions: Permission[],
  inviter: Inviter
): Permission[] => {
  if (!invite.inviterId || invite.inviterId === doc.userId) return permissions;

  const { holdsShare, granted } = reshareableBy(doc, inviter, permissions);
  // An empty invite from an inviter who still holds share is a no-op grant, as when owner-minted.
  if (!holdsShare || (granted.length === 0 && permissions.length > 0)) {
    throw new ForbiddenError('The person who shared this can no longer share it');
  }
  return granted;
};

/**
 * What `inviter` can currently pass on for `doc`: `granted` is the subset of `permissions` they may
 * re-share (empty unless they hold share there), and `holdsShare` is whether they hold share at all.
 * Both are resolved here once so the gate-then-cap rule has a single home.
 */
const reshareableBy = (
  doc: IShareableDocument & { userId: string },
  inviter: Inviter,
  permissions: Permission[]
): { holdsShare: boolean; granted: Permission[] } => {
  const held = grantablePermissions(doc as ShareableAccessShape, inviter?.id, inviter?.groups ?? []);
  const holdsShare = held.has(Permission.share);
  return { holdsShare, granted: holdsShare ? permissions.filter(permission => held.has(permission)) : [] };
};

// In-memory form of the shareable repositories' updateUserShares merge (SharableDocumentModel.ts in
// packages/database); the two must keep the same row key and permission union.
export const pushShareable = (
  entity: IShareableDocument,
  data: { userId: string; permissions: Permission[]; projectId?: string; sessionId?: string }
) => {
  entity.users ||= [];
  // Keyed on (userId, projectId, sessionId), not userId alone: an entry records a grant's SOURCE,
  // and revoke filters on that tag. Merging on the user alone collapsed two projects' grants into
  // one entry carrying whichever projectId was written last, so revoking via the earlier project
  // matched nothing and reported success while access stayed live, and revoking via the later one
  // tore out the other project's grant with it. sessionId is here for the same reason: a session's
  // knowledge propagation is the other grant-deriving path, and while it was untagged it merged
  // into any direct share of the same file to the same user - so revoking the session deleted a
  // grant a third party had made, which the revoker had no authority over. A direct share is its
  // own untagged row, which is what keeps the two SCOPED cascades off it. An unscoped revoke in
  // revoke.ts is deliberately broader and still clears every row the user holds on the document.
  const userIndex = entity.users.findIndex(
    user =>
      user.userId === data.userId &&
      (user.projectId ?? undefined) === (data.projectId ?? undefined) &&
      (user.sessionId ?? undefined) === (data.sessionId ?? undefined)
  );
  if (userIndex === -1) {
    entity.users.push({
      userId: data.userId,
      permissions: data.permissions,
      projectId: data.projectId,
      sessionId: data.sessionId,
    });
  } else {
    // Merge, don't replace: every grant path grants or refreshes access, none narrows it, so an update
    // here must never silently drop the existing entry's extraData or narrow permissions it already
    // carries down to just this grant.
    const existing = entity.users[userIndex];
    entity.users[userIndex] = {
      ...existing,
      userId: data.userId,
      projectId: data.projectId,
      sessionId: data.sessionId,
      permissions: Array.from(new Set([...(existing.permissions ?? []), ...data.permissions])),
    };
  }
};
