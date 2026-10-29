import { z } from 'zod';
import { ApiKeyScope } from '@bike4mind/common';
import { creditTransactionRepository, userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { BadRequestError, NotFoundError, ensureAdmin } from '@bike4mind/server-utils/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { heldGrantBatches } from '@server/credits/heldSignupGrantAdapters';

const bodySchema = z.object({ batchId: z.string().regex(/^[a-f0-9]{24}$/i) });

const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(csrfProtection())
  .post(
    asyncHandler(async (req, res) => {
      ensureAdmin(req.user?.isAdmin);
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError('Expected a batchId');
      const result = await userService.undoHeldGrantRelease(
        { batchId: parsed.data.batchId, actorId: req.user.id },
        { batches: heldGrantBatches, users: userRepository, creditTransactions: creditTransactionRepository }
      );
      if (!result) throw new NotFoundError('Release batch not found');
      res.status(200).json(result);
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
