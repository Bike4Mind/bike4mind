/**
 * SRE Tracking Dismiss API - POST /api/sre/tracking/:id/dismiss
 *
 * Allows admins to dismiss a terminal-ish tracking document. Dismissal marks the
 * doc as reviewed so it no longer counts against the circuit breaker's consecutive
 * failure tally, without deleting it (audit trail preserved via dismissalReason,
 * dismissedAt, dismissedByUserId).
 *
 * Dismissable source statuses: see DISMISSABLE_STATUSES in SreErrorTrackingModel.
 * Not dismissable: fixed (would corrupt "fix landed" signal) or in-flight states.
 *
 * Idempotent: dismissing an already-dismissed doc returns 200 with no-op.
 */

import mongoose from 'mongoose';
import { z } from 'zod';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { sreErrorTrackingRepository, cacheRepository, DISMISSABLE_STATUSES } from '@bike4mind/database';
import { SRE_DEFAULT_REPO_SLUG } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

const BodySchema = z.object({
  reason: z.string().min(3, 'Reason must be at least 3 characters').max(500),
});

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    if (!req.user.isAdmin) throw new ForbiddenError('Permission denied');

    const { id } = req.query as Record<string, string>;
    if (typeof id !== 'string' || !mongoose.Types.ObjectId.isValid(id)) {
      throw new NotFoundError('Invalid tracking ID');
    }

    const parsed = BodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues[0]?.message || 'Invalid request body');
    }

    const doc = await sreErrorTrackingRepository.findFullById(id);
    if (!doc) throw new NotFoundError('Tracking document not found');

    // Idempotent no-op if already dismissed
    if (doc.status === 'dismissed') {
      res.status(200).json({ success: true, alreadyDismissed: true });
      return;
    }

    const logger = new Logger({ metadata: { component: 'sre-dismiss', userId: req.user.id } });
    const updated = await sreErrorTrackingRepository.dismiss(id, parsed.data.reason, req.user.id);

    if (!updated) {
      res.status(409).json({
        message: `Cannot dismiss from current status: ${doc.status}. Dismissable statuses: ${DISMISSABLE_STATUSES.join(', ')}.`,
      });
      return;
    }

    // Clear dispatch dedup cache for this fingerprint. The original dispatch
    // set this cache with a 60-minute TTL (see SRE_FINGERPRINT_DEDUP_WINDOW_MS
    // in sreWebhookDispatch.ts). Without this, the fingerprint would remain
    // blocked from any subsequent dispatch attempts (webhook close/reopen,
    // Manual Trigger, etc.) until the TTL expires. Mirrors retry.ts:111.
    try {
      await cacheRepository.deleteByKey(
        `sre-dispatch-${doc.repoSlug ?? SRE_DEFAULT_REPO_SLUG}:${doc.errorFingerprint}`
      );
    } catch (cacheError) {
      // Non-fatal - dismiss still succeeded. Log for observability.
      logger.warn('[SRE-DISMISS] Failed to clear dispatch cache (non-fatal)', {
        fingerprint: doc.errorFingerprint,
        error: cacheError instanceof Error ? cacheError.message : String(cacheError),
      });
    }

    logger.info('[SRE-DISMISS] Tracking doc dismissed', {
      trackingId: id,
      fingerprint: doc.errorFingerprint,
      previousStatus: doc.status,
      reason: parsed.data.reason,
    });

    res.status(200).json({ success: true, fingerprint: doc.errorFingerprint });
  })
);

export default handler;
