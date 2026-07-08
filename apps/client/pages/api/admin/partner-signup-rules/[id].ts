import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError, ensureAdmin } from '@server/utils/errors';
import { NotFoundError } from '@bike4mind/utils';
import { partnerSignupRuleRepository } from '@bike4mind/database';
import { updatePartnerSignupRuleSchema } from '@bike4mind/common';
import { invalidatePartnerRuleCache } from '@server/entitlements/partnerRules';
import { z } from 'zod';

interface RequestQuery {
  id: string;
}

const handler = baseApi()
  .put(
    asyncHandler(async (req, res) => {
      ensureAdmin(req.user?.isAdmin);
      const { id } = req.query as unknown as RequestQuery;
      if (!id) throw new BadRequestError('Rule id required');

      let data: ReturnType<typeof updatePartnerSignupRuleSchema.parse>;
      try {
        data = updatePartnerSignupRuleSchema.parse(req.body);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new BadRequestError(error.issues.map(e => `${e.path.join('.') || 'value'}: ${e.message}`).join('; '));
        }
        throw error;
      }

      const updated = await partnerSignupRuleRepository.update({ id, ...data });
      // Null => the row was deleted between check and write (or never existed). 404 rather
      // than a 200 with an empty body. update() is the single source of truth here, so no
      // separate findById pre-check is needed.
      if (!updated) throw new NotFoundError('Partner signup rule not found');

      // A conditions change (credits/entitlements/enabled) must apply now, not after the TTL.
      invalidatePartnerRuleCache();

      res.status(200).json(updated);
    })
  )
  .delete(
    asyncHandler(async (req, res) => {
      ensureAdmin(req.user?.isAdmin);
      const { id } = req.query as unknown as RequestQuery;
      if (!id) throw new BadRequestError('Rule id required');

      const existing = await partnerSignupRuleRepository.findById(id);
      if (!existing) throw new NotFoundError('Partner signup rule not found');

      // Hard delete: rules are config, not user data, and removing the row frees the
      // unique domain so the same partner can be re-added later without a revive path.
      await partnerSignupRuleRepository.delete(id);
      invalidatePartnerRuleCache();

      res.status(200).json({ success: true });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
