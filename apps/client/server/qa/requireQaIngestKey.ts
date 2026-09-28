import { ApiKeyScope, QA_INGEST_USER_TAG } from '@bike4mind/common';
import { ForbiddenError, UnauthorizedError } from '@server/utils/errors';

/**
 * The contract's scope gate lets JWT callers through (apiKeyOrJwt), so ingest
 * re-checks for an API key holding qa:ingest, AND a key owner carrying the
 * admin-set qa-ingest tag so only a designated service account can write runs.
 */
export function requireQaIngestKey(req: {
  apiKeyInfo?: { scopes: readonly string[] };
  user?: { tags?: readonly string[] | null };
}): void {
  if (!req.apiKeyInfo) throw new UnauthorizedError('API key required');
  if (!req.apiKeyInfo.scopes.includes(ApiKeyScope.QA_INGEST)) throw new ForbiddenError('Insufficient scope');
  if (!(req.user?.tags ?? []).includes(QA_INGEST_USER_TAG)) {
    throw new ForbiddenError('Key owner is not a QA ingest service user');
  }
}
