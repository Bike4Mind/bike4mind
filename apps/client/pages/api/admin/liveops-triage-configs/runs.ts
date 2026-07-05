/**
 * LiveOps Triage Runs API
 *
 * GET - List all active and recent runs across all configs
 *
 * Returns runs from the last 10 minutes (or configurable via query param).
 * UI can poll this endpoint to show real-time progress.
 */

import { liveopsTriageRunRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { z } from 'zod';

/**
 * Query params schema
 */
const QuerySchema = z.object({
  minutes: z.coerce.number().min(1).max(60).optional().default(10),
});

const handler = baseApi().get(async (req, res) => {
  try {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    // Parse query params
    const parseResult = QuerySchema.safeParse(req.query);
    const minutes = parseResult.success ? parseResult.data.minutes : 10;

    // Fetch recent runs (includes active + recently completed)
    const runs = await liveopsTriageRunRepository.findRecentRuns(minutes);

    // Transform for API response
    const response = runs.map(run => ({
      id: run.id,
      configId: String(run.configId),
      configName: run.configName,
      runType: run.runType,
      source: run.source,
      status: run.status,
      progress: run.progress,
      queuedAt: run.queuedAt.toISOString(),
      startedAt: run.startedAt?.toISOString(),
      completedAt: run.completedAt?.toISOString(),
      result: run.result,
      error: run.error,
      // Include full dry run result for UI modal display
      dryRunResult: run.dryRunResult,
    }));

    return res.json({
      runs: response,
      activeCount: runs.filter(r => r.status === 'queued' || r.status === 'processing').length,
      totalCount: runs.length,
      lookbackMinutes: minutes,
    });
  } catch (error) {
    console.error('[LIVEOPS-RUNS-API] Error fetching runs:', error);
    return res.status(500).json({ error: 'Failed to fetch runs' });
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
