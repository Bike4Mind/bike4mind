import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';
import { rateLimit } from '@server/middlewares/rateLimit';
import { logAuditEvent, AdminConfigAuditEvents } from '@server/utils/auditLog';
import { WhatsNewForkFetcher, ImportModalResult } from '@server/services/whatsNewForkFetcher';
import { getWhatsNewEnvInfo } from '@server/utils/whatsNewEnv';
import { z } from 'zod';

// S3 key pattern: production/{YYYY-MM-DD or alphanumeric tag}.json
// Prevents path traversal attacks by validating exact expected format
const S3_KEY_PATTERN = /^production\/(\d{4}-\d{2}-\d{2}|[a-zA-Z0-9._-]+)\.json$/;

const ImportRequestSchema = z.object({
  modalKeys: z
    .array(
      z
        .string()
        .min(1)
        .max(100)
        .regex(S3_KEY_PATTERN, 'Invalid S3 key format. Expected: production/{YYYY-MM-DD or tag}.json')
    )
    .min(1)
    .max(50),
});

export interface ImportModalsResponse {
  success: boolean;
  results: ImportModalResult[];
  summary: {
    total: number;
    imported: number;
    skipped: number;
    failed: number;
  };
  stage: string;
  timestamp: string;
  error?: string;
}

/**
 * POST /api/admin/whats-new/import
 *
 * Import specific What's New modals from production S3.
 * Accepts a list of modal keys to import.
 * Only available in non-source environments (staging, dev, fork production).
 * Source environment (main production with ENABLE_WHATS_NEW_DISTRIBUTION=true) generates modals.
 * Requires admin privileges.
 *
 * Request body:
 * {
 *   modalKeys: ["production/2025-12-29.json", "production/2025-12-28.json"]
 * }
 */
const handler = baseApi()
  .use(
    rateLimit({
      limit: 10,
      windowMs: 60 * 1000, // 10 imports per minute
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
        results: [],
        summary: { total: 0, imported: 0, skipped: 0, failed: 0 },
        stage: env.stage,
        timestamp: new Date().toISOString(),
        error: 'Importing modals is disabled in the source environment. This environment generates modals.',
      } satisfies ImportModalsResponse);
    }

    // Check if distribution URL is configured
    if (!env.distributionUrlConfigured) {
      return res.status(400).json({
        success: false,
        results: [],
        summary: { total: 0, imported: 0, skipped: 0, failed: 0 },
        stage: env.stage,
        timestamp: new Date().toISOString(),
        error: 'Import not available: WHATS_NEW_DISTRIBUTION_URL is not configured for this environment.',
      } satisfies ImportModalsResponse);
    }

    // Validate request body
    const parseResult = ImportRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new BadRequestError(`Invalid request body: ${parseResult.error.issues.map(e => e.message).join(', ')}`);
    }

    const { modalKeys } = parseResult.data;

    try {
      // Import each modal sequentially to avoid race conditions
      const results: ImportModalResult[] = [];
      for (const key of modalKeys) {
        const result = await WhatsNewForkFetcher.importModalByKey(key);
        results.push(result);
      }

      // Calculate summary
      const summary = {
        total: results.length,
        imported: results.filter(r => r.success).length,
        skipped: results.filter(r => !r.success && r.reason === 'Modal already imported').length,
        failed: results.filter(r => !r.success && r.reason !== 'Modal already imported').length,
      };

      // Log audit event
      await logAuditEvent(
        {
          userId: req.user!.id,
          action: AdminConfigAuditEvents.WHATS_NEW_SYNC_TRIGGERED,
          ip: req.ip,
          userAgent: req.headers['user-agent'] || 'unknown',
          metadata: {
            type: 'selective_import',
            modalKeys,
            summary,
          },
        },
        req.logger
      );

      req.logger?.info("What's New modals imported", { summary, modalKeys });

      return res.json({
        success: true,
        results,
        summary,
        stage: env.stage,
        timestamp: new Date().toISOString(),
      } satisfies ImportModalsResponse);
    } catch (error) {
      req.logger?.error("Error importing What's New modals:", { error });
      return res.status(500).json({
        success: false,
        results: [],
        summary: { total: modalKeys.length, imported: 0, skipped: 0, failed: modalKeys.length },
        stage: env.stage,
        timestamp: new Date().toISOString(),
        error: 'Failed to import modals. Check server logs for details.',
      } satisfies ImportModalsResponse);
    }
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
