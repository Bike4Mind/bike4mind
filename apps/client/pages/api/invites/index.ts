// List the caller's own pending invites
// GET /api/invites

import { baseApi } from '@server/middlewares/baseApi';
import { inviteRepository } from '@bike4mind/database';
import { sharingService } from '@bike4mind/services';
import { z } from 'zod';

// The pre-consolidation CASL path returned every pending invite with no pagination, so
// default `limit` to the service's own 1000 ceiling to preserve that "return all" wire
// contract for external clients (no silent truncation). Pagination stays opt-in via query.
const paginationSchema = z.object({
  limit: z.coerce.number().min(1).max(1000).prefault(1000),
  page: z.coerce.number().min(1).prefault(1),
});

const handler = baseApi().get(async (req, res) => {
  const { limit, page } = paginationSchema.parse(req.query);

  // listOwnPendingInvites is scoped to the caller's own pending invites (matched by
  // their stored email/userId) and returns { data, total }. This endpoint has no
  // in-app consumer (the inbox uses /api/users/:id/userInvites); unwrap to the raw
  // array to preserve the external wire shape.
  const result = await sharingService.listOwnPendingInvites(
    req.user,
    { limit, page },
    { db: { invites: inviteRepository } }
  );

  return res.json(result.data);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
