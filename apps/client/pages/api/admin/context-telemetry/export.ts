import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { Quest, User, TelemetryAuditLogModel } from '@bike4mind/database';
import { z } from 'zod';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';
import { TELEMETRY_EXPORT_PROJECTION } from '@server/utils/telemetryProjection';
import { getClientIp, truncateIp } from '@server/utils/ip';
import { regenerateUserTelemetryHashes } from '@server/utils/telemetryHashLookup';

const querySchema = z.object({
  userId: z.string().min(1),
});

/**
 * DSAR (Data Subject Access Request) export endpoint for telemetry data.
 * GET /api/admin/context-telemetry/export?userId=<id>
 *
 * Reuses the same HMAC hash regeneration pattern as triggerTelemetryDeletion()
 * to find all telemetry records for a given user across 90 days of daily salts.
 * Returns telemetry records using TELEMETRY_SAFE_PROJECTION (no userId leakage).
 *
 * Admin-only. Audit-logged with action 'export'.
 */
const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    const startTime = Date.now();
    const sourceIp = truncateIp(getClientIp(req as Parameters<typeof getClientIp>[0]));
    const userAgent = (req.headers['user-agent'] as string) || 'unknown';

    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { userId } = querySchema.parse(req.query);

    const targetUser = await User.findById(userId).select('_id').lean();
    if (!targetUser) {
      throw new NotFoundError('User not found');
    }

    const hashes = await regenerateUserTelemetryHashes(userId);

    // Find all telemetry records using safe projection (no userId leakage)
    const records = await Quest.find({
      'promptMeta.contextTelemetry.anonymousSessionId.hash': { $in: hashes },
    })
      .select(TELEMETRY_EXPORT_PROJECTION)
      .lean();

    const telemetryData = records
      .filter(r => r.promptMeta?.contextTelemetry)
      .map(r => ({
        timestamp: r.timestamp?.toISOString() ?? '',
        telemetry: r.promptMeta!.contextTelemetry,
      }));

    const durationMs = Date.now() - startTime;

    TelemetryAuditLogModel.create({
      action: 'export',
      userId: req.user.id,
      questId: `dsar-export-for-${userId}`,
      sourceIp,
      userAgent,
      outcome: 'success',
      durationMs,
      metadata: { targetUserId: userId, recordCount: telemetryData.length },
    }).catch(err => {
      console.warn('[TelemetryAudit] Failed to log DSAR export:', err instanceof Error ? err.message : 'Unknown error');
    });

    res.json({
      userId,
      exportedAt: new Date().toISOString(),
      recordCount: telemetryData.length,
      retentionDays: 90,
      records: telemetryData,
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
