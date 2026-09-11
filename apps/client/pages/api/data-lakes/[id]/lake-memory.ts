import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES, assertDataLakeWriteScope } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { rateLimit } from '@server/middlewares/rateLimit';
import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  adminSettingsRepository,
  cacheRepository,
  memoryLedgerRepository,
} from '@bike4mind/database';
import { isLeaseHeld, ConflictError, UnprocessableEntityError, TooManyRequestsError } from '@bike4mind/common';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { sendToQueue } from '@server/utils/sqs';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import {
  LAKE_MEMORY_DAILY_CAP,
  LAKE_MEMORY_RATE_LIMIT_WINDOW_MS,
  lakeMemoryRateLimitKey,
} from '@server/dataLakes/lakeMemoryRateLimit';
import { DataLakeAuditEvents, logAuditEvent } from '@server/utils/auditLog';
import { resolveAuditPrincipal } from '@server/dataLakes/resolveAuditPrincipal';

/**
 * GET  /api/data-lakes/:id/lake-memory  -> LakeMemoryHealth (the build door's own state, so the UI
 *   can poll it without paying for the whole /health member scan while a build is running)
 * POST /api/data-lakes/:id/lake-memory  -> queue a full-lake (re)build
 *
 * The manual build door: a lake's extracted-fact memory profile has, until now, been
 * buildable ONLY by the automatic per-batch trigger (`enqueueLakeMemoryExtractionIfWanted`) or a
 * direct AWS queue send - there was no UI path to build or rebuild one on demand. POST re-scans the
 * WHOLE lake (same producer `extractLakeMemoryForBatch` the automatic path uses) and relies on the
 * ledger's semantic de-dup for idempotency, exactly like a real batch finalize would.
 *
 * POST preconditions, checked in this order and each independently observable in the GET response:
 *  1. platform flag (`EnableLakeMemory`) off -> 409, retain-but-inert (never mutates the lake)
 *  2. `lake.lakeMemoryEnabled !== true` -> 422 (also how a fallback/registry lake is refused: it has
 *     no backing document, so it can never carry this field as true)
 *  3. an extraction lease already held (`isLeaseHeld`) -> 409, so two clicks can't double-run
 *  4. the SAME per-lake daily cap the automatic path enforces (`lakeMemoryRateLimitKey`) -> 429, no
 *     bypass for a manual trigger
 *  5. a per-CALLER daily cap on top of it (`lakeMemoryCallerRateLimit`) -> 429. Precondition 4 is
 *     keyed by lake, so on its own it bounds one lake and not "loop over every lake I manage".
 *
 * Manage-gated (`assertLakeRebuildAccess`), matching /converge and /rechunk: this repairs/rebuilds
 * derived state rather than lake content, so it needs no lake-scoped write grant.
 */

/**
 * Builds per day per CALLER, on top of the per-lake cap.
 *
 * The per-lake cap (`LAKE_MEMORY_DAILY_CAP`) is keyed by lake id, so it bounds one lake's spend and
 * says nothing about one caller looping over every lake they manage - and a manual build is the most
 * expensive thing this subsystem does (a chain of up to LAKE_MEMORY_MAX_CONTINUATION_SLICES slices,
 * each running the extractor over up to MAX_DOCS_PER_RUN documents, with the LLM call ahead of the
 * ledger de-dup so a re-scan genuinely re-bills). Set to four lakes' worth of the per-lake cap: a
 * manager rebuilding a handful of lakes never notices it, a loop stops.
 *
 * NOT exempted for admins, and for the same reason /converge is not: this meters SPEND rather than
 * gating an action, and the operator most able to loop the button is exactly the one it must bound.
 */
const LAKE_MEMORY_CALLER_DAILY_CAP = 4 * LAKE_MEMORY_DAILY_CAP;

const lakeMemoryCallerRateLimit = rateLimit({
  limit: () => LAKE_MEMORY_CALLER_DAILY_CAP,
  windowMs: LAKE_MEMORY_RATE_LIMIT_WINDOW_MS,
  // Required: the raw pathname embeds the lake id, which would make this per-lake and duplicate the
  // cap above instead of bounding the caller across lakes.
  bucket: 'data-lakes/lake-memory',
});

