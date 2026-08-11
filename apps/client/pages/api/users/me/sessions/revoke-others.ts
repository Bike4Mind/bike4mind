import { ForbiddenError, UnprocessableEntityError } from '@bike4mind/common';
import { authSessionRepository } from '@bike4mind/database';
import { authSessionService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { isApiKeyAuth } from '@server/middlewares/apiKeyAuth';
import { logAuthAudit } from '@server/utils/authAudit';

/**
 * "Log out of all other devices" - revoke every one of the caller's sessions EXCEPT the one making
 * this request, so the current device stays signed in (the GitHub/Google/Slack model). Per-device
 * semantics: no tokenVersion bump, so the current session is untouched and the revoked devices lose
 * their refresh cookie immediately (their access tokens then lapse within one short TTL). The global
 * "sign out everywhere including this device" panic lever (a tokenVersion bump) stays on the admin
 * force-logout path (users/[id]/revoke-sessions.ts), not here.
 */
const handler = baseApi().post(async (req, res) => {
  // Revoking the customer's other sessions from an impersonated session would act on the real
  // customer's devices; the UI hides this while impersonating, and the server refuses it too.
  if (req.user.impersonatedBy) {
    throw new ForbiddenError('Cannot manage sessions while impersonating a user.');
  }
  // API keys authenticate before JWT and carry no browser session; without a current sid this would
  // revoke ALL of the owner's sessions (see the guard below), so refuse outright.
  if (isApiKeyAuth(req)) {
    throw new ForbiddenError('This action is not available to API-key callers.');
  }

  const currentSid = req.user.sid;
  if (!currentSid) {
    // Without the current session id we cannot keep THIS device signed in, and revoking all would
    // sign the caller out unexpectedly. A token refresh mints a sid-bearing token; ask them to retry.
    throw new UnprocessableEntityError('Cannot determine the current session.');
  }

  const revokedCount = await authSessionService.revokeAllUserSessions(
    req.user.id,
    { exceptSid: currentSid },
    { db: { authSessions: authSessionRepository }, logger: req.logger }
  );
  await logAuthAudit(req, { userId: req.user.id, event: 'session_revoked', actorUserId: req.user.id });
  return res.status(200).json({ message: 'Signed out of all other devices', revokedCount });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
