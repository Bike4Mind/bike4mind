import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  fabFileRepository,
  fabFileChunkRepository,
} from '@bike4mind/database';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

/** Findings persisted per lake. The counts are exact; this bounds what the lake document carries. */
const STORED_FINDINGS_CAP = 200;

/**
 * POST /api/data-lakes/:id/inconsistencies - run cross-document inconsistency detection (#2242).
 *
 * DETECTION ONLY. Nothing here rejects, gates or removes anything, and the findings are heuristics
 * over prose: each means "worth a human's eye", never "proven contradiction". A follow-up that turns
 * any of this into an admission gate has to be argued on its own merits - deciding that ingestion
 * should refuse a document for disagreeing with a sibling makes this product the arbiter of a
 * customer's editorial judgment.
 *
 * POST rather than GET, and owner-triggered rather than folded into health, for one reason: detection
 * reads chunk TEXT, and `computeLakeHealth` is forbidden from touching the chunk collection (#1665
 * measured that scan as ruinous at connector scale). So this pass runs on demand over a BOUNDED
 * sample, writes its result to the lake, and health renders what it last wrote. Same separation
 * `converge` uses between deciding and doing.
 *
 * Manage-gated via `assertLakeWriteAccess`, not reader-gated like GET health, for two reasons. The
 * response carries EXCERPTS of the lake's documents, and a reader who can see a lake is not
 * necessarily entitled to read every member's prose - `redactLakeForActor` withholds the stored
 * report from readers for the same reason. And that gate refuses fallback lakes, which is correct
 * here rather than incidental: a registry lake has no document to store a report on.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeWriteAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });

    // The year is passed in rather than read inside the detector so the same corpus always produces
    // the same report - a stored result an owner already reviewed has to be comparable to the next.
    const report = await dataLakeService.detectLakeInconsistencies(lake, new Date().getUTCFullYear(), {
      db: { fabFiles: fabFileRepository, fabFileChunks: fabFileChunkRepository },
      logger: req.logger,
    });

    const stored = { ...report, findings: report.findings.slice(0, STORED_FINDINGS_CAP) };
    const computedAt = new Date();
    await dataLakeRepository.update({
      id: lake.id,
      inconsistencyReport: stored,
      inconsistencyComputedAt: computedAt,
    });

    return res.json({ ...stored, computedAt });
  });

export default handler;
