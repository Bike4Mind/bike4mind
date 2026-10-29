import { z } from 'zod';
import { ApiKeyScope } from '@bike4mind/common';
import { userService } from '@bike4mind/services';
import { BadRequestError, ensureAdmin } from '@bike4mind/server-utils/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { buildHeldGrantAdapters, heldGrantBatches } from '@server/credits/heldSignupGrantAdapters';

const bodySchema = z.object({
  userIds: z
    .array(z.string().regex(/^[a-f0-9]{24}$/i))
    .min(1)
    .max(userService.MAX_BULK_RELEASE),
});

const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(csrfProtection())
  .post(
    asyncHandler(async (req, res) => {
      ensureAdmin(req.user?.isAdmin);
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success)
        throw new BadRequestError(`Expected 1 to ${userService.MAX_BULK_RELEASE} user ids in userIds`);
      const result = await userService.bulkReleaseHeldGrants(
        { actorId: req.user.id, userIds: parsed.data.userIds },
        { ...buildHeldGrantAdapters(req.logger), batches: heldGrantBatches }
      );
      res.status(200).json(result);
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
