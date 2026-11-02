import { ACCOUNT_DELETION_PENDING_FLAG, accountDeletionDueAt, type IUserDocument } from '@bike4mind/common';
import { ACCOUNT_DELETION_PENDING_MESSAGE } from '@bike4mind/services/userService/accountState';
import type { Request, Response } from 'express';

// What a deletion-pending session may reach: restore, repeat the (idempotent) delete, sign out, and
// the reads the app shell needs to render the restore screen. Exact pathnames, as in auth.ts's MFA sets.
const DELETION_PENDING_ALLOWED_PATHS = new Set([
  '/api/users/me', // DELETE: a repeated request is a no-op
  '/api/users/me/restore-deletion',
  '/api/logout',
  '/api/identify',
  '/api/settings/fetch',
]);

function isDeletionPendingAllowedRoute(req: Request, userId: string): boolean {
  const path = req.url.split('?')[0];
  if (DELETION_PENDING_ALLOWED_PATHS.has(path)) return true;
  // auth/success bootstraps the current user from its own profile after a sign-in.
  return req.method === 'GET' && path === `/api/users/${userId}`;
}

/**
 * Confines a deletion-pending account to the restore-or-leave routes. Sign-in deliberately still works
 * for such an account (assertAccountStateUsable's allowDeletionPending on the JWT and refresh paths), so
 * this gate, not the login, is what keeps it out of the product during the grace period. 403, not 401,
 * so the client does not run its token-refresh cascade; the router sends the browser to the restore page.
 * API keys never reach here with such an account: apiKeyAuth refuses it outright.
 */
export function deletionPendingGate(req: Request, res: Response, next: (err?: unknown) => void): void {
  const user = req.user as Pick<IUserDocument, 'id' | 'deletionRequestedAt'> | undefined;
  if (!user?.deletionRequestedAt || isDeletionPendingAllowedRoute(req, user.id)) {
    return next();
  }
  req.logger?.info(`[AUTH] Blocked ${req.url} for user ${user.id}: account deletion pending.`);
  res.status(403).json({
    error: ACCOUNT_DELETION_PENDING_MESSAGE,
    error_description: 'Restore your account to keep using it, or sign out.',
    [ACCOUNT_DELETION_PENDING_FLAG]: true,
    deletionScheduledFor: accountDeletionDueAt(user.deletionRequestedAt).toISOString(),
    request_id: req.requestId,
  });
}
