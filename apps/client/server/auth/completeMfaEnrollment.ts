import type { Response } from 'express';
import type { IUserDocument } from '@bike4mind/common';
import { MfaEnrollmentEvents } from '@bike4mind/common';
import { userService } from '@bike4mind/services';
import { userRepository, authSessionRepository, realtimeConnectionRepository } from '@bike4mind/database';
import { issueBrowserSession } from '@server/auth/issueSession';
import { logAuthAudit } from '@server/utils/authAudit';
import { logSecondFactorSignIn, readSignInOrigin } from '@server/auth/signInSecondFactor';
import { recordForcedEnrollmentStep } from '@server/auth/mfaEnrollmentFunnel';

/**
 * What every first-factor enrollment does once the factor is saved, whichever factor it was
 * (authenticator app in verify-setup, passkey in passkey/register). `userBeforeEnrollment` must be
 * read before the factor was saved, so a forced enrollment still counts as forced in the funnel.
 * Returns the access token of the fresh session minted for this device.
 */
export async function completeMfaEnrollment(
  // Borrowed from logAuthAudit: route handlers narrow the Request generics differently.
  req: Parameters<typeof logAuthAudit>[0],
  res: Response,
  userBeforeEnrollment: IUserDocument
): Promise<{ accessToken: string }> {
  const userId = userBeforeEnrollment.id;
  // Enabling MFA is a security-relevant change: revoke every existing session (bumps
  // tokenVersion AND clears session rows, so other devices can't silently refresh back in),
  // then mint a fresh session for THIS device with the new version.
  const newTokenVersion = await userService.revokeUserSessions(userId, {
    db: {
      users: userRepository,
      authSessions: authSessionRepository,
      realtimeConnections: realtimeConnectionRepository,
    },
    logger: req.logger,
  });
  // Enrollment that finishes a sign-in (enforceMFA) is that sign-in's session, so it keeps
  // the first-factor origin exactly as completeMfaLogin does. Enrolling from an existing
  // session carries no origin, and there the session is the enrollment itself.
  const signInOrigin = readSignInOrigin(req.user);
  const { accessToken } = await issueBrowserSession(req, res, userId, {
    createdVia: signInOrigin?.createdVia ?? 'mfa-setup',
    tokenVersion: newTokenVersion,
  });

  await logAuthAudit(req, { userId, event: 'mfa_enrolled' });
  await recordForcedEnrollmentStep(req, userBeforeEnrollment, MfaEnrollmentEvents.COMPLETED);
  if (signInOrigin) await logSecondFactorSignIn(req, userId, signInOrigin);
  return { accessToken };
}
