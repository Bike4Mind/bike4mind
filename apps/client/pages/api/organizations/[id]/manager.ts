import { organizationService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { organizationRepository } from '@bike4mind/database/infra';
import { userRepository } from '@bike4mind/database/auth';
import { z } from 'zod';

const assignManagerSchema = z.object({
  managerId: z.string(),
});

/**
 * POST /api/organizations/[id]/manager - Assign or update manager
 * DELETE /api/organizations/[id]/manager - Remove manager
 */
const handler = baseApi()
  .post(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const orgId = req.query.id;
      if (!orgId) throw new BadRequestError('Organization ID is required');

      const validatedBody = assignManagerSchema.parse(req.body);

      const organization = await organizationRepository.findById(orgId);
      if (!organization) throw new NotFoundError('Organization not found');

      const isOwner = organization.userId === req.user?.id;
      const isAdmin = req.user?.isAdmin;

      if (!isOwner && !isAdmin) {
        throw new ForbiddenError('Only the billing owner or admin can assign a manager');
      }

      await organizationService.assignManager(
        { organizationId: orgId, managerId: validatedBody.managerId },
        { db: { organizations: organizationRepository, users: userRepository } }
      );

      return res.status(200).json({ message: 'Manager assigned successfully' });
    })
  )
  .delete(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const orgId = req.query.id;
      if (!orgId) throw new BadRequestError('Organization ID is required');

      const organization = await organizationRepository.findById(orgId);
      if (!organization) throw new NotFoundError('Organization not found');

      const isOwner = organization.userId === req.user?.id;
      const isAdmin = req.user?.isAdmin;

      if (!isOwner && !isAdmin) {
        throw new ForbiddenError('Only the billing owner or admin can remove a manager');
      }

      await organizationService.removeManager(
        { organizationId: orgId },
        { db: { organizations: organizationRepository } }
      );

      return res.status(200).json({ message: 'Manager removed successfully' });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
