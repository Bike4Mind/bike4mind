import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import {
  adminSettingsRepository,
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  usageEventRepository,
} from '@bike4mind/database';
import type { IDataLakeSpendResponse } from '@bike4mind/common';
import { ForbiddenError } from '@server/utils/errors';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

const QuerySchema = z.object({
  // Clamped so a stray value can't turn this into a full-collection ledger scan.
  days: z.coerce.number().int().min(1).max(365).optional(),
});

/**
 * GET /api/data-lakes/:id/spend?days=30
 * Cost attribution + owner-facing spend view for one data lake (#1677). Access-gated first
 * (not-found-style denial via assertLakeAccess), then the stricter manage check - owner/
 * curator/org-admin, via canManageLake - so a mere reader gets a 403, not the financial
 * telemetry. Same authority `redactLakeForActor` already uses to decide whether
 * `embeddingSpendMicroUsd` is withheld from the lake's own payload, kept as the single
 * source of truth rather than a second hand-rolled check.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    const { id } = req.query;
    const { days = 30 } = QuerySchema.parse(req.query);
    const ctx = await toAccessContext(req);

    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });

    const canView = await dataLakeService.resolveCanManageLake(lake, ctx, {
      db: { dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    if (!canView) {
      throw new ForbiddenError("You do not have access to this data lake's spend");
    }

    const [levers, ledger] = await Promise.all([
      dataLakeService.resolveSpendLevers({ adminSettings: adminSettingsRepository }, req.logger),
      usageEventRepository.lakeUsageSummary(lake.id, days),
    ]);

    const response: IDataLakeSpendResponse = {
      dataLakeId: lake.id,
      days,
      embeddingSpendMicroUsd: lake.embeddingSpendMicroUsd ?? null,
      spendEnabled: levers.spendEnabled,
      perRunBudgetMicroUsd: levers.perRunBudgetMicroUsd,
      perLakeBudgetMicroUsd: levers.perLakeBudgetMicroUsd,
      perPeriodBudgetMicroUsd: levers.perPeriodBudgetMicroUsd,
      periodHours: levers.periodHours,
      ledger,
    };

    return res.json(response);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
