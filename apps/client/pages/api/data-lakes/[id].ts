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
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';
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
    const redacted = dataLakeService.redactLakeForActor(dataLake, ctx, grants);

    // A registry lake has no document, so it has no persisted `fileCount`/`totalSizeBytes` to
    // serialize - the fields were simply absent, while this same lake's /articles reported a real
    // total. Compute them live off the SAME membership scope /articles resolves, so the two agree.
    // Only the registry arm needs this: a DB lake carries stats maintained by recomputeLakeStats.
    //
    // Degrades to the un-augmented lake rather than failing the read: a stats aggregate is
    // supporting detail on this endpoint, and a lake that cannot be opened at all is much worse
    // than one whose counts are briefly missing. Logged so it is not silent.
    if (dataLakeService.isFallbackLake(dataLake)) {
      try {
        const stats = await fabFileRepository.computeDataLakeStats(dataLakeService.registryMembershipScope(dataLake));
        return res.json({ ...redacted, fileCount: stats.fileCount, totalSizeBytes: stats.totalSizeBytes });
      } catch (error) {
        // `.error` not `.warn`, and a metadata OBJECT not the raw Error: Logger.warn calls
        // parseArgs without errorAware, and parseArgs excludes an Error from the metadata branch,
        // so `warn(msg, err)` serializes it via JSON.stringify and emits a bare `{}` - no message,
        // no stack, no lake id. That would make this degrade genuinely silent, which is the
        // opposite of what the comment above promises.
        req.logger?.error('[dataLakes] registry lake stats unavailable; returning lake without counts', {
          err: error instanceof Error ? error.message : String(error),
          lakeId: dataLake.id,
        });
      }
    }
    return res.json(redacted);
  })
  // PUT /api/data-lakes/:id - update a data lake (metadata only; not lifecycle)
  .put(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const params = UpdateDataLakeRequestInput.parse(req.body);
    // This is the write boundary for a DB LAKE's preferred prompt, and one of two places that owns
    // the session-activatable allowlist - the other is PUT /api/data-lakes/:id/settings, the sibling
    // write path for a STATIC (registry) lake's overlay. Reject a non-activatable id here (fail loud,
    // 400) rather than storing a value the session resolver would silently refuse to inject later.
    // '' is the clear sentinel and passes (falsy), so removing the binding is always allowed.
    // INVARIANT: this route is the ONLY caller of updateDataLake with preferredSystemPromptId - the
    // static-lake path calls updateFallbackLakeSettings instead, a different function entirely, so
    // the two cannot double-write the same document. Each independently repeats this allowlist check
    // (core cannot host it - see the schema comment on preferredSystemPromptId in
    // common/schemas/dataLake); a THIRD write path must repeat it again.
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

    // An API-key PUT is attributed to the KEY, with its owner kept findable in the audit row.
    const actor = { ...ctx, auditPrincipal: lakeConfigAuditPrincipal(req.user!, req.apiKeyInfo) };
    const updated = await dataLakeService.updateDataLake(actor, lake.id, params, {
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

    const actor = { ...ctx, auditPrincipal: lakeConfigAuditPrincipal(req.user!, req.apiKeyInfo) };
    const archived = await dataLakeService.archiveDataLake(actor, lake.id, {
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
