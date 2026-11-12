import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { NotFoundError } from '@bike4mind/common';
import { openListingByShareToken, readShareTokenHeader } from '@server/skillMarket/shareToken';

/** GET /api/skills/market/by-token - open an unlisted listing from its share token in `x-share-token` (signed-in only). */
const handler = baseApi({ auth: 'jwtOnly' }).get<Request>(async (req, res) => {
  const token = readShareTokenHeader(req.headers);
  if (!token) throw new NotFoundError('Listing not found');
  res.json(await openListingByShareToken(token, { id: req.user!.id, isAdmin: req.user!.isAdmin }));
});

export default handler;
