// GET /api/organizations/domain-suggestions - orgs the caller may join through their verified email domain
// Returns ids and names only; an unverified email gets an empty list.

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { listOrgDomainJoinSuggestions } from '@server/organizations/orgDomainClaims';

const handler = baseApi({ auth: 'jwtOnly' }).get(
  asyncHandler(async (req, res) => {
    const suggestions = await listOrgDomainJoinSuggestions(req.user!.id);
    return res.status(200).json({ suggestions });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
