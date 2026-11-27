import { ApiKeyScope, ForbiddenError } from '@bike4mind/common';
import { requireAdminPermission } from '@server/middlewares/adminApi';
import { persistedIsAdmin } from '@bike4mind/server-utils/auth/apiKeyAdminScope';
import { holdsApiKeyScope, type ScopedRequest } from '@bike4mind/server-utils/middlewares/apiKeyScopeGate';

/**
 * True for an API key that reached a release-note route through release-notes:write rather than
 * admin:*. That scope is confined, so the key holds nothing else and gets only the job's narrow form.
 */
export const isReleaseNotesWriteOnlyKey = (req: ScopedRequest): boolean =>
  !!req.apiKeyInfo && !holdsApiKeyScope(req, [ApiKeyScope.ADMIN]);

type ReleaseNotesRequest = ScopedRequest & {
  user?: { isAdmin?: boolean | null; adminPermissions?: readonly string[] | null };
  apiKeyInfo?: { scopes: readonly string[] };
};

/**
 * The admin guard for the release-note routes: `settings:manage`, or the release-notes job key. That key
 * arrives with the owner's admin role withheld, so it passes only when the owner is a full admin, never
 * merely for holding the scope.
 */
export function assertCanAdministerReleaseNotes(req: ReleaseNotesRequest): void {
  if (!isReleaseNotesWriteOnlyKey(req)) {
    requireAdminPermission(req, 'settings:manage');
    return;
  }
  if (!req.user || !persistedIsAdmin(req.user)) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }
}
