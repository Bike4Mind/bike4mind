// Accept or refuse several invites in one request
// POST /api/invites/bulk

import { BadRequestError, MAX_BULK_ITEMS } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { filterInviteRecipientsToSelf } from '@server/managers/inviteManager';
import { acceptInviteForUser, notifyInvitesRefetch, refuseInviteForUser } from '@server/managers/inviteResponses';
import { z } from 'zod';

// A share link carries either a legacy ObjectId or a base64url bearer token (see common inviteToken.ts).
const INVITE_KEY_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

const BulkInviteBodySchema = z.object({
  action: z.enum(['accept', 'refuse']),
  ids: z
    .array(z.string().regex(INVITE_KEY_SHAPE, 'Invalid invite id'))
    .min(1, 'Provide at least one invite id')
    .max(MAX_BULK_ITEMS, `At most ${MAX_BULK_ITEMS} invite ids`),
});

type BulkInviteResult = { id: string; ok: boolean; type?: string; invite?: Record<string, unknown>; error?: string };
type BulkInviteResponse = { results: BulkInviteResult[]; okCount: number };

// A client-facing HTTP error carries a message the single-invite routes already return; anything
// else stays generic so internal failure detail does not reach the caller.
const toItemError = (error: unknown, fallback: string) => {
  const status = (error as { statusCode?: unknown })?.statusCode;
  return typeof status === 'number' && status < 500 && error instanceof Error ? error.message : fallback;
};

const handler = baseApi().post(
  asyncHandler<{}, BulkInviteResponse, unknown>(async (req, res) => {
    const parsed = BulkInviteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues[0]?.message || 'Invalid request body');
    }
    const { action } = parsed.data;
    const ids = [...new Set(parsed.data.ids)];
    const user = req.user!;

    // Sequential, one transaction per invite inside the helpers: one failure never rolls back the rest.
    const results: BulkInviteResult[] = [];
    for (const id of ids) {
      try {
        const invite = action === 'accept' ? await acceptInviteForUser(req, id) : await refuseInviteForUser(req, id);
        if (!invite) {
          results.push({ id, ok: false, error: 'Invite not found' });
          continue;
        }
        results.push({ id, ok: true, type: invite.type, invite: filterInviteRecipientsToSelf(invite, user.email) });
      } catch (error) {
        req.logger.warn('[invites/bulk] invite response failed', { inviteId: id, action, error });
        results.push({ id, ok: false, error: toItemError(error, `Could not ${action} invite`) });
      }
    }

    const okCount = results.filter(r => r.ok).length;
    // The writes above are committed; a failed refetch must not turn them into an error the client retries.
    if (okCount > 0) {
      try {
        await notifyInvitesRefetch(user.id, action === 'accept' ? 'Accepted invites' : 'Refused invites');
      } catch (error) {
        req.logger.warn('[invites/bulk] invites refetch notification failed', { action, error });
      }
    }

    return res.json({ results, okCount });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
