import { AuthEvents, IUserDocument } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { logEvent } from '@server/utils/analyticsLog';
import { logAuthAudit } from '@server/utils/authAudit';
import { baseApi } from '@server/middlewares/baseApi';
import { isApiKeyAuth } from '@server/middlewares/apiKeyAuth';

const handler = baseApi().get(async (req, res) => {
  const user = req.user as IUserDocument & { impersonatedBy?: string };
  const userId = user?.id;

  await userService.updateLogoutTime(userId, { db: { users: userRepository }, logger: req.logger });
  // Revoke the session server-side, not just client-side: bump tokenVersion so the logged-out
  // token (and any other device's token for this user) is rejected on its next request. Without
  // this, a token captured before logout stays valid until its natural TTL. All-device by design
  // (tokens carry no session id); per-device revocation would need a session store (tracked separately).
  //
  // Two callers must NOT trigger a revoke:
  //  - API-key requests: apiKeyAuth authenticates before JWT, so any key (any scope) hitting this
  //    endpoint would otherwise become an account-wide session kill switch for the key's owner.
  //  - Impersonating admins: revoking here bumps the *customer's* tokenVersion, force-logging the
  //    real customer out on every device. Impersonation ends via "Return to safety", not logout.
  if (userId && !isApiKeyAuth(req) && !user?.impersonatedBy) {
    await userService.revokeUserSessions(userId, { db: { users: userRepository }, logger: req.logger });
  }
  await logEvent({ userId, type: AuthEvents.LOGOUT }, { ability: req.ability });
  if (userId) await logAuthAudit(req, { userId, event: 'logout' });
  return res.status(200).json({ message: 'Logged out' });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
