import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES, assertDataLakeWriteScope } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  dataLakeFindingRepository,
  fabFileRepository,
  fabFileChunkRepository,
} from '@bike4mind/database';
import {
  ConflictError,
  MODEL_INCONSISTENCY_RUN_LEASE_MS,
  isLeaseHeld,
  toScanSummary,
  type IDataLakeDocument,
} from '@bike4mind/common';
import { Request, Response } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { rateLimit } from '@server/middlewares/rateLimit';
import { isDevelopment } from '@server/utils/config';
import { sendToQueue } from '@server/utils/sqs';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';

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
 * Model-detection runs per caller per hour - far lower than the lexical `DETECTION_HOURLY_CAP` (20),
 * and deliberately its own bucket rather than sharing that budget. The lexical pass costs a regex
 * scan; this pass reads corpus content through an LLM (#3057), so its cost per run is real money,
 * not just latency - the caller-triggered cap is this feature's primary spend control until a
 * dollar-denominated one is worth building (see `enforceEmbeddingSpendGate` for that pattern, used
 * today only on the embedding-ingest path).
 */
const MODEL_DETECTION_HOURLY_CAP = 3;

const modelInconsistencyRunRateLimit = rateLimit({
  limit: () => (isDevelopment() ? Infinity : MODEL_DETECTION_HOURLY_CAP),
  windowMs: HOUR_MS,
  bucket: 'data-lakes/inconsistencies/model',
});

/**
 * Model-detection runs per LAKE per hour, enforced alongside the per-caller cap above rather than
 * instead of it. The two bound different things and neither implies the other: the per-caller cap
 * stops one person spending without limit, but the cost lands on the LAKE, and N curators with
 * manage rights each get their own allowance - so the caller cap alone lets a shared lake be billed
 * N x `MODEL_DETECTION_HOURLY_CAP` full LLM passes an hour. The lease serializes those runs; it does
 * not limit how many of them happen.
 *
 * Higher than the per-caller cap so a lake with several active curators is not throttled by the
 * first one to click, while still putting a hard ceiling on one lake's hourly spend.
 */
const MODEL_DETECTION_HOURLY_CAP_PER_LAKE = 6;

const modelInconsistencyLakeRateLimit = rateLimit({
  limit: () => (isDevelopment() ? Infinity : MODEL_DETECTION_HOURLY_CAP_PER_LAKE),
  windowMs: HOUR_MS,
  bucket: 'data-lakes/inconsistencies/model/lake',
  // Counted per lake, not per caller. `undefined` for a malformed id falls back to the default
  // subject, which only ever makes the limit stricter - it can never open the bucket up.
  subject: req => {
    const { id } = req.query as { id?: string };
    return typeof id === 'string' && id ? `lake:${id}` : undefined;
  },
});

const isModelDetectorRequest = (req: Request) => req.method === 'POST' && req.query.detector === 'model';

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
 * NOT the only trigger any more. `lakeInconsistencySweep` runs this same pass over every active
 * lake daily, so POST here is the "run it now" door rather than the only way a problem is ever
 * found. The rate limit below stays for exactly that reason: the schedule is what guarantees
 * coverage, so a caller hitting the cap has lost a fresher answer, not the answer.
 *
 * Findings are ROWS (`DataLakeFinding`), not a field of the response's own making: POST records
 * them and GET reads them back, and what is stored on the LAKE is only the run's summary. That is
 * what makes a repeating pass safe - the rows are keyed on (lakeId, detector, kind, subject), so the
 * hundredth run over an unchanged problem updates one row instead of writing a hundredth copy, and a
 * curator's status on it survives every one of those runs.
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

/**
 * The stored summary plus the findings that summary actually describes.
 *
 * `seenSince` is the load-bearing argument, and it is what keeps the response from contradicting
 * itself. Nothing ever closes a finding the detector stops reporting - deliberately, because
 * `status` is a curator's word and a detector retiring a row would be exactly the overwrite
 * `recordDetected` refuses to make. So a problem someone fixed leaves an `open` row behind forever.
 * Listing every open row beside this run's `countsByKind` would therefore ship a payload whose
 * counts said zero next to findings it did not count - and the daily sweep makes that gap permanent
 * and growing rather than a transient. Selecting on the summary's own date answers "what is wrong
 * with my corpus now" exactly, mutates nothing, and leaves the retired row - status intact - on the
 * triage surface, GET /findings.
 *
 * Null rather than an empty report when detection has never run: "never asked" and "asked and found
 * nothing" are different answers and a surface has to be able to tell them apart.
 *
 * `status: ['open', 'resolved']`, not `'open'` alone. `countsByKind` is an exact total over every
 * finding the run REPORTED - it has no notion of a curator's status, so it still counts a subject a
 * curator already resolved if this run re-detected it (the row's status never reopens on
 * re-detection; see `recordDetected`). Filtering the list to `open` only, as an earlier version of
 * this did, could then hand back a non-zero count beside a shorter findings list than it described.
 * Matching the two statuses `countsByKind` can actually contain - never `dismissed`, since
 * `detectCorpusInconsistencies` drops a dismissed subject before counting it - keeps the response
 * internally consistent instead.
 *
 * That leaves one gap `status` alone cannot close: a dismissal made AFTER this run stored its
 * summary only ever touches the row (`resolveFinding` never recomputes `countsByKind`), so serving
 * the stored count as-is would show a kind's count beside a findings list that no longer has that
 * subject in it - the identical shape of bug this function otherwise exists to prevent. So the
 * counts below are adjusted for exactly the rows this run reported that have since been dismissed -
 * found by `seenSince` AND `resolvedSince` together, not either alone: `resolvedSince` alone also
 * matches a row this run never re-detected (its `lastSeenAt` is from an older run, so it never
 * contributed to this run's `countsByKind`), and `seenSince` alone also matches a subject a curator
 * dismissed BEFORE this run whose `lastSeenAt` got bumped to this run's instant by a re-report
 * (`recordDetected` never touches `status`/`resolvedAt` on update, only `lastSeenAt` via `$max`).
 * Only `lastSeenAt >= computedAt AND resolvedAt >= computedAt` isolates "counted by this run, then
 * dismissed after it". Never a blind recompute from the (capped) `findings` list, which would
 * silently regress `countsByKind` from an exact total to a lower bound on any run `truncated` cut
 * into.
 */
async function renderStoredReport(
  lake: Pick<IDataLakeDocument, 'id' | 'inconsistencyReport' | 'inconsistencyComputedAt'>
) {
  if (!lake.inconsistencyReport) return null;
  const computedAt = lake.inconsistencyComputedAt ?? null;
  const findings = await dataLakeFindingRepository.listByLake(lake.id, {
    status: ['open', 'resolved'],
    ...(computedAt ? { seenSince: computedAt } : {}),
    // Matches what the detector would have capped a single run's findings at, so the page bound
    // cannot cut into a run the summary says was not truncated.
    limit: dataLakeService.INCONSISTENCY_FINDINGS_CAP,
  });

  // Skipped entirely when computedAt is null (never detected): there is then no run instant to
  // compensate relative to, and reading every dismissal ever would decrement counts that a run
  // never reported in the first place.
  const countsByKind = { ...lake.inconsistencyReport.countsByKind };
  if (computedAt) {
    const dismissedSinceRun = await dataLakeFindingRepository.listByLake(lake.id, {
      status: 'dismissed',
      seenSince: computedAt,
      resolvedSince: computedAt,
    });
    for (const finding of dismissedSinceRun) {
      if (countsByKind[finding.kind] > 0) countsByKind[finding.kind] -= 1;
    }
  }

  return { ...lake.inconsistencyReport, countsByKind, findings, computedAt };
}

/**
 * The model-driven contradiction pass (#3057). Kept out of the blob deliberately: `inconsistencyReport`
 * / `inconsistencyComputedAt` are the lexical pass's shape (`LakeInconsistencyReport`), and GET here
 * still reads exactly that - unchanged by this branch, matching how #3039's PR left GET and
 * `GET /health` alone when it added rows. A model finding is visible via
 * `GET /api/data-lakes/:id/findings?detector=model`, the same door the lexical rows already use.
 *
 * MUST STAY IN SYNC WITH the findings GET's detector handling. "Unchanged" above is true only while
 * that GET reads the stored blob. A change that has it render from ROWS instead must filter on
 * `detector` - `listByLake` applies one only when supplied - or a lake that has run both passes
 * returns `narrative-contradiction` rows next to a `countsByKind` the lexical pass built with
 * `'narrative-contradiction': 0`, which is the same mismatch on the detector axis that the status
 * axis already warns about.
 *
 * QUEUED, not run inline, and that is the difference between this branch working and not. The pass
 * makes up to `ceil(MODEL_INCONSISTENCY_MEMBER_SAMPLE / MODEL_INCONSISTENCY_BATCH_SIZE)` sequential
 * LLM calls, each able to take `MODEL_CONTRADICTION_TIMEOUT_MS` twice over; this Lambda is capped at
 * 60 seconds (`infra/web.ts`). Run
 * here, a normal-sized lake exhausted the request with every call it had already made billed and
 * nothing persisted - a 504, no findings, and one of three hourly attempts spent. So this door does
 * what `POST /lake-memory` does: check the preconditions, take the cap, enqueue, return 202. The
 * handler (`queueHandlers/lakeInconsistencyModelDetection`) gets a 10-minute budget, a DLQ and a
 * retry, and writes findings batch by batch as it goes.
 *
 * The response is deliberately NOT the run's result - there is no result yet. Findings arrive at
 * `GET /api/data-lakes/:id/findings?detector=model`, which is already the read door for these rows.
 */
async function enqueueModelDetection(
  lake: Awaited<ReturnType<typeof dataLakeService.assertLakeWriteAccess>>,
  userId: string,
  res: Response
) {
  // A lease held means a run is already reading this lake. Only a fast, honest rejection for the
  // human clicking twice - the claim that actually excludes a concurrent run is in the handler,
  // guarded in the query, because two requests can both read "no lease" before either enqueues.
  if (isLeaseHeld(lake.modelInconsistencyRunAt, new Date(), MODEL_INCONSISTENCY_RUN_LEASE_MS)) {
    throw new ConflictError('A model inconsistency run is already in progress for this lake.');
  }

  // A missing queue URL is a deployment misconfiguration, so fail here rather than reporting 202 for
  // work nothing will ever consume. Note this does NOT save the caller's hourly attempt the way the
  // lake-memory door's equivalent ordering does: that door consumes its per-lake cap inline, after
  // this check, whereas the cap here is the rate-limit middleware and is already spent by the time
  // any handler code runs. Moving it would mean duplicating the bucket accounting in a middleware,
  // which is not worth it for a fault that is the same on every attempt and visible immediately.
  const queueUrl = getSourceQueueUrl('lakeInconsistencyModelQueue');
  if (!queueUrl) throw new Error('Lake model inconsistency queue URL not found');

  await sendToQueue(queueUrl, { dataLakeId: lake.id, userId });

  return res.status(202).json({ ok: true, queued: true });
}

const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  // Gated separately from EnableDataLakes, and BEFORE the rate limiter below: a caller hitting a
  // disabled model pass should not burn its (far lower) hourly budget on requests that were always
  // going to 403, the same reason EnableDataLakes itself sits ahead of rate limiting.
  .use((req, res, next) =>
    isModelDetectorRequest(req)
      ? requireFeatureEnabled('EnableLakeModelInconsistencyDetection')(req, res, next)
      : next()
  )
  .use((req, res, next) => {
    if (req.method !== 'POST') return next();
    if (!isModelDetectorRequest(req)) return inconsistencyRunRateLimit(req, res, next);
    // Caller cap first: a caller already over their own budget must not consume the lake's.
    return modelInconsistencyRunRateLimit(req, res, err =>
      err ? next(err) : modelInconsistencyLakeRateLimit(req, res, next)
    );
  })
  .get(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeWriteAccess(id, ctx, gateDeps);

    return res.json(await renderStoredReport(lake));
  })
  .post(async (req: Request, res) => {
    assertDataLakeWriteScope(req);
    const { id } = req.query as { id: string };
    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeWriteAccess(id, ctx, gateDeps);

    if (isModelDetectorRequest(req)) return enqueueModelDetection(lake, ctx.userId, res);

    // The year is passed in rather than read inside the detector so the same corpus always produces
    // the same report - a stored result an owner already reviewed has to be comparable to the next.
    const { report, suppressed } = await dataLakeService.detectLakeInconsistencies(lake, new Date().getUTCFullYear(), {
      db: {
        fabFiles: fabFileRepository,
        fabFileChunks: fabFileChunkRepository,
        dataLakeFindings: dataLakeFindingRepository,
      },
      logger: req.logger,
    });

    // No slicing here any more. The cap moved into the detector, which allocates it PER KIND - a
    // slice at this layer would re-create the starvation that allocation exists to prevent, because
    // findings sort by kind name and one prolific kind would take the whole budget again.
    const computedAt = new Date();

    // Rows FIRST, and they are now the only place a finding is persisted. Keyed on
    // (lakeId, detector, kind, subject), so this run updating a problem a previous run already
    // found refreshes that row rather than minting a second one - which is what makes the scheduled
    // sweep (`lakeInconsistencySweep`) repeatable rather than a duplicate factory.
    //
    // Findings a curator DISMISSED are absent from `report` (#3045) but are recorded here too, along
    // with everything the report kept: suppressed from what a curator is shown, current in the row
    // behind it, so the evidence under a dismissal can change into a worse contradiction without the
    // row freezing.
    //
    // `computedAt` is passed as `seenAt` so a run's rows and its summary agree on one instant rather
    // than drifting by the write's latency - and so `renderStoredReport` below can use the summary's
    // own date to select the rows this run saw.
    const allFindings = [...report.findings, ...suppressed];
    const { failed } = await dataLakeService.recordLakeFindings(
      lake.id,
      allFindings,
      { detector: dataLakeService.INCONSISTENCY_DETECTOR, seenAt: computedAt },
      { db: { dataLakeFindings: dataLakeFindingRepository }, logger: req.logger }
    );

    // A run that did not record every finding does not get to date a summary, and does not get a
    // 200. The service isolates per-finding failures into `failed` rather than throwing - so it
    // NEVER throws for an unavailable collection, and an earlier version of this handler that
    // merely reordered the two writes would have sailed past N failures and stamped a fresh
    // `inconsistencyComputedAt` over zero persisted rows. That is the precise lie the ordering was
    // supposed to prevent: `countsByKind` claiming problems a curator has no rows for.
    //
    // Failing instead of storing is safe to retry: `recordDetected` is an idempotent upsert, so a
    // second attempt converges on the same rows, and the last COMPLETE run's summary stays in place
    // and correctly dated meanwhile.
    if (failed > 0) {
      req.logger?.warn('Lake findings partially recorded; summary not stored', {
        dataLakeId: lake.id,
        failed,
        total: allFindings.length,
      });
      throw new Error(`Recorded ${allFindings.length - failed} of ${allFindings.length} findings`);
    }

    // The SUMMARY only - `toScanSummary` drops the findings. Storing them here as well is what used
    // to make this an overwritable blob with no identity per finding, and it also kept a retention
    // obligation on the lake document that nothing could discharge: a finding carries a 240-char
    // excerpt of each source, and the purge-time sweeps reach rows only.
    const stored = toScanSummary(report);
    await dataLakeRepository.update({
      id: lake.id,
      inconsistencyReport: stored,
      inconsistencyComputedAt: computedAt,
    });

    // Rendered through the same helper GET uses, so "run it now" and "show me the last run" return
    // ONE shape. Returning `report.findings` here instead would hand a caller the detector's
    // in-memory findings - no id, no status, `evidence` where the row has `sources` - so a surface
    // could not render both responses, and could not resolve or assign anything it had just run.
    return res.json(
      await renderStoredReport({ ...lake, inconsistencyReport: stored, inconsistencyComputedAt: computedAt })
    );
  });

// Matches 12 of the 14 routes in this directory, health and converge included. This handler can run
// ~1000 sequential chunk reads, so it is the last one that should look like an unresolved promise to
// the Next.js API layer.
export const config = { api: { externalResolver: true } };

export default handler;