const gateDeps = { db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository } };

const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  // POST-scoped: the GET is the state poll the manager panel drives while a build runs, and capping
  // it would throttle reading state rather than starting work. Same shape as /converge.
  .use((req, res, next) => (req.method === 'POST' ? lakeMemoryCallerRateLimit(req, res, next) : next()))
  .get(async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    const { id } = req.query;
    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeAccess(id, ctx, gateDeps);
    const lakeMemory = await dataLakeService.computeLakeMemoryHealth(lake, {
      adminSettings: adminSettingsRepository,
      memoryLedger: memoryLedgerRepository,
    });
    return res.json(lakeMemory);
  })
  .post(async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    assertDataLakeWriteScope(req);
    const { id } = req.query;
    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeRebuildAccess(id, ctx, gateDeps);

    const platformEnabled = await adminSettingsRepository.getSettingsValue('EnableLakeMemory').catch(() => false);
    if (!platformEnabled) {
      throw new ConflictError('Lake memory is disabled platform-wide.');
    }
    if (lake.lakeMemoryEnabled !== true) {
      throw new UnprocessableEntityError('Lake memory is not enabled for this lake.');
    }
    if (isLeaseHeld(lake.lakeMemoryExtractionAt, new Date())) {
      throw new ConflictError('A lake memory build is already running for this lake.');
    }

    // Resolved BEFORE the cap is consumed: a missing queue URL is a deployment misconfiguration, so it
    // throws on every attempt - and consuming a cap slot first would burn the lake's whole daily
    // allowance on a fault that never enqueued a thing, leaving a 429 to explain a 500. Order alone
    // fixes the deterministic case; a transient SQS failure below can still cost a slot, which is
    // acceptable because it clears on its own and the counter is a spend ceiling, not an entitlement.
    const queueUrl = getSourceQueueUrl('lakeMemoryQueue');
    if (!queueUrl) throw new Error('Lake memory queue URL not found');

    // Same bucket the automatic per-batch trigger increments (`enqueueLakeMemoryExtractionIfWanted`)
    // - a manual click and a burst of batch finalizes draw from ONE cap, not two, so this door is not
    // a way around the ceiling that exists to bound LLM spend.
    const { success: withinCap } = await cacheRepository.tryIncrementWithinLimitFixedWindow(
      lakeMemoryRateLimitKey(lake.id),
      LAKE_MEMORY_DAILY_CAP,
      LAKE_MEMORY_RATE_LIMIT_WINDOW_MS
    );
    if (!withinCap) {
      throw new TooManyRequestsError('Daily lake memory build limit reached for this lake.');
    }

    // The continuation watermark is NOT cleared here. Precondition 3 only proves no lease is held at
    // this instant, and the lease is per-slice while the cursor is not - so between two slices of a
    // live chain this door sees a released lease and a valid cursor, and clearing it reset that chain
    // to the start of the lake and re-billed the LLM pass over every document it had covered. The
    // `restart` flag below moves the clear into the run, which does hold the lease.
    await sendToQueue(queueUrl, {
      // No real batch backs a manual trigger; batchId is carried through only for log correlation
      // (extractLakeMemory.ts never reads it back), so a synthetic, self-describing id is enough.
      batchId: `manual:${lake.id}:${Date.now()}`,
      dataLakeId: lake.id,
      userId: ctx.userId,
      slice: 0,
      // A manual build means "start over", which is why the door does not need to clear the cursor
      // itself. Continuation slices re-enqueue without this and resume normally.
      restart: true,
    });

    await logAuditEvent(
      {
        userId: ctx.userId,
        action: DataLakeAuditEvents.LAKE_MEMORY_BUILD_TRIGGERED,
        metadata: { dataLakeId: lake.id, ...resolveAuditPrincipal(req.user!, req.apiKeyInfo) },
      },
      req.logger
    );

    return res.status(202).json({ ok: true, queued: true });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
