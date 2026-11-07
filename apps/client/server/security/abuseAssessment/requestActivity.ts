import { RISK_EVIDENCE_WINDOW_DAYS, type AbuseAssessmentRequestActivity } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { readApiRequests, type ApiRequestRow } from '@server/utils/userApiRequests';
import { resolveRequestPathname } from '@server/utils/resolveRouteTemplate';

export const REQUEST_ACTIVITY_SCAN_LIMIT = 200;

export function summarizeRequestRows(rows: ApiRequestRow[]): AbuseAssessmentRequestActivity {
  const kept = rows.slice(0, REQUEST_ACTIVITY_SCAN_LIMIT);
  const count = (predicate: (row: ApiRequestRow) => boolean) => kept.filter(predicate).length;
  const pathname = (row: ApiRequestRow) => resolveRequestPathname({ originalUrl: row.endpoint, url: row.endpoint });
  return {
    status: 'observed',
    coverage: 'partial_api_key_log',
    windowDays: RISK_EVIDENCE_WINDOW_DAYS,
    sampleCount: kept.length,
    truncated: rows.length > REQUEST_ACTIVITY_SCAN_LIMIT,
    successful: count(row => row.statusCode >= 200 && row.statusCode < 300),
    unauthorized: count(row => row.statusCode === 401),
    forbidden: count(row => row.statusCode === 403),
    rateLimited: count(row => row.statusCode === 429),
    serverErrors: count(row => row.statusCode >= 500 && row.statusCode < 600),
    successfulIdentityChecks: count(
      row => row.method === 'GET' && pathname(row) === '/api/v1/me' && row.statusCode === 200
    ),
    adminRequests: count(row => /^\/api\/admin(?:\/|$)/.test(pathname(row))),
  };
}

export async function collectRequestActivity(userId: string, logger: Logger): Promise<AbuseAssessmentRequestActivity> {
  const now = new Date();
  try {
    const rows = await readApiRequests(userId, {
      limit: REQUEST_ACTIVITY_SCAN_LIMIT,
      range: { from: new Date(now.getTime() - RISK_EVIDENCE_WINDOW_DAYS * 86_400_000), to: now },
    });
    return summarizeRequestRows(rows);
  } catch (error) {
    logger.warn('Abuse assessment API request evidence failed', {
      userId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return { status: 'failed' };
  }
}
