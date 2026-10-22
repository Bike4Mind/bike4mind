import { ApiKeyScope } from '@bike4mind/common';
import { holdsApiKeyScope, type ScopedRequest } from '@server/middlewares/apiKeyScopeGate';

/**
 * True for an API key that reached a release-note route through release-notes:write rather than
 * admin:*. That scope is confined, so the key holds nothing else and gets only the job's narrow form.
 */
export const isReleaseNotesWriteOnlyKey = (req: ScopedRequest): boolean =>
  !!req.apiKeyInfo && !holdsApiKeyScope(req, [ApiKeyScope.ADMIN]);
