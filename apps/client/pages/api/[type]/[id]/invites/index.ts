import { InviteEvents, InviteType, Permission } from '@bike4mind/common';
import { toSharerInviteViews } from '@server/managers/inviteManager';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  FabFile,
  Group,
  Session,
  withTransaction,
  Project,
  fabFileRepository,
  sessionRepository,
  userRepository,
  organizationRepository,
  projectRepository,
  inviteRepository,
  Organization,
} from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { isValidObjectId } from '@server/utils/objectId';
import { resolveInviteType } from '@server/utils/inviteRouteType';
import { z } from 'zod';
import { sharingService } from '@bike4mind/services';
import { logEvent } from '@server/utils/analyticsLog';
import { AdminOrgAuditEvents, logAuditEvent } from '@server/utils/auditLog';
import { ProjectEvents } from '@bike4mind/common';
import { getInviteTypeName, sendInviteNotificationEmails } from '@server/utils/mailer/inviteNotificationEmail';

interface IParams {
  type?: string;
  id?: string;
}

// z.enum(Permission) produces Permission[] so the service type is satisfied.
const createInviteBodySchema = z.object({
  permissions: z.array(z.enum(Permission)),
  recipients: z.string().array().optional(),
  description: z.string().optional(),
  // null is the client's "no expiry" (hooks/data/invites.ts DataInput) -- map to undefined so
  // the service's 100-year prefault applies. z.coerce.date(null) would silently produce epoch.
  expiresAt: z.preprocess(
    v => (v === null ? undefined : v),
    z.coerce.date().min(new Date(), 'expiresAt must be in the future').optional()
  ),
  available: z.number().optional(),
});

