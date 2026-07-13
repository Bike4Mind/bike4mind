/**
 * SRE Metrics API - Aggregate pipeline metrics for the admin activity dashboard.
 *
 * Counts are computed server-side over docs created within the selected window
 * (no client-side collection scan). Optionally scoped to a repoSlug.
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { sreErrorTrackingRepository } from '@bike4mind/database';
import { DEFAULT_SRE_METRICS_WINDOW, SRE_METRICS_WINDOW_MS, type SreMetricsWindow } from '@bike4mind/common';

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    if (!req.user.isAdmin) throw new ForbiddenError('Permission denied');

    const query = req.query as Record<string, string | string[] | undefined>;
    const repoSlug = typeof query.repoSlug === 'string' ? query.repoSlug : undefined;
    const windowParam = typeof query.window === 'string' ? query.window : undefined;
    // Object.hasOwn (not `in`) so prototype keys like ?window=toString don't
    // resolve to a Function and flow NaN into the window math downstream.
    const window: SreMetricsWindow =
      windowParam && Object.hasOwn(SRE_METRICS_WINDOW_MS, windowParam)
        ? (windowParam as SreMetricsWindow)
        : DEFAULT_SRE_METRICS_WINDOW;

    const metrics = await sreErrorTrackingRepository.getMetrics(SRE_METRICS_WINDOW_MS[window], repoSlug);
    res.status(200).json(metrics);
  })
);

export default handler;
