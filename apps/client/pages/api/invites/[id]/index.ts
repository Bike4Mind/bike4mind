// Get or cancel a particular invite
// GET/DELETE /api/invites/[id]

import {
  inviteRepository,
  fabFileRepository,
  sessionRepository,
  projectRepository,
  organizationRepository,
  Group,
} from '@bike4mind/database';
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

      // The share-link landing page reaches this with the invite's bearer TOKEN; a legacy link
      // still carries an `_id`. resolveRedeemableInvite admits the token always and the id only
      // while the invite has no token of its own, so a tokenized invite cannot be opened by
      // guessing ObjectIds around a real one.
      const invite = await sharingService.resolveRedeemableInvite(id, { db: { invites: inviteRepository } });
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
