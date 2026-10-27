import { ApiKeyScope } from '@bike4mind/common';
import { persistedIsAdmin } from '@bike4mind/server-utils/auth/apiKeyAdminScope';
import { holdsApiKeyScope, type ScopedRequest } from '@server/middlewares/apiKeyScopeGate';

/**
 * True for an API key that reached a release-note route through release-notes:write rather than
 * admin:*. That scope is confined, so the key holds nothing else and gets only the job's narrow form.
 */
export const isReleaseNotesWriteOnlyKey = (req: ScopedRequest): boolean =>
  !!req.apiKeyInfo && !holdsApiKeyScope(req, [ApiKeyScope.ADMIN]);

/**
 * The admin guard for the release-note routes. A write-only key arrives with the owner's admin role
 * withheld, so it passes only when the owner was an admin, never merely for holding the scope.
 */
export const canAdministerReleaseNotes = (req: ScopedRequest & { user?: { isAdmin?: boolean } }): boolean =>
  !!req.user?.isAdmin || (isReleaseNotesWriteOnlyKey(req) && !!req.user && persistedIsAdmin(req.user));
