import { outboundActionGate } from '@server/auth/assertOutboundActionAllowed';
import { InviteEvents, InviteType } from '@bike4mind/common';
import { createDocumentInvite, createInviteBodySchema } from '@server/managers/createDocumentInvite';
import { toSharerInviteViews } from '@server/managers/inviteManager';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  Group,
  fabFileRepository,
  sessionRepository,
  userRepository,
  organizationRepository,
  projectRepository,
  inviteRepository,
} from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { resolveInviteType } from '@server/utils/inviteRouteType';
import { z } from 'zod';
import { sharingService } from '@bike4mind/services';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';

interface IParams {
  type?: string;
  id?: string;
}

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
    outboundActionGate(),
    asyncHandler<{}, unknown, z.infer<typeof createInviteBodySchema>, IParams>(async (req, res) => {
      const { type: urlPathType, id } = req.query;
      if (!urlPathType || !id) {
        return res.status(400).json({ message: 'Invalid invite request' });
      }
      const inviteType = resolveInviteType(urlPathType);
      if (!inviteType) throw new BadRequestError('Invalid type');
      // Project invites have their own route (pages/api/projects/[id]/invites.ts), which shadows the
      // `projects` alias here. Only the raw `Project` value reaches this handler, and creating one
      // here would skip that route's API-key scope checks and its typed-address budget.
      if (inviteType === InviteType.Project) {
        throw new BadRequestError('Create project invites at /api/projects/:id/invites');
      }
      if (!isValidObjectId(id)) throw new NotFoundError('Document not found');

      const body = createInviteBodySchema.parse(req.body);
      return res.json(await createDocumentInvite(req, { type: inviteType, id, body }));
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

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
