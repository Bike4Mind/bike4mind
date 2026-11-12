import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { openListingByShareToken } from '@server/skillMarket/shareToken';

/**
 * GET /api/skills/market/by-token/[token] - DEPRECATED: the token-in-path shape for desktop builds that predate
 * `GET /api/skills/market/by-token` with the `x-share-token` header. Remove after one desktop release.
 */
const handler = baseApi({ auth: 'jwtOnly' }).get<Request<{}, {}, {}, { token: string }>>(async (req, res) => {
  res.json(await openListingByShareToken(String(req.query.token), { id: req.user!.id, isAdmin: req.user!.isAdmin }));
});

export default handler;
