import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_WRITE_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeResearchService } from '@bike4mind/services';
import { withTransaction, dataLakeResearchConfigRepository, dataLakeRepository } from '@bike4mind/database';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { assertLakeResearchManage } from '@server/dataLakes/assertLakeResearchManage';
import { ResearchLeversInput, ResearchScheduleInput } from '@server/dataLakes/researchConfigInput';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';

const UpdateInput = ResearchLeversInput.merge(ResearchScheduleInput).extend({ name: z.string().optional() });

const db = { dataLakeResearchConfigs: dataLakeResearchConfigRepository, ...lakeConfigAuditDb };

/**
 * PUT    /api/data-lakes/:id/research/configs/:configId - edit a saved configuration (#1682).
 * DELETE /api/data-lakes/:id/research/configs/:configId - remove it.
 *
 * The lake from the path is resolved and manage-gated, then passed to the service, which scopes
 * every read and write to it. That pairing is what stops a caller who manages lake A from reaching
 * lake B's config by id - the repository filters on `dataLakeId`, not just on `_id`.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_WRITE_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .put(async (req: Request, res) => {
    const { id, configId } = req.query as { id: string; configId: string };
    // Resolved outside the transaction: it issues concurrent reads, which an ambient session rejects.
    const ctx = await toAccessContext(req);

    // The manage gate runs inside the transaction so a grant revoke committing mid-request collides
    // on the lake doc and the retry re-reads live grants.
    const updated = await withTransaction(async () => {
      const { lake, actor, grants } = await assertLakeResearchManage(req, id, ctx);
      const input = UpdateInput.parse(req.body);

      const result = await dataLakeResearchService.updateResearchConfig(configId, lake, actor, grants, input, {
        db,
        logger: req.logger,
      });
      // Serializes this write against a concurrent grant revoke - see WRITE-TIME RESIDUAL on `canManageLake`.
      await dataLakeRepository.touchIfStable(lake.id);
      return result;
    });
    return res.json({ data: updated });
  })
  .delete(async (req: Request, res) => {
    const { id, configId } = req.query as { id: string; configId: string };
    // Resolved outside the transaction: it issues concurrent reads, which an ambient session rejects.
    const ctx = await toAccessContext(req);

    await withTransaction(async () => {
      const { lake, actor, grants } = await assertLakeResearchManage(req, id, ctx);

      await dataLakeResearchService.deleteResearchConfig(configId, lake, actor, grants, { db, logger: req.logger });
      await dataLakeRepository.touchIfStable(lake.id);
    });
    return res.status(204).end();
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
