// POST /api/spaces/:id/domain-join - join a Space through the caller's verified email domain, as a plain member.
// 403 unverified email, non-granting domain, removed or full; 409 already a member.
import { adminSettingsRepository, spaceRepository, userRepository, withTransaction } from '@bike4mind/database';
import { spaceService } from '@bike4mind/services';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { isDomainJoinable } from '@server/organizations/orgDomainClaims';

const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireFeatureEnabled('EnableSpaces'))
  .post(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      // Re-read rather than trust the session copy, which may predate email verification.
      const user = await userRepository.findById(req.user!.id);
      if (!user) throw new NotFoundError('User not found');
      const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, { names: ['SpaceMaxMembers'] });
      const spaceMaxMembers = getSettingsValue('SpaceMaxMembers', settings) ?? 1000;
      await withTransaction(() =>
        spaceService.joinViaDomain(
          user,
          { spaceId: req.query.id ?? '' },
          { db: { spaces: spaceRepository }, limits: { spaceMaxMembers }, isDomainJoinable }
        )
      );
      res.status(204).end();
    })
  );

export default handler;
