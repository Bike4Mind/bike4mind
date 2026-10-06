import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES, assertDataLakeWriteScope } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeResearchService } from '@bike4mind/services';
import {
  withTransaction,
  dataLakeProposalRepository,
  dataLakeResearchConfigRepository,
  dataLakeRepository,
} from '@bike4mind/database';
import { Request } from 'express';
import { RESEARCH_RUN_TRIGGERS } from '@bike4mind/common';
import { z } from 'zod';
import { assertLakeResearchManage } from '@server/dataLakes/assertLakeResearchManage';
import { ResearchLeversInput, ResearchScheduleInput } from '@server/dataLakes/researchConfigInput';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';

const CreateInput = ResearchLeversInput.merge(ResearchScheduleInput).extend({
  name: z.string(),
  // Accepted so a client can be explicit; the service refuses one that disagrees with the cadence
  // rather than silently saving a config whose trigger field means nothing.
  trigger: z.enum(RESEARCH_RUN_TRIGGERS).optional(),
});

const db = { dataLakeResearchConfigs: dataLakeResearchConfigRepository, ...lakeConfigAuditDb };

/**
 * GET  /api/data-lakes/:id/research/configs - the lake's saved research configurations (#1682).
 * POST /api/data-lakes/:id/research/configs - save a new one.
 *
 * Manage-gated on both verbs (see `assertLakeResearchManage`). Bounds and normalization live in the
 * service, not here, so a config written through any future second path means the same thing.
 *
 * The GET also returns the lake's live `pendingProposals` - the same count the research scheduler
 * compares against each config's `reviewBacklogLimit` - so the panel can say scheduling is paused.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const { lake } = await assertLakeResearchManage(req, id);
    const [configs, pendingByLake] = await Promise.all([
      dataLakeResearchService.listResearchConfigs(lake.id, { db }),
      dataLakeProposalRepository.countPendingByLakes([lake.id]),
    ]);
    return res.json({ data: configs, pendingProposals: pendingByLake[lake.id] ?? 0 });
  })
  .post(async (req: Request, res) => {
    assertDataLakeWriteScope(req);
    const { id } = req.query as { id: string };

    // The manage gate runs inside the transaction so a grant revoke committing mid-request collides
    // on the lake doc and the retry re-reads live grants.
    const config = await withTransaction(async () => {
      const { lake, actor, grants } = await assertLakeResearchManage(req, id);
      const input = CreateInput.parse(req.body);

      const created = await dataLakeResearchService.createResearchConfig(lake, actor, grants, input, {
        db,
        logger: req.logger,
      });
      // Serializes this write against a concurrent grant revoke - see WRITE-TIME RESIDUAL on `canManageLake`.
      await dataLakeRepository.touchIfStable(lake.id);
      return created;
    });
    return res.status(201).json({ data: config });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
