// apps/client/pages/api/skills/market/[id]/permanent.ts
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { deleteOwnWithdrawnListing } from '@server/skillMarket/author';

const handler = baseApi({ auth: 'jwtOnly' })
  /** DELETE /api/skills/market/[id]/permanent - the author deletes a withdrawn listing for good. */
  .delete<Request<{}, {}, {}, { id: string }>>(async (req, res) => {
    await deleteOwnWithdrawnListing(req.user!.id, String(req.query.id));
    res.status(204).end();
  });

export default handler;
