import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { Quest, TelemetryAuditLogModel } from '@bike4mind/database';
import { z } from 'zod';
import { ForbiddenError } from '@server/utils/errors';
import { TELEMETRY_EXPORT_PROJECTION } from '@server/utils/telemetryProjection';
import { getClientIp, truncateIp } from '@server/utils/ip';
import { regenerateUserTelemetryHashes } from '@server/utils/telemetryHashLookup';

const paramsSchema = z.object({
  id: z.string().min(1),
});

/**
 * User-facing DSAR (Data Subject Access Request) export endpoint.
 * GET /api/users/[id]/telemetry-export
 *
 * Allows authenticated users to export their own telemetry data.
 * GDPR Article 15 (right of access) and Article 20 (right to data portability).
 */
const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    if (!req.user) {
      throw new ForbiddenError('Authentication required.');
    }

    const startTime = Date.now();
    const sourceIp = truncateIp(getClientIp(req as Parameters<typeof getClientIp>[0]));
    const userAgent = (req.headers['user-agent'] as string) || 'unknown';
    const { id: userId } = paramsSchema.parse(req.query);

    // Users can only export their own data (admins can use the admin endpoint for others)
    if (req.user.id !== userId) {
      throw new ForbiddenError('You can only export your own telemetry data.');
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

    // Audit the export
    TelemetryAuditLogModel.create({
      action: 'export',
      userId,
      questId: 'self-service-dsar',
      sourceIp,
      userAgent,
      outcome: 'success',
      durationMs,
      metadata: { recordCount: telemetryData.length, source: 'user_self_service' },
    }).catch(err => {
      console.warn('[TelemetryAudit] Failed to log DSAR export:', err instanceof Error ? err.message : 'Unknown error');
    });

    res.json({
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
