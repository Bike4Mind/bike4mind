import {
  IFabFileDocument,
  IGroupDocument,
  IInviteDocument,
  InviteType,
  IOrganizationRepository,
  IProjectRepository,
  ISessionDocument,
  IUserDocument,
  orgAclRowConfersMembership,
} from '@bike4mind/common';
import { NotFoundError, secureParameters, UnprocessableEntityError } from '@bike4mind/utils';
import { assertCanManageOrgGroups } from '../organizationService/groupMembership';
import { z } from 'zod';

const cancelInviteSchema = z.object({
  id: z.string(),
  type: z.enum(InviteType),
  email: z.email().optional(),
});

type CancelInviteParameters = z.infer<typeof cancelInviteSchema>;

interface CancelInviteAdapters {
  db: {
    invites: {
      findAllByDocumentId: (documentId: string) => Promise<IInviteDocument[]>;
      update: (data: IInviteDocument) => Promise<unknown>;
    };
    users: {
      findById: (id: string) => Promise<IUserDocument | null>;
    };
    sessions: {
      findByIdAndUserId: (id: string, userId: string) => Promise<ISessionDocument | null>;
    };
    fabFiles: {
      findByIdAndUserId: (id: string, userId: string) => Promise<IFabFileDocument | null>;
    };
    organizations: IOrganizationRepository;
    projects: Pick<IProjectRepository, 'shareable'>;
    groups: {
      findById: (id: string) => Promise<IGroupDocument | null>;
    };
  };
}

/**
 * Cancels remaining invites for a document.
 */
export const cancelInvite = async (
  user: IUserDocument,
  parameters: CancelInviteParameters,
  { db }: CancelInviteAdapters
) => {
  const { id, type, email } = secureParameters(parameters, cancelInviteSchema);
  // Typed errors, not bare `Error`: errorHandler cannot map a bare Error, so it falls through to a
  // 500, which trips the LiveOps CloudWatch filter on what are ordinary client conditions.
  if (!user.email) throw new UnprocessableEntityError('User has no email');

  if (type === InviteType.FabFile) {
    const fabFile = await db.fabFiles.findByIdAndUserId(id, user.id);
    if (!fabFile) throw new NotFoundError('Fab file not found');
  } else if (type === InviteType.Session) {
    const session = await db.sessions.findByIdAndUserId(id, user.id);
    if (!session) throw new NotFoundError('Session not found');
  } else if (type === InviteType.Organization) {
    const org = await db.organizations.findById(id);
    if (!org) throw new NotFoundError('Organization not found');
    // Disclosure guard: collapse non-member into the same error as "not found".
    const isInOrganization =
      user.isAdmin || org.userId === user.id || (org.users ?? []).some(m => m.userId === user.id);
    if (!isInOrganization) throw new NotFoundError('Organization not found');
    // Authority gate: only billing owner, appointed org admin, or platform admin may cancel org invites.
    assertCanManageOrgGroups(user, org);
  } else if (type === InviteType.Group) {
    const group = await db.groups.findById(id);
    if (!group) throw new NotFoundError('Group not found');
    const org = await db.organizations.findById(group.organizationId);
    if (!org) throw new NotFoundError('Group not found');
    // Disclosure guard: collapse non-member into the same error as "not found".
    const isInOrganization =
      user.isAdmin || org.userId === user.id || (org.users ?? []).some(m => m.userId === user.id);
    if (!isInOrganization) throw new NotFoundError('Group not found');
    // Authority gate: only billing owner, appointed org admin, or platform admin may cancel group invites.
    assertCanManageOrgGroups(user, org);
  } else if (type === InviteType.Project) {
    // Same share-access predicate the create and list paths use for Project
    // (sharingService/create.ts, authorizeByInviteType.ts).
    const project = await db.projects.shareable.findShareAccessById(user, id);
    if (!project) throw new NotFoundError('Project not found');
  } else {
    // Default deny: a type reaching this point has no authorization predicate written for it, so it
    // must not reach the write below, which zeroes every invite for the document and returns their
    // names and pending recipients. InviteType.Tool has no arm today, and neither would a newly
    // added type - an explicit else keeps that safe by default rather than by enumeration.
    throw new NotFoundError('Invite not found');
  }

  const invites = await db.invites.findAllByDocumentId(id);
  if (invites.length === 0) throw new NotFoundError('Invite not found');

  for (const invite of invites) {
    // Skip the write entirely for invites this cancel doesn't touch, so we don't churn
    // updatedAt (and needless writes) on every sibling invite for the document.
    let changed = false;

    // If email is provided, we need to remove it from the pending list
    if (email && invite.recipients?.pending) {
      const before = invite.recipients.pending.length;
      invite.recipients.pending = invite.recipients.pending.filter(p => p !== email);
      if (invite.recipients.pending.length < before) {
        // Clamped, not decremented. A named invite can carry a `remaining` larger than its
        // recipient count (the create body takes `available` at face value), and every gate that
        // treats an empty `pending` as "nobody named" leans on `remaining` reaching zero when the
        // last address goes - inviteVisibility's legacy inference, canViewInvite and acceptInvite.
        // Decrementing left slots behind, so cancelling the only named recipient on such a row
        // turned it into a redeemable share link. See inviteVisibility.ts's docblock.
        invite.remaining = Math.max(0, Math.min(invite.remaining - 1, invite.recipients.pending.length));
        changed = true;
      }
    } else if (invite.remaining !== 0) {
      invite.remaining = 0;
      changed = true;
    }

    if (changed) {
      await db.invites.update(invite);
    }
  }

  return invites;
};
