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
import { rateLimit } from '@server/middlewares/rateLimit';
import { isDevelopment } from '@server/utils/config';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Detection runs per caller per hour.
 *
 * Per CALLER, not per lake, and that is the whole point of the explicit bucket below: one run reads
 * up to 200 members x 5 chunks synchronously against the chunk collection (#1665 measured that scan
 * as ruinous at connector scale) and then writes the lake. A per-lake cap would leave "loop over
 * every lake I own" unbounded, which is the amplification `converge` already learned to close.
 *
 * GET is deliberately outside the cap: it reads what was already stored and does no detection, so
 * throttling it would throttle looking at a report rather than producing one.
 */
const DETECTION_HOURLY_CAP = 20;

const inconsistencyRunRateLimit = rateLimit({
  limit: () => (isDevelopment() ? Infinity : DETECTION_HOURLY_CAP),
  windowMs: HOUR_MS,
  bucket: 'data-lakes/inconsistencies',
});

/**
 * GET  /api/data-lakes/:id/inconsistencies - the last stored report (reads only, runs nothing)
 * POST /api/data-lakes/:id/inconsistencies - run cross-document inconsistency detection (#2242).
 *
 * DETECTION ONLY. Nothing here rejects, gates or removes anything, and the findings are heuristics
 * over prose: each means "worth a human's eye", never "proven contradiction". A follow-up that turns
 * any of this into an admission gate has to be argued on its own merits - deciding that ingestion
 * should refuse a document for disagreeing with a sibling makes this product the arbiter of a
 * customer's editorial judgment.
 *
 * The GET exists because without it every look was a write. `converge` ships its plan as a GET that
 * writes nothing precisely so that reading costs nothing; here, re-reading findings meant re-POSTing
 * - re-scanning up to 200 members, overwriting the stored report and stamping a new `computedAt`,
 * which destroys the run-to-run comparability that `nowYear` is injected to preserve.
 *
 * Both verbs are manage-gated, not just the write. That is deliberate and not an oversight about
 * read gates: the payload carries document EXCERPTS either way, and it is the PROSE that decides the
 * gate here, not the mutation. The read-gated view of this data is the counts-only summary on
 * GET /health.
 *
 * POST rather than GET for the run itself, and owner-triggered rather than folded into health, for one reason: detection
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
const gateDeps = {
  db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
};

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .use((req, res, next) => (req.method === 'POST' ? inconsistencyRunRateLimit(req, res, next) : next()))
  .get(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeWriteAccess(id, ctx, gateDeps);

    // Null rather than an empty report when detection has never run: "never asked" and "asked and
    // found nothing" are different answers and a surface has to be able to tell them apart.
    if (!lake.inconsistencyReport) return res.json(null);
    return res.json({ ...lake.inconsistencyReport, computedAt: lake.inconsistencyComputedAt ?? null });
  })
  .post(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeWriteAccess(id, ctx, gateDeps);

    // The year is passed in rather than read inside the detector so the same corpus always produces
    // the same report - a stored result an owner already reviewed has to be comparable to the next.
    const report = await dataLakeService.detectLakeInconsistencies(lake, new Date().getUTCFullYear(), {
      db: { fabFiles: fabFileRepository, fabFileChunks: fabFileChunkRepository },
      logger: req.logger,
    });

    // No slicing here any more. The cap moved into the detector, which allocates it PER KIND - a
    // slice at this layer would re-create the starvation that allocation exists to prevent, because
    // findings sort by kind name and one prolific kind would take the whole budget again.
    const stored = report;
    const computedAt = new Date();
    await dataLakeRepository.update({
      id: lake.id,
      inconsistencyReport: stored,
      inconsistencyComputedAt: computedAt,
    });

    return res.json({ ...stored, computedAt });
  });

// Matches 12 of the 14 routes in this directory, health and converge included. This handler can run
// ~1000 sequential chunk reads, so it is the last one that should look like an unresolved promise to
// the Next.js API layer.
export const config = { api: { externalResolver: true } };

export default handler;
