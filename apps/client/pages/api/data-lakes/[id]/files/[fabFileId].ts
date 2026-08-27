import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, dataLakeAccessGrantRepository, fabFileRepository } from '@bike4mind/database';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';

/**
 * DELETE /api/data-lakes/:id/files/:fabFileId
 * Removes a single file from a data lake (lake-scoped: drops every tag that makes the file a
 * member of this lake, then recomputes stats; the file and its chunks survive - see
 * removeFileFromDataLake).
 * Access-gated like the articles list (org-aware, not-found-style denial); the write is
 * then further restricted to owner/admin inside the service.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .delete(async (req: Request<{}, unknown, unknown, { id: string; fabFileId: string }>, res) => {
    const { id, fabFileId } = req.query;
    const ctx = await toAccessContext(req);

    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    dataLakeService.assertLakeWritable(lake);

    // The removal recomputes stats, which can flip a draft lake active and emit a config-change
    // row; `auditPrincipal` is what keeps a key-driven removal from being recorded as the human.
    const actor = { ...ctx, auditPrincipal: lakeConfigAuditPrincipal(req.user!, req.apiKeyInfo) };

    const result = await dataLakeService.removeFileFromDataLake(actor, lake.id, fabFileId, {
      db: {
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        fabFiles: fabFileRepository,
        // Without these, `recordLakeConfigChange` returns at its `if (!events) return` guard, so the
        // draft -> active flip a removal can trigger records nothing AND the threaded logger below
        // has nothing to report. Every other audited lake-write route spreads this; omitting it fails
        // silently, which is why it lives in one shared helper.
        ...lakeConfigAuditDb,
      },
      logger: req.logger,
    });

    return res.json(result);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
