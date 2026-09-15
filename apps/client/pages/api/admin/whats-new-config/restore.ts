import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { WhatsNewConfigService } from '@client/services/whatsNewConfigService';
import { ForbiddenError } from '@server/utils/errors';
import { logAuditEvent, AdminConfigAuditEvents } from '@server/utils/auditLog';
import { z } from 'zod';

// Rate limiting constants - stricter for restore operations
const RESTORE_RATE_LIMIT = 5; // requests per minute
const ONE_MINUTE_MS = 60 * 1000;

// Request schema
const RestoreRequestSchema = z.object({
  index: z.int().min(0),
});

const handler = baseApi()
  .use(rateLimit({ limit: RESTORE_RATE_LIMIT, windowMs: ONE_MINUTE_MS }))
  .post(async (req: Request, res: Response) => {
    // Check if user is admin
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    try {
      // Validate request body
      const { index } = RestoreRequestSchema.parse(req.body);

      // Get the configuration from history before restoring (for audit log)
      const history = await WhatsNewConfigService.getConfigHistory();
      if (index < 0 || index >= history.length) {
        return res.status(400).json({
          error: 'Invalid history index',
        });
      }

      const historyEntry = history[index];
      const oldConfig = await WhatsNewConfigService.getConfig();

      // Restore configuration
      const restoredConfig = await WhatsNewConfigService.restoreFromHistory(
        index,
        req.user.id,
        req.user.username ?? req.user.email
      );

      // Log audit event for config restore
      await logAuditEvent({
        userId: req.user.id,
        action: AdminConfigAuditEvents.WHATS_NEW_CONFIG_UPDATED,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        configType: 'whats-new-config',
        adminUserId: req.user.id,
        adminUsername: req.user.username ?? req.user.email,
        oldConfig,
        newConfig: restoredConfig,
        changedFields: ['restored_from_history'],
        reason: `Restored from history (index ${index}, original timestamp: ${historyEntry.metadata.timestamp})`,
      });

      return res.json({
        success: true,
        config: restoredConfig,
        message: 'Configuration restored successfully',
      });
    } catch (error) {
      console.error("Error restoring What's New config from history:", error);

      // Check if it's a validation error
      if (error instanceof Error && error.name === 'ZodError') {
        return res.status(400).json({
          error: 'Invalid request',
          details: error.message,
        });
      }

      // Check if it's a specific error message
      if (error instanceof Error && error.message.includes('Invalid history index')) {
        return res.status(400).json({
          error: error.message,
        });
      }

      return res.status(500).json({
        error: "Failed to restore What's New configuration from history",
      });
    }
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
