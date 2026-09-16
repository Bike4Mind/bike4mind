// Get or cancel a particular invite
// GET/DELETE /api/invites/[id]

import {
  Invite,
  inviteRepository,
  fabFileRepository,
  sessionRepository,
  projectRepository,
  organizationRepository,
  Group,
} from '@bike4mind/database';
import { isValidObjectId } from '@server/utils/objectId';
import { canViewInvite, getInviteDetails, filterInviteRecipientsToSelf } from '@server/managers/inviteManager';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { sharingService } from '@bike4mind/services';

const handler = baseApi()
  /**
   * Get a particular invite
   */
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const id = req.query.id;

      if (!id) {
        return res.status(400).json({ message: 'Invite Share request' });
      }

      // Validated before findById, which would otherwise take a malformed id as a cast error
      // rather than the 404 the rest of this handler is careful to return.
      const invite = isValidObjectId(id) ? await Invite.findById(id) : null;
      // A caller who is not a named recipient or share-authorized gets the same 404 as a missing
      // or malformed id: a 403 would confirm the id exists, and splitting 400 from 404 between
      // malformed and valid-but-unauthorized is the same class of signal.
      if (!invite || !(await canViewInvite(req.user, invite))) {
        return res.status(404).json({ message: 'Invite Not Found' });
      }

      // Invitee-facing view: strip other recipients' emails, keep the caller's own.
      const details = await getInviteDetails(invite, true);
      return res.json(filterInviteRecipientsToSelf(details, req.user.email));
    })
  )
  /**
   * Delete (cancel) a particular invite by its invite id. Share-scoped auth lives
   * in the service, which loads the invite, resolves its document, and checks the
   * caller's share access before cancelling.
   */
  .delete(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const id = req.query.id;

      if (!id) {
        return res.status(400).json({ message: 'Invalid delete invite request' });
      }

      const updatedInvite = await sharingService.cancelInviteById(
        req.user,
        { id },
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

      return res.json(updatedInvite);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
