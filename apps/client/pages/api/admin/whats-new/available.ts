import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { rateLimit } from '@server/middlewares/rateLimit';
import { WhatsNewForkFetcher, AvailableModalEntry } from '@server/services/whatsNewForkFetcher';
import { getWhatsNewEnvInfo } from '@server/utils/whatsNewEnv';

export interface AvailableModalsResponse {
  success: boolean;
  modals: AvailableModalEntry[];
  stage: string;
  timestamp: string;
  error?: string;
}

/**
 * GET /api/admin/whats-new/available
 *
 * List all available What's New modals from production S3 manifest.
 * Returns modals with import status (available/imported).
 * Only available in non-source environments (staging, dev, fork production).
 * Source environment (main production with ENABLE_WHATS_NEW_DISTRIBUTION=true) generates modals.
 * Requires admin privileges.
 */
const handler = baseApi()
  .use(
    rateLimit({
      limit: 20,
      windowMs: 60 * 1000, // 20 requests per minute
    })
  )
  .get(async (req: Request, res: Response) => {
    // Check if user is admin
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const env = await getWhatsNewEnvInfo();

    // Block in source environment (it generates modals, doesn't sync)
    if (env.isSourceEnvironment) {
      return res.status(403).json({
        success: false,
        modals: [],
        stage: env.stage,
        timestamp: new Date().toISOString(),
        error: 'Listing available modals is disabled in the source environment. This environment generates modals.',
      } satisfies AvailableModalsResponse);
    }

    // Check if distribution URL is configured
    if (!env.distributionUrlConfigured) {
      return res.json({
        success: true,
        modals: [],
        stage: env.stage,
        timestamp: new Date().toISOString(),
        error: 'Distribution URL not configured. Modals will be available after production deployment.',
      } satisfies AvailableModalsResponse);
    }

    try {
      const modals = await WhatsNewForkFetcher.listAvailableModals();

      req.logger?.info("Listed available What's New modals", {
        total: modals.length,
        imported: modals.filter(m => m.status === 'imported').length,
      });

      return res.json({
        success: true,
        modals,
        stage: env.stage,
        timestamp: new Date().toISOString(),
      } satisfies AvailableModalsResponse);
    } catch (error) {
      req.logger?.error("Error listing available What's New modals:", { error });
      return res.status(500).json({
        success: false,
        modals: [],
        stage: env.stage,
        timestamp: new Date().toISOString(),
        error: 'Failed to list available modals. Check server logs for details.',
      } satisfies AvailableModalsResponse);
    }
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
