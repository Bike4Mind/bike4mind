// apps/client/pages/api/skills/market/by-token/[token].ts
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { SkillListing, type ISkillListingDocument } from '@bike4mind/database';
import { NotFoundError, type ISkillListing } from '@bike4mind/common';
import { buildListingDetail } from '@server/skillMarket/detail';

/** GET /api/skills/market/by-token/[token] - open an unlisted listing from its share link (signed-in only). */
const handler = baseApi().get<Request<{}, {}, {}, { token: string }>>(async (req, res) => {
  const token = String(req.query.token);
  // Shape check before the lookup so junk never reaches the query; real tokens are 32 base64url chars.
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new NotFoundError('Listing not found');
  const doc: ISkillListingDocument | null = await SkillListing.findOne({ shareToken: token, deletedAt: null });
  if (!doc) throw new NotFoundError('Listing not found');
  const listing = doc.toJSON() as unknown as ISkillListing;
  res.json(await buildListingDetail(listing, { id: req.user!.id, isAdmin: req.user!.isAdmin }, token));
});

export default handler;
