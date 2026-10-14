// apps/client/pages/api/skills/market/recommended.ts
import { baseApi } from '@client/server/middlewares/baseApi';
import { memberOrgIdsFor } from '@server/skillMarket/market';
import { recommendListings } from '@server/skillMarket/search';

/** GET /api/skills/market/recommended - the "Recommended for you" rail, each item with a reason. */
const handler = baseApi().get(async (req, res) => {
  const userId = req.user!.id;
  res.json({ data: await recommendListings(userId, await memberOrgIdsFor(userId)) });
});

export default handler;
