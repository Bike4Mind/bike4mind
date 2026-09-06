import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
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
 *
 * Manage-gated (`assertLakeRebuildAccess`), matching /converge and /rechunk: this repairs/rebuilds
 * derived state rather than lake content, so it needs no lake-scoped write grant.
 */

const gateDeps = { db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository } };

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
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

    // Clears any continuation watermark left over from a prior chain (one that hit the slice
    // ceiling, or was interrupted) so a manual rebuild scans the lake from the start rather than
    // silently resuming mid-lake. Safe here specifically because precondition 3 above already
    // confirmed no lease is held, so nothing is concurrently reading or writing this cursor.
    await dataLakeRepository.setLakeMemoryCursor(lake.id, null);

    const queueUrl = getSourceQueueUrl('lakeMemoryQueue');
    if (!queueUrl) throw new Error('Lake memory queue URL not found');
    await sendToQueue(queueUrl, {
      // No real batch backs a manual trigger; batchId is carried through only for log correlation
      // (extractLakeMemory.ts never reads it back), so a synthetic, self-describing id is enough.
      batchId: `manual:${lake.id}:${Date.now()}`,
      dataLakeId: lake.id,
      userId: ctx.userId,
      slice: 0,
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
