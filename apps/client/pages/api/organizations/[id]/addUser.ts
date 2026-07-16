import { organizationService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { organizationRepository } from '@bike4mind/database/infra';
import { userRepository } from '@bike4mind/database/auth';
import { withTransaction } from '@bike4mind/database';
import { z } from 'zod';

const addUserToOrganizationSchema = z.object({
  userId: z.string(),
});

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const orgId = req.query.id;
    if (!orgId) throw new BadRequestError('Organization ID is required');

    const validatedBody = addUserToOrganizationSchema.parse(req.body);

    const organization = await organizationRepository.findById(orgId);
    if (!organization) throw new NotFoundError('Organization not found');

    const isOwner = organization.userId === req.user?.id;
    const isAdmin = req.user?.isAdmin;
    if (!isOwner && !isAdmin) {
      throw new ForbiddenError('Only the billing owner or admin can add a user to the organization');
    }

    await withTransaction(() =>
      organizationService.addMember(
        req.user,
        { organizationId: orgId, userId: validatedBody.userId },
        { db: { organizations: organizationRepository, users: userRepository }, logger: req.logger }
      )
    );

    return res.status(200).json({ message: 'User added to organization successfully' });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
