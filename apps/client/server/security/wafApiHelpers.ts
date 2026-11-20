/**
 * Shared request-parsing helpers for WAF security dashboard API handlers.
 *
 * Extracted from the individual handlers to eliminate duplication and ensure
 * all validation rules (including the max date range guard) are applied consistently.
 */

import type { Request } from 'express';
import { isFullAdmin } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { type WafRangeInput, type WafTrafficRange } from '@bike4mind/server-utils/security/wafSharedHelpers';

/** Maximum allowed span for a custom date range (30 days). */
const MAX_CUSTOM_RANGE_MS = 30 * 24 * 60 * 60 * 1000;

export function isWafTrafficRange(value: unknown): value is WafTrafficRange {
  return value === '1h' || value === '24h' || value === '7d';
}

/**
 * Parse and validate the `range`, `start`, and `end` query params from an API request.
 *
 * Accepted forms:
 *   - `?range=1h` / `?range=24h` / `?range=7d`  -> preset WafTrafficRange
 *   - `?range=custom&start=<ISO>&end=<ISO>`       -> WafCustomRange (max 30 days)
 *
 * Returns `{ range }` on success or `{ range: null, error: string }` on failure.
 */
export function parseRangeParam(req: Request): { range: WafRangeInput | null; error?: string } {
  const rawRange = req.query.range;

  if (rawRange === 'custom') {
    const start = typeof req.query.start === 'string' ? req.query.start : '';
    const end = typeof req.query.end === 'string' ? req.query.end : '';

    if (!start || !end) {
      return { range: null, error: 'Custom range requires start and end query params (ISO 8601).' };
    }

    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();

    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      return { range: null, error: 'start and end must be valid ISO 8601 timestamps.' };
    }
    if (startMs >= endMs) {
      return { range: null, error: 'start must be before end.' };
    }
    if (endMs - startMs > MAX_CUSTOM_RANGE_MS) {
      return { range: null, error: 'Custom range cannot exceed 30 days.' };
    }

    return { range: { start, end } };
  }

  if (rawRange !== undefined && !isWafTrafficRange(rawRange)) {
    return { range: null, error: 'Invalid range. Must be one of: 1h, 24h, 7d, custom.' };
  }

  return { range: isWafTrafficRange(rawRange) ? rawRange : '24h' };
}

// The dashboard fetches each WAF view once per range change or Refresh (no polling), so 20 a minute
// is headroom for a reader while bounding the CloudWatch spend a delegated reader can start:
// every new custom range misses the per-instance cache in wafQueryCache.ts.
export const WAF_QUERY_RATE_LIMIT = 20;

/** Per-user limit for a billed WAF read, full admins exempt; chain it after adminApi so it keys on the user. */
export const wafQueryRateLimit = (bucket: string) =>
  rateLimit({
    limit: req => (isFullAdmin(req.user) ? Infinity : WAF_QUERY_RATE_LIMIT),
    windowMs: 60 * 1000,
    bucket,
  });

/**
 * Debug skips the query cache and returns internal metadata, so it stays off in production and is
 * limited to full admins elsewhere.
 */
export function isWafDebugRequest(req: Request, stage: string): boolean {
  return stage !== 'production' && isFullAdmin(req.user) && req.query.debug === 'true';
}
