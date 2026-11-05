import { InviteEvents, InviteType, Permission } from '@bike4mind/common';
import {
  FabFile,
  Group,
  Session,
  withTransaction,
  fabFileRepository,
  sessionRepository,
  userRepository,
  organizationRepository,
  projectRepository,
  inviteRepository,
  Organization,
} from '@bike4mind/database';
import { sharingService } from '@bike4mind/services';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import { toSharerInviteViews } from '@server/managers/inviteManager';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { getInviteTypeName } from '@server/utils/mailer/inviteNotificationEmail';
import {
  MAX_INVITE_MESSAGE_LENGTH,
  MAX_INVITE_RECIPIENTS,
  notifyInvitees,
  reserveInviteSendBudget,
} from '@server/utils/inviteSendLimits';
import type { Request } from 'express';
import { z } from 'zod';

// Invite creation shared by POST /api/[type]/[id]/invites and POST /api/invites/batch.

type InviteRequest = Request<unknown, unknown, unknown, unknown, Record<string, unknown>>;

// z.enum(Permission) produces Permission[] so the service type is satisfied.
export const createInviteBodySchema = z.object({
  permissions: z.array(z.enum(Permission)),
  recipients: z.string().array().max(MAX_INVITE_RECIPIENTS).optional(),
  description: z.string().max(MAX_INVITE_MESSAGE_LENGTH).optional(),
  // null is the client's "no expiry" (hooks/data/invites.ts DataInput) -- map to undefined so
  // the service's 100-year prefault applies. z.coerce.date(null) would silently produce epoch.
  expiresAt: z.preprocess(
    v => (v === null ? undefined : v),
    z.coerce.date().min(new Date(), 'expiresAt must be in the future').optional()
  ),
  available: z.number().optional(),
});

export type CreateInviteBody = z.infer<typeof createInviteBodySchema>;

/**
 * The share URL. Addressed by the invite's bearer TOKEN, never its `_id`: the id is only partially
 * random and is disclosed by every surface that lists invites, so using it as the link secret let
 * anyone who saw one guess its neighbours. Falls back to the id for a legacy tokenless invite, which
 * `resolveRedeemableInvite` still admits until it expires.
 */
export const generateInviteLink = (invite: { id: string; token?: string }) => {
  return `${process.env.APP_URL}/share/${invite.token ?? invite.id}`;
};

// Audit-only lookup: a failure here must not fail an invite that is already committed.
const lookUpGroupOrganizationId = async (req: InviteRequest, groupId: string): Promise<string | undefined> => {
  try {
    return (await Group.findById(groupId))?.organizationId;
  } catch (error) {
    req.logger?.error('[ADMIN_AUDIT_GROUP_LOOKUP_FAILED]', { groupId, error });
    return undefined;
  }
};

const getDocumentName = async (type: InviteType, id: string): Promise<string> => {
  switch (type) {
    case InviteType.FabFile: {
      const file = await FabFile.findById(id);
      return file?.fileName || 'a file';
    }
    case InviteType.Session: {
      const session = await Session.findById(id);
      return session?.name || 'a notebook';
    }
    case InviteType.Organization: {
      const org = await Organization.findById(id);
      return org?.name || 'an organization';
    }
    case InviteType.Group: {
      const group = await Group.findById(id);
      return group?.name || 'a group';
    }
    default:
      return 'content';
  }
};

/**
 * Reserves the send budget, creates the invite (the service checks share access on the document),
 * logs and audits it, and emails pending recipients without awaiting delivery. Throws the budget's
 * TooManyRequestsError before anything is created; releases the reservation if creation throws.
 */
export async function createDocumentInvite(
  req: InviteRequest,
  { type, id, body }: { type: InviteType; id: string; body: CreateInviteBody }
) {
  const user = req.user!;
  const { expiresAt, ...restBody } = body;
  const budget = await reserveInviteSendBudget(user.id, restBody.recipients, {
    chargeTypedAddresses: type === InviteType.Organization,
  });
  const created = await withTransaction(() => {
    return sharingService.createInvite(
      user,
      // id and type come last so the route's resolved target wins over any body field.
      { ...restBody, ...(expiresAt !== undefined && { expiresAt }), id, type },
      {
        db: {
          invites: inviteRepository,
          users: userRepository,
          fabFiles: fabFileRepository,
          sessions: sessionRepository,
          projects: projectRepository,
          organizations: organizationRepository,
          groups: Group,
        },
      }
    );
  }).catch(async (error: unknown) => {
    await budget.release();
    throw error;
  });

  await logEvent(
    {
      userId: user.id,
      type: InviteEvents.CREATE_INVITE,
      metadata: { id: created.id, totalInvites: created.recipients?.pending?.length ?? 0 },
    },
    { ability: req.ability }
  );

  // Group invites carry a membership grant, so they get the same audit trail as the members
  // route's org.group_member.assigned entry. Best-effort, never fails the write.
  if (type === InviteType.Group) {
    const organizationId = await lookUpGroupOrganizationId(req, id);
    await recordAdminActionFromRequest(req, {
      action: 'org.invite.created',
      actorScope: 'organization',
      // Without a known organization the entry is kept, keyed by the group, rather than dropped.
      target: organizationId
        ? { kind: 'organization', id: organizationId, displayName: organizationId }
        : { kind: 'system', id, displayName: 'Group' },
      summary: 'created a group invite',
      details: {
        groupId: id,
        inviteId: created.id,
        recipientCount: created.recipients?.pending?.length ?? 0,
      },
    });
  }

  const pendingRecipients = created.recipients?.pending || [];
  if (pendingRecipients.length > 0) {
    const brand = process.env.APP_NAME || '';
    notifyInvitees({
      recipients: pendingRecipients,
      sharerName: user.name || user.username || `A${brand ? ` ${brand}` : ''} user`,
      sharerEmail: user.email || '',
      documentName: await getDocumentName(type, id),
      typeName: getInviteTypeName(type),
      inviteLink: generateInviteLink(created),
      message: restBody.description,
    }).catch(error => {
      req.logger?.error('Failed to send invite notification emails', { error, inviteId: created.id });
    });
  }

  const [view] = await toSharerInviteViews([created], user);
  return { ...view, link: generateInviteLink(created) };
}
