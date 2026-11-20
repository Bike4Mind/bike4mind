import { withTransaction } from '@bike4mind/database';
import { spendFreezeService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import {
  assertScopeExists,
  buildSpendFreezeAdapters,
  buildSpendFreezeChange,
  parseReason,
  parseScope,
} from '@server/utils/spendFreezeAdmin';

// Lifts the active spend freeze for a scope; a scope with no active freeze returns lifted: false.
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'credits:adjust' } })
  .use(csrfProtection())
  .post(
    asyncHandler(async (req, res) => {
      const scope = parseScope(req.body);
      const reason = parseReason(req.body);

      const result = await withTransaction(async () => {
        await assertScopeExists(req.user, scope, { mustExist: false });
        return spendFreezeService.unfreezeSpend(
          { scope, ...(await buildSpendFreezeChange(req, reason)) },
          buildSpendFreezeAdapters(req.logger)
        );
      });

      if (result.lifted) {
        req.logger.info(`Admin ${req.user.id} lifted the spend freeze for ${scope.scopeType} ${scope.scopeId}`);
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
