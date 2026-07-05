import { addUserToOrganization } from '@server/managers/organizationManager';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import { z } from 'zod';

const addUserToOrganizationSchema = z.object({
  userId: z.string(),
});

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const orgId = req.query.id;
    const validatedBody = addUserToOrganizationSchema.parse(req.body);
    if (!orgId) throw new BadRequestError('Organization ID is required');

    await addUserToOrganization({
      organizationId: orgId,
      userId: validatedBody.userId,
    });
    return res.status(200).json({ message: 'User added to organization successfully' });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
