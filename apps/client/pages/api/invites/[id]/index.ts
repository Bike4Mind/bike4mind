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
import { getInviteDetails } from '@server/managers/inviteManager';
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

      const invite = await Invite.findById(id);
      if (!invite) {
        return res.status(404).json({ message: 'Invite Not Found' });
      }

      return res.json(await getInviteDetails(invite, true));
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
