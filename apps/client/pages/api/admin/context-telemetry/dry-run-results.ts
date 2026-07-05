import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { ForbiddenError } from '@server/utils/errors';
import { telemetryDryRunResultRepository, type DryRunSource } from '@bike4mind/database';
import { z } from 'zod';

const querySchema = z.object({
  limit: z.string().optional(),
  source: z.enum(['test', 'real', 'all']).optional(),
});

/**
 * GET /api/admin/context-telemetry/dry-run-results
 *
 * Fetches recent dry run results for the Context Telemetry alert system.
 * Results are sorted by timestamp (most recent first) and auto-expire after 24 hours.
 */
const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const params = querySchema.parse(req.query);
    const parsedLimit = parseInt(params.limit || '20', 10);
    const limit = Number.isNaN(parsedLimit) ? 20 : Math.min(Math.max(parsedLimit, 1), 100);
    const source = (params.source as DryRunSource | 'all') || 'all';

    const [results, total] = await Promise.all([
      telemetryDryRunResultRepository.findRecent({ limit, source }),
      telemetryDryRunResultRepository.countResults(source),
    ]);

    const responseResults = results.map(result => ({
      _id: result.id,
      timestamp: result.timestamp.toISOString(),
      source: result.source,
      questId: result.questId,
      telemetrySummary: result.telemetrySummary,
      action: result.action,
      fingerprint: result.fingerprint,
      semanticFingerprint: result.semanticFingerprint,
      expiresAt: result.expiresAt.toISOString(),
    }));

    res.json({
      results: responseResults,
      total,
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
