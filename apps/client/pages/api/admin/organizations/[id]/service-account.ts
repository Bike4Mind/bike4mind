import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { organizationRepository } from '@bike4mind/database';
import { findServiceAccount } from '@server/organizations/orgApiKeys';

/**
 * GET /api/admin/organizations/[id]/service-account - needs support:read.
 * The id of the user that holds the organization's org-owned API keys, or null when none has been
 * minted yet. Its admin profile (Keys tab) is where those keys are managed.
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'support:read' } }).get(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const organizationId = req.query.id;
    if (!organizationId) throw new BadRequestError('Organization id is required');

    const organization = await organizationRepository.findById(organizationId);
    if (!organization) throw new NotFoundError('Organization not found');

    const serviceAccount = await findServiceAccount(organization.id);
    res.status(200).json({ serviceAccountId: serviceAccount?.id ?? null });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
