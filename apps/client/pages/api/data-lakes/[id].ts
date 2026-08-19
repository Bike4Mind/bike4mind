import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeRepository,
  dataLakeBatchRepository,
  dataLakeAccessGrantRepository,
  fabFileRepository,
  adminSettingsRepository,
} from '@bike4mind/database';
import { UpdateDataLakeRequestInput } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';
import { isSessionActivatablePromptId } from '@server/utils/sessionActivatablePrompts';

// The canonical single READ gate observes the read-time grant cutover (#1673): its assertLakeAccess
// call is wired with the settings repo + a logger, so a persisted reader grant that WOULD change
// access is emitted as a [lakeReadGrantCutover] diff line (report-only until EnforceLakeReadGrants).
const readGateLogger = new Logger({ metadata: { handler: 'dataLakeReadGate' } });

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  // GET /api/data-lakes/:id - get a single data lake (by ObjectId or slug)
  .get(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const ctx = await toAccessContext(req);
    // Single shared gate: resolves the lake and asserts owner/org/tag access,
    // denying with a not-found-style error so existence isn't disclosed.
    const dataLake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: {
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        settings: adminSettingsRepository,
      },
      logger: readGateLogger,
    });
    // Read access is wider than manage (org members, gate holders, and anyone at all for a
    // published lake), so strip the editor-only fields before serializing the raw document. Load
    // the lake's grants so a curator / transferred owner (not just the creator/admin) still gets
    // the full editor document.
    const grants = await dataLakeService.loadActiveLakeGrants(dataLake, {
      db: { dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    return res.json(dataLakeService.redactLakeForActor(dataLake, ctx, grants));
  })
  // PUT /api/data-lakes/:id - update a data lake (metadata only; not lifecycle)
  .put(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const params = UpdateDataLakeRequestInput.parse(req.body);
    // This is the authoritative write boundary for the lake's preferred prompt, and the one place
    // that owns the session-activatable allowlist. Reject a non-activatable id here (fail loud, 400)
    // rather than storing a value the session resolver would silently refuse to inject later. '' is
    // the clear sentinel and passes (falsy), so removing the binding is always allowed.
    // INVARIANT: this route is the ONLY caller of updateDataLake with preferredSystemPromptId, so
    // the check is not bypassable today. A second write path must repeat this allowlist check (core
    // cannot host it - see the schema comment on preferredSystemPromptId in common/schemas/dataLake).
    if (params.preferredSystemPromptId && !isSessionActivatablePromptId(params.preferredSystemPromptId)) {
      throw new BadRequestError(`"${params.preferredSystemPromptId}" is not a valid preferred system prompt`);
    }
    const ctx = await toAccessContext(req);
    // Gate first (org-aware, not-found-style denial) so this write path can't be used
    // to probe existence or act cross-org - consistent with the lifecycle endpoint.
    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    dataLakeService.assertLakeWritable(lake);

    const updated = await dataLakeService.updateDataLake(ctx, lake.id, params, {
      db: {
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        ...lakeConfigAuditDb,
      },
      logger: req.logger,
    });

    return res.json(updated);
  })
  // DELETE /api/data-lakes/:id - archive a data lake (reversible; full teardown)
  .delete(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    dataLakeService.assertLakeWritable(lake);

    const archived = await dataLakeService.archiveDataLake(ctx, lake.id, {
      db: {
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        batches: dataLakeBatchRepository,
        fabFiles: fabFileRepository,
        ...lakeConfigAuditDb,
      },
      logger: req.logger,
    });

    return res.json(archived);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