const handler = baseApi()
  /**
   * GET /api/:type/invites/:id - Retrieves all pending invitations for a document
   */
  .get(
    asyncHandler<{}, unknown, unknown, IParams>(async (req, res) => {
      const type: string | undefined = req.query.type;
      const id: string | undefined = req.query.id;

      if (!id) {
        return res.status(400).json({ message: 'Invalid get invite request' });
      }
      const inviteType = resolveInviteType(type);
      if (!inviteType) {
        return res.status(400).json({ message: 'Invalid type' });
      }
      // An id that is not an ObjectId names no document, so this route answers the 404 itself
      // rather than letting the lookup cast and raise a CastError. After the type check, so a
      // bad type still reports the bad type.
      if (!isValidObjectId(id)) throw new NotFoundError('Document not found');

      // Share-scoped: the service authorizes via the document's share access
      // (owner, a users[]-with-share grant, or a groups[]-with-share grant),
      // replacing the app-level CASL check.
      const shares = await sharingService.listInvitesForDocument(
        req.user,
        { documentId: id, type: inviteType },
        {
          db: {
            invites: inviteRepository,
            fabFiles: fabFileRepository,
            sessions: sessionRepository,
            projects: projectRepository,
            organizations: organizationRepository,
            groups: Group,
          },
        }
      );
      // Sharer-facing, and the bearer token has no consumer here: the create response is what hands
      // back a link. Leaving it in would put a redeemable secret in a list any share-authorized
      // caller can re-read at will. Recipient addresses the caller did not type are withheld too.
      return res.json(await toSharerInviteViews(shares, req.user));
    })
  )
  /**
   * POST /api/:type/:id/invites
   * - Creates a new invitation.  If one or more email addresses given, will also send email(s) to the given addresses.
   */
  .post(
    asyncHandler<{}, unknown, z.infer<typeof createInviteBodySchema>, IParams>(async (req, res) => {
      const { type: urlPathType, id } = req.query;
      if (!urlPathType || !id) {
        return res.status(400).json({ message: 'Invalid invite request' });
      }
      const inviteType = resolveInviteType(urlPathType);
      if (!inviteType) throw new BadRequestError('Invalid type');
      if (!isValidObjectId(id)) throw new NotFoundError('Document not found');

      const { expiresAt, ...restBody } = createInviteBodySchema.parse(req.body);
      const created = await withTransaction(() => {
        return sharingService.createInvite(
          req.user,
          // id and type come last so path params are always authoritative over any body field.
          { ...restBody, ...(expiresAt !== undefined && { expiresAt }), id, type: inviteType },
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
      });

      // Log invite creation event
      await logEvent(
        {
          userId: req.user.id,
          type: InviteEvents.CREATE_INVITE,
          metadata: { id: created.id, totalInvites: created.recipients?.pending?.length ?? 0 },
        },
        { ability: req.ability }
      );

      // Group invites carry a membership grant, so they get the same audit trail as the members
      // route's ORG_GROUP_MEMBER_ASSIGNED. Best-effort, never fails the write.
      if (inviteType === InviteType.Group) {
        await logAuditEvent(
          {
            userId: req.user.id,
            action: AdminOrgAuditEvents.ORG_GROUP_INVITE_CREATED,
            ip: req.ip,
            userAgent: req.headers['user-agent'] || 'unknown',
            metadata: {
              groupId: id,
              inviteId: created.id,
              recipientCount: created.recipients?.pending?.length ?? 0,
            },
          },
          req.logger
        );
      }

      // If this is a project invite, also log ADD_MEMBER event
      if (inviteType === InviteType.Project) {
        const project = await Project.findById(id);
        if (project) {
          await Promise.all(
            (created.recipients?.pending || []).map(async (recipientId: string) =>
              logEvent(
                {
                  userId: req.user.id,
                  type: ProjectEvents.ADD_MEMBER,
                  metadata: {
                    projectId: id,
                    projectName: project.name,
                    memberId: recipientId,
                    memberRole: (restBody.permissions || []).join(','),
                  },
                },
                { ability: req.ability }
              )
            )
          );
        }
      }

      // Send email notifications to recipients
      const pendingRecipients = created.recipients?.pending || [];
      if (pendingRecipients.length > 0) {
        const inviteLink = generateInviteLink(created);
        const documentName = await getDocumentName(inviteType, id);
        const typeName = getInviteTypeName(inviteType);
        const brand = process.env.APP_NAME || '';
        const sharerName = req.user.name || req.user.username || `A${brand ? ` ${brand}` : ''} user`;
        const sharerEmail = req.user.email || '';

        // Send notifications asynchronously - don't block the response
        sendInviteNotificationEmails(
          pendingRecipients,
          sharerName,
          sharerEmail,
          documentName,
          typeName,
          inviteLink,
          restBody.description
        ).catch(error => {
          req.logger?.error('Failed to send invite notification emails', { error, inviteId: created.id });
        });
      }

      const [view] = await toSharerInviteViews([created], req.user);
      return res.json({ ...view, link: generateInviteLink(created) });
    })
  )
  /**
   * DELETE /api/:type/:id/invites
   *
   * Cancel any open invites for a document
   */
  .delete(
    asyncHandler<{}, unknown, unknown, IParams>(async (req, res) => {
      // Take the document identity from the path and only `email` from the body. Spreading the
      // whole body last let a caller override type and id, so the request's target was not the
      // one in the URL. Callers of this verb have historically sent the InviteType value itself
      // (`/api/${InviteType}/...`); resolveInviteType keeps that working alongside the alias.
      const { type, id } = req.query;
      if (!id) throw new BadRequestError('Invalid cancel invite request');
      const inviteType = resolveInviteType(type);
      if (!inviteType) throw new BadRequestError('Invalid cancel invite request');
      if (!isValidObjectId(id)) throw new NotFoundError('Document not found');
      const { email, userId } = (req.body ?? {}) as { email?: string; userId?: string };

      const invites = await sharingService.cancelInvite(
        req.user,
        { type: inviteType, id, email, userId },
        {
          db: {
            invites: inviteRepository,
            users: userRepository,
            fabFiles: fabFileRepository,
            sessions: sessionRepository,
            organizations: organizationRepository,
            projects: projectRepository,
            groups: Group,
          },
        }
      );

      await logEvent(
        {
          userId: req.user.id,
          type: InviteEvents.DELETE_INVITE,
          metadata: { documentId: invites[0].documentId, documentType: invites[0].type },
        },
        { ability: req.ability }
      );

      return res.json(await toSharerInviteViews(invites, req.user));
    })
  );

/**
 * The share URL. Addressed by the invite's bearer TOKEN, never its `_id`: the id is only partially
 * random and is disclosed by every surface that lists invites, so using it as the link secret let
 * anyone who saw one guess its neighbours. Falls back to the id for a legacy tokenless invite, which
 * `resolveRedeemableInvite` still admits until it expires.
 */
export const generateInviteLink = (invite: { id: string; token?: string }) => {
  return `${process.env.APP_URL}/share/${invite.token ?? invite.id}`;
};

// Helper to get document name for email
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
    case InviteType.Project: {
      const project = await Project.findById(id);
      return project?.name || 'a project';
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

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
