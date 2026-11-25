import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { NotFoundError } from '@bike4mind/utils';
import { grantPackageRepository, partnerSignupRuleRepository, registrationInviteRepository } from '@bike4mind/database';
import { ApiKeyScope, ForbiddenError } from '@bike4mind/common';

const GRANT_PACKAGE_LINKS_LIMIT = 50;

const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(
  asyncHandler(async (req, res) => {
    // Codes are redeemable secrets, so this matches the full-admin posture of the code list (referService/list.ts).
    if (!req.user?.isAdmin) throw new ForbiddenError('Permission denied');
    const { id } = req.query as { id?: unknown };
    if (typeof id !== 'string' || !/^[a-f0-9]{24}$/i.test(id)) throw new BadRequestError('Invalid package id');

    const pkg = await grantPackageRepository.findById(id);
    if (!pkg) throw new NotFoundError('Grant package not found');

    const [invites, partnerRules] = await Promise.all([
      registrationInviteRepository.listByGrantPackage(pkg.id, GRANT_PACKAGE_LINKS_LIMIT),
      partnerSignupRuleRepository.listByGrantPackage(pkg.id, GRANT_PACKAGE_LINKS_LIMIT),
    ]);
    res.status(200).json({ invites, partnerRules });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
