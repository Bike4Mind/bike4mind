import { rateLimit } from './rateLimit';

/**
 * Hourly per-user budget shared by the /api/tools/* routes (weather, web-fetch, web-search).
 * Their callers are agent loops, not people clicking: a desktop research turn spends up to
 * WEB_SEARCH_TURN_BUDGET (5) searches plus the fetches that read the hits, ~15 calls in all
 * (apps/desktop/src/main/chat/tools/webTools.ts), and voice calls the same routes per tool step.
 * 600 covers ~40 such turns an hour, one every 90 seconds, while still capping a runaway loop.
 */
export const TOOL_ROUTES_HOURLY_LIMIT = 600;

/** One bucket for all three routes, keyed by the authenticated user (the limiter's default subject). */
export const toolRoutesRateLimit = () =>
  rateLimit({ limit: TOOL_ROUTES_HOURLY_LIMIT, windowMs: 60 * 60 * 1000, bucket: 'tools' });
