import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { partnerSignupRuleRepository } from '@bike4mind/database';
import { createPartnerSignupRuleSchema } from '@bike4mind/common';
import { invalidatePartnerRuleCache } from '@server/entitlements/partnerRules';
import { z } from 'zod';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().optional(),
});

/** Turn a ZodError into a single readable message; rethrow anything else. */
function toBadRequest(error: unknown): never {
  if (error instanceof z.ZodError) {
    throw new BadRequestError(error.issues.map(e => `${e.path.join('.') || 'value'}: ${e.message}`).join('; '));
  }
  throw error;
}

const handler = baseApi()
  .get(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }
      let query: z.infer<typeof listQuerySchema>;
      try {
        query = listQuerySchema.parse(req.query);
      } catch (error) {
        toBadRequest(error);
      }
      const result = await partnerSignupRuleRepository.listRules(query);
      res.status(200).json(result);
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }
      let data: ReturnType<typeof createPartnerSignupRuleSchema.parse>;
      try {
        data = createPartnerSignupRuleSchema.parse(req.body);
      } catch (error) {
        toBadRequest(error);
      }

      // Fast, friendly duplicate check. This is a TOCTOU pre-check, not the guarantee - the
      // unique domain index is (see the create catch below).
      const existing = await partnerSignupRuleRepository.findByDomain(data.domain);
      if (existing) {
        throw new BadRequestError(`A signup rule for "${data.domain}" already exists`);
      }

      let created;
      try {
        created = await partnerSignupRuleRepository.create({
          ...data,
          createdBy: req.user.id,
        });
      } catch (error) {
        // Race backstop: a concurrent create for the same domain slips past the pre-check
        // and trips the unique index (Mongo code 11000). Surface it as a 400, not a 500.
        if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
          throw new BadRequestError(`A signup rule for "${data.domain}" already exists`);
        }
        throw error;
      }
      // New rule is live within the cache TTL; drop the cache so it applies immediately.
      invalidatePartnerRuleCache();

      res.status(201).json(created);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
