// GET /api/:type/:id - Retrieves a single invitation by its redemption key

import { inviteRepository } from '@bike4mind/database';
import { sharingService } from '@bike4mind/services';
import { canViewInvite, getInviteDetails, filterInviteRecipientsToSelf } from '@server/managers/inviteManager';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { resolveInviteType } from '@server/utils/inviteRouteType';
import { Request, Response } from 'express';
import unmatchedApiPathHandler from '../../[...unmatchedApiPath]';

interface IParams {
  type?: string;
  id?: string;
}

const inviteHandler = baseApi().get(
  asyncHandler<{}, unknown, unknown, IParams>(async (req, res) => {
    // Response depends on who asks, so a shared CDN cache must never store it.
    res.setHeader('Cache-Control', 'private, no-store');

    const id = req.query.id;

    if (!id) {
      return res.status(400).json({ message: 'Invite Share request' });
    }

    // Same door as the sibling at pages/api/invites/[id], and for the same reason: this route reads
    // an invite from a redemption key, so a tokenized LINK invite must not be openable by guessing
    // ObjectIds around a real one. The shape check the resolver applies replaces the isValidObjectId
    // guard that used to live here, which would have rejected every bearer token outright.
    const invite = await sharingService.resolveRedeemableInvite(id, { db: { invites: inviteRepository } });
    // Strangers and bad ids get the same 404 so ids cannot be probed; an expired invite returns
    // 410 only to callers who could otherwise view it (see canViewInvite).
    if (!invite) {
      return res.status(404).json({ message: 'Invite Not Found' });
    }
    const access = await canViewInvite(req.user, invite);
    if (access === 'expired') {
      return res.status(410).json({ message: 'Invite has expired' });
    }
    if (access !== 'allowed') {
      return res.status(404).json({ message: 'Invite Not Found' });
    }

    // Invitee-facing view: strip other recipients' addresses, keep the caller's own. Matches the
    // sibling at pages/api/invites/[id] and the other invitee-facing routes; passing the gate above
    // means the caller is one named recipient, not that they may read the whole recipient list.
    const details = await getInviteDetails(invite, true);
    return res.json(filterInviteRecipientsToSelf(details, req.user.email));
  })
);

// This route outranks pages/api/[...unmatchedApiPath] for every two-segment /api/* path, so a type
// segment that names no invite type is a miss and goes to the catch-all on any method, before
// baseApi: an unknown path must not cost auth, a DB connect or API-key quota.
const handler = (req: Request, res: Response) => {
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;
  return resolveInviteType(type) ? inviteHandler(req, res) : unmatchedApiPathHandler(req, res);
};

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
