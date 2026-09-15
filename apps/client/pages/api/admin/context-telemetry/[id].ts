import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { Quest, telemetryAuditLogRepository } from '@bike4mind/database';
import { z } from 'zod';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';
import { TELEMETRY_SAFE_PROJECTION } from '@server/utils/telemetryProjection';
import { getClientIp, truncateIp } from '@server/utils/ip';

const paramsSchema = z.object({
  id: z.string().min(1),
});

const handler = baseApi()
  // GET /api/admin/context-telemetry/[id] - Get single telemetry entry
  .get(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const { id } = paramsSchema.parse(req.query);

      const quest = await Quest.findById(id).select(TELEMETRY_SAFE_PROJECTION).lean();

      if (!quest) {
        throw new NotFoundError(`Telemetry entry not found: ${id}`);
      }

      if (!quest.promptMeta?.contextTelemetry) {
        throw new NotFoundError(`No telemetry data for quest: ${id}`);
      }

      res.json({
        id: quest._id?.toString() ?? id,
        timestamp: quest.timestamp?.toISOString() ?? '',
        telemetry: quest.promptMeta.contextTelemetry,
      });
    })
  )
  // DELETE /api/admin/context-telemetry/[id] - GDPR deletion
  .delete(
    asyncHandler(async (req, res) => {
      const startTime = Date.now();
      // Cast req for getClientIp compatibility (Next.js API routes have similar structure to Express)
      const sourceIp = truncateIp(getClientIp(req as Parameters<typeof getClientIp>[0]));
      const userAgent = (req.headers['user-agent'] as string) || 'unknown';

      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const { id } = paramsSchema.parse(req.query);

      const quest = await Quest.findById(id);

      if (!quest) {
        throw new NotFoundError(`Quest not found: ${id}`);
      }

      if (!quest.promptMeta?.contextTelemetry) {
        throw new NotFoundError(`No telemetry data for quest: ${id}`);
      }

      try {
        // Remove telemetry but keep the quest (GDPR right to erasure).
        const result = await Quest.updateOne({ _id: id }, { $unset: { 'promptMeta.contextTelemetry': 1 } });

        // Verify the deletion succeeded (GDPR compliance requires confirmation)
        if (result.modifiedCount === 0) {
          throw new Error(`Failed to delete telemetry data for quest: ${id}`);
        }

        // Double-check the data was actually removed
        const verifyQuest = await Quest.findById(id).select('promptMeta.contextTelemetry').lean();
        if (verifyQuest?.promptMeta?.contextTelemetry) {
          throw new Error(`Telemetry data still exists after deletion attempt for quest: ${id}`);
        }

        const durationMs = Date.now() - startTime;
        const deletedAt = new Date().toISOString();

        // Log successful deletion for GDPR audit trail (fire-and-forget)
        telemetryAuditLogRepository
          .createLog({
            action: 'delete',
            userId: req.user.id,

            questId: id,
            sourceIp,
            userAgent,
            outcome: 'success',
            durationMs,
            metadata: { deletedAt },
          })
          .catch(() => {
            // Silent failure - audit logging should not block the response
          });

        res.json({
          success: true,
          message: `Telemetry data deleted for quest: ${id}`,
          deletedAt,
        });
      } catch (error) {
        const durationMs = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        // Log failed deletion for GDPR audit trail (fire-and-forget)
        telemetryAuditLogRepository
          .createLog({
            action: 'delete',
            userId: req.user.id,

            questId: id,
            sourceIp,
            userAgent,
            outcome: 'failure',
            errorMessage,
            durationMs,
          })
          .catch(() => {
            // Silent failure - audit logging should not block the response
          });

        throw error;
      }
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
