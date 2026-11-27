import { z } from 'zod';
import { BadRequestError, SPEND_FREEZE_SCOPE_TYPES } from '@bike4mind/common';
import { spendFreezeService } from '@bike4mind/services';
import { withTransaction } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import {
  assertScopeExists,
  buildSpendFreezeAdapters,
  buildSpendFreezeChange,
  labelFreezes,
  labelKey,
  parseReason,
  parseScope,
} from '@server/utils/spendFreezeAdmin';

const MAX_LIMIT = 200;

const listQuerySchema = z.object({
  scopeType: z.enum(SPEND_FREEZE_SCOPE_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  cursor: z.string().min(1).optional(),
});

// GET lists active freezes; POST freezes spend for a user, organization or API key (idempotent).
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'support:read', POST: 'credits:adjust' } })
  .use(csrfProtection())
  .get(
    asyncHandler(async (req, res) => {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid query');

      const adapters = buildSpendFreezeAdapters(req.logger);
      const { items, nextCursor } = await spendFreezeService.listActiveFreezes(parsed.data, adapters);
      const labels = await labelFreezes(items);

      return res.json({
        items: items.map(freeze => ({ ...freeze, label: labels.get(labelKey(freeze)) ?? null })),
        nextCursor,
      });
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const scope = parseScope(req.body);
      const reason = parseReason(req.body);

      const result = await withTransaction(async () => {
        await assertScopeExists(req.user, scope);
        return spendFreezeService.freezeSpend(
          { scope, ...(await buildSpendFreezeChange(req, reason)) },
          buildSpendFreezeAdapters(req.logger)
        );
      });

      if (result.created) {
        req.logger.info(`Admin ${req.user.id} froze spend for ${scope.scopeType} ${scope.scopeId}`);
      }
      return res.json(result);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
