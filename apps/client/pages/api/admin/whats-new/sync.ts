import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { rateLimit } from '@server/middlewares/rateLimit';
import { logAuditEvent, AdminConfigAuditEvents } from '@server/utils/auditLog';
import { WhatsNewForkFetcher } from '@server/services/whatsNewForkFetcher';
import { getWhatsNewEnvInfo } from '@server/utils/whatsNewEnv';

export interface WhatsNewSyncResult {
  success: boolean;
  imported: boolean;
  reason: string;
  modalId?: string;
  generatedDate?: string;
  /** Results of syncing existing modals (updates and deletions) */
  existingSync?: {
    updated: number;
    deleted: number;
    upToDate: number;
    errors?: string[];
  };
  stage: string;
  timestamp: string;
}

/**
 * POST /api/admin/whats-new/sync
 *
 * Manually trigger What's New modal sync from production.
 * Only available in non-source environments (staging, dev, fork production).
 * Source environment (main production with ENABLE_WHATS_NEW_DISTRIBUTION=true) generates modals.
 * Requires admin privileges.
 */
const handler = baseApi()
  .use(
    rateLimit({
      limit: 5,
      windowMs: 60 * 1000, // 5 attempts per minute
    })
  )
  .post(async (req: Request, res: Response) => {
    // Check if user is admin
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const env = await getWhatsNewEnvInfo();

    // Block in source environment (it generates modals, doesn't sync)
    if (env.isSourceEnvironment) {
      return res.status(403).json({
        success: false,
        imported: false,
        reason: 'Sync is disabled in the source environment. This environment generates modals.',
        stage: env.stage,
        timestamp: new Date().toISOString(),
      });
    }

    // Check if distribution URL is configured
    if (!env.distributionUrlConfigured) {
      return res.status(400).json({
        success: false,
        imported: false,
        reason:
          "Sync not available: Distribution URL is not configured. Set it in the 'Sync Configuration' section above, or configure the WHATS_NEW_DISTRIBUTION_URL SST secret.",
        stage: env.stage,
        timestamp: new Date().toISOString(),
      });
    }

    try {
      // 1. Import new modals (existing behavior)
      const importResult = await WhatsNewForkFetcher.fetchAndImportLatest();

      // 2. Sync existing modals (updates and deletions)
      const existingSync = await WhatsNewForkFetcher.syncExistingModals();

      // Log audit event
      await logAuditEvent(
        {
          userId: req.user!.id,
          action: AdminConfigAuditEvents.WHATS_NEW_SYNC_TRIGGERED,
          ip: req.ip,
          userAgent: req.headers['user-agent'] || 'unknown',
          metadata: { importResult, existingSync },
        },
        req.logger
      );

      req.logger?.info("What's New sync triggered manually", { importResult, existingSync });

      return res.json({
        success: true,
        ...importResult,
        existingSync: {
          updated: existingSync.updated,
          deleted: existingSync.deleted,
          upToDate: existingSync.upToDate,
          errors: existingSync.errors.length > 0 ? existingSync.errors : undefined,
        },
        stage: env.stage,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      req.logger?.error("Error syncing What's New modal:", { error });
      return res.status(500).json({
        success: false,
        imported: false,
        reason: 'Failed to sync from production. Check server logs for details.',
        stage: env.stage,
        timestamp: new Date().toISOString(),
      });
    }
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
