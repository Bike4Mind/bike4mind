import { resolveApiCompletionSource, type ApiKeyCompletionSource } from '@bike4mind/common';
import type { IncomingHttpHeaders } from 'http';
import { flattenHeaders } from '@server/utils/flattenHeaders';

/**
 * The `source` a public API route stamps on its UsageEvent and ledger rows: `cli` for the b4m CLI,
 * else `api`. The same classifier apiKeyAuth stamps on ApiKeyUsageLog, so the admin dashboard's
 * credit sections and endpoint section filter the same slice - keep the two on one rule.
 */
export const resolveRequestUsageSource = (req: { headers: IncomingHttpHeaders }): ApiKeyCompletionSource =>
  resolveApiCompletionSource(flattenHeaders(req.headers));
