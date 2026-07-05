/**
 * SRE Pattern Admin API - PATCH /api/sre/patterns/:id
 *
 * Manual override for the pattern library. Used when operators need to:
 *   - Re-activate a pattern that the recurrence guard deactivated
 *   - Link a root-cause tracking issue so future escalation messages reference it
 *   - Clear the `workaroundIneffective` flag when the underlying root cause has
 *     been fixed and the cached workaround is once again relevant
 *
 * Safeguard: clearing `workaroundIneffective` from true back to false (which
 * would re-enable an escalated pattern) requires an explicit
 * `confirmReactivate: true` in the request body to prevent accidental silencing
 * of the recurrence escalation.
 */

import mongoose from 'mongoose';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { sreErrorPatternRepository } from '@bike4mind/database';
import { z } from 'zod';
import { Logger } from '@bike4mind/observability';

const PatchBodySchema = z.object({
  isActive: z.boolean().optional(),
  workaroundIneffective: z.boolean().optional(),
  rootCauseTrackingIssue: z.number().int().positive().nullable().optional(),
  /** Required when setting `workaroundIneffective` from true back to false. */
  confirmReactivate: z.boolean().optional(),
});

const handler = baseApi().patch(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Permission denied');

    const { id } = req.query as Record<string, string>;
    if (typeof id !== 'string' || !mongoose.Types.ObjectId.isValid(id)) {
      throw new BadRequestError('Invalid pattern id');
    }

    const body = PatchBodySchema.parse(req.body ?? {});

    const existing = await sreErrorPatternRepository.findById(id);
    if (!existing) throw new NotFoundError('Pattern not found');

    // Safeguard: prevent accidental re-enable of an escalated pattern.
    if (body.workaroundIneffective === false && existing.workaroundIneffective === true && !body.confirmReactivate) {
      throw new BadRequestError(
        'Refusing to clear workaroundIneffective without confirmReactivate=true. This pattern was marked ineffective by the recurrence guard; set confirmReactivate=true to acknowledge the override.'
      );
    }

    const updates: Record<string, unknown> = { id };
    if (body.isActive !== undefined) updates.isActive = body.isActive;
    if (body.workaroundIneffective !== undefined) updates.workaroundIneffective = body.workaroundIneffective;
    if (body.rootCauseTrackingIssue !== undefined) {
      // Allow null to clear the link; otherwise store the issue number.
      updates.rootCauseTrackingIssue = body.rootCauseTrackingIssue;
    }

    const updated = await sreErrorPatternRepository.update(updates);
    if (!updated) throw new NotFoundError('Pattern not found');

    Logger.info('[SRE-PATTERNS] Pattern overridden via admin PATCH', {
      patternId: id,
      actorUserId: req.user?.id,
      changes: body,
    });

    res.status(200).json(updated);
  })
);

export default handler;
