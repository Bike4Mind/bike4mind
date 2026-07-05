// List all invites associated with a user
// GET /api/invites

import { IGroupDocument, InviteType, IShareableDocument } from '@bike4mind/common';
import { FabFile, Group, Invite, Organization, Project } from '@bike4mind/database';
import { Session } from '@bike4mind/database/auth';
import { getInviteDetails } from '@server/managers/inviteManager';
import { cancelInvite } from '@server/managers/sharingManager';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@server/utils/errors';

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
   * Delete a particular invite
   */
  .delete(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const id = req.query.id;

      if (!id) {
        return res.status(400).json({ message: 'Invalid delete invite request' });
      }

      const invite = await Invite.findById(id);
      if (!invite) {
        return res.status(404).json({ message: 'Invite not found' });
      }
      const { type, documentId } = invite;

      let doc: IGroupDocument | IShareableDocument | null = null;
      switch (type) {
        case InviteType.FabFile:
          doc = await FabFile.findById(documentId);
          break;
        case InviteType.Session:
          doc = await Session.findById(documentId);
          break;
        case InviteType.Organization:
          doc = await Organization.findById(documentId);
          break;
        case InviteType.Group:
          doc = await Group.findById(documentId);
          break;
        case InviteType.Project:
          doc = await Project.findById(documentId);
          break;
        default:
          break;
      }

      if (!doc) {
        throw new NotFoundError(`${type} not found`);
      }

      const updatedInvite = await cancelInvite(doc, id, req.ability!);
      if (!updatedInvite) {
        return res.status(404).json({ message: 'Invite not found' });
      }

      return res.json(updatedInvite);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
