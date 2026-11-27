// GET /api/spaces/domain-suggestions - Spaces the caller may join through their verified email domain
// Returns ids and names only; an unverified email gets an empty list.
import { spaceRepository, userRepository } from '@bike4mind/database';
import { spaceService } from '@bike4mind/services';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { joinableSpaceIdsForEmail } from '@server/organizations/orgDomainClaims';

const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireFeatureEnabled('EnableSpaces'))
  .get(
    asyncHandler(async (req, res) => {
      const user = await userRepository.findById(req.user!.id);
      const suggestions = user
        ? await spaceService.listDomainSuggestions(user, {
            db: { spaces: spaceRepository },
            joinableSpaceIdsForEmail,
          })
        : [];
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({ suggestions });
    })
  );

export default handler;
