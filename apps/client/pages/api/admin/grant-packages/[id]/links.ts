import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { NotFoundError } from '@bike4mind/utils';
import { grantPackageRepository, registrationInviteRepository } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';

const GRANT_PACKAGE_LINKS_LIMIT = 50;

const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(
  asyncHandler(async (req, res) => {
    const { id } = req.query as { id?: unknown };
    if (typeof id !== 'string' || !/^[a-f0-9]{24}$/i.test(id)) throw new BadRequestError('Invalid package id');

    const pkg = await grantPackageRepository.findById(id);
    if (!pkg) throw new NotFoundError('Grant package not found');

    const invites = await registrationInviteRepository.listByGrantPackage(id, GRANT_PACKAGE_LINKS_LIMIT);
    // Partner rules join here once the package form edits them; the key ships now so the client shape is stable.
    res.status(200).json({ invites, partnerRules: { data: [], truncated: false } });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
