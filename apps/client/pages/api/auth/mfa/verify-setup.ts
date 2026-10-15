import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { mfaService, userService } from '@bike4mind/services';
import { userRepository, authSessionRepository, passkeyCredentialRepository } from '@bike4mind/database';
import { issueBrowserSession } from '@server/auth/issueSession';
import { logAuthAudit } from '@server/utils/authAudit';
import { logSecondFactorSignIn, readSignInOrigin } from '@server/auth/signInSecondFactor';
import { redactUserSecretsForSelf, selfUserResponseSchema } from '@bike4mind/common';
import { respond } from '@server/utils/respond';
import * as z from 'zod';

const tokenBodySchema = z.object({
  token: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{6,10}$/i, 'Invalid token format.'),
});

const verifySetupResponseSchema = z.object({
  success: z.boolean(),
  accessToken: z.string(),
  user: selfUserResponseSchema,
});

const handler = baseApi()
  // No rate limiting - using server-side lockout for stronger security
  .post(
    asyncHandler(async (req, res) => {
      const user = req.user;
      const { token: cleanToken } = tokenBodySchema.parse(req.body);

      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      if (readSignInOrigin(req.user)?.createdVia === 'emergency') {
        return res.status(403).json({ error: 'Authenticator enrollment is not available during emergency sign-in.' });
      }

      // Get fresh user data (incl. select:false MFA secrets) to verify setup + check lockout
      const freshUser = await userRepository.findByIdWithMfaSecrets(user.id);
      if (!freshUser) {
        return res.status(404).json({ error: 'User not found in database' });
      }

      // Server-side lockout check (can't be bypassed by refresh/cancel)
      if (mfaService.isUserLockedOut(freshUser)) {
        const remainingMinutes = mfaService.getLockoutTimeRemaining(freshUser);
        return res.status(423).json({
          error: `Too many failed attempts. Please try again in ${remainingMinutes} minutes.`,
          lockedUntil: freshUser.mfa?.lockedUntil,
          remainingMinutes,
        });
      }

      // Passkeys only satisfy MFA alongside an enabled TOTP, so any still on file while setup is
      // pending are orphans of an earlier MFA that a failed cleanup left behind. Purge them so a
      // fresh enrollment never revives them.
      if (!freshUser.mfa?.totpEnabled) {
        await passkeyCredentialRepository.removeAllForUser(freshUser.id);
      }

      let setupBody: unknown;
      try {
        // verifyMFASetup clears any failed-attempt/lockout state as part of its single
        // secret-preserving write - a separate clear here (built from the not-+selected
        // `result.user`) would wipe the select:false totpSecret/backupCodes and brick MFA.
        const result = await mfaService.verifyMFASetup(freshUser, cleanToken, userRepository);

        // Enabling MFA is a security-relevant change: revoke every existing session (bumps
        // tokenVersion AND clears session rows, so other devices can't silently refresh back in),
        // then mint a fresh session for THIS device with the new version.
        const newTokenVersion = await userService.revokeUserSessions(result.user.id, {
          db: { users: userRepository, authSessions: authSessionRepository },
          logger: req.logger,
        });
        // Enrollment that finishes a sign-in (enforceMFA) is that sign-in's session, so it keeps
        // the first-factor origin exactly as completeMfaLogin does. Enrolling from an existing
        // session carries no origin, and there the session is the enrollment itself.
        const signInOrigin = readSignInOrigin(req.user);
        const { accessToken } = await issueBrowserSession(req, res, result.user.id, {
          createdVia: signInOrigin?.createdVia ?? 'mfa-setup',
          tokenVersion: newTokenVersion,
        });
        const tokens = { accessToken };

        await logAuthAudit(req, { userId: result.user.id, event: 'mfa_enrolled' });
        if (signInOrigin) await logSecondFactorSignIn(req, result.user.id, signInOrigin);

        setupBody = {
          success: result.success,
          ...tokens,
          user: redactUserSecretsForSelf(result.user),
        };
      } catch (error: unknown) {
        // Atomically increment the failed-attempt counter (mirrors mfa/verify.ts) - a
        // read-modify-write lets concurrent requests each read the same count and all write
        // count+1, letting an attacker batch requests to defeat the 3-strike lockout.
        const updatedUser = await userRepository.atomicRecordMfaFailedAttempt(freshUser.id);

        if (updatedUser && mfaService.isUserLockedOut(updatedUser)) {
          const remainingMinutes = mfaService.getLockoutTimeRemaining(updatedUser);
          return res.status(423).json({
            error: `Too many failed attempts. Please try again in ${remainingMinutes} minutes.`,
            lockedUntil: updatedUser.mfa?.lockedUntil,
            remainingMinutes,
          });
        }

        const remainingAttempts = mfaService.MAX_FAILED_ATTEMPTS - (updatedUser?.mfa?.failedAttempts ?? 0);
        const errMessage = error instanceof Error ? error.message : 'Invalid MFA code';
        return res.status(400).json({
          error: errMessage,
          attemptsRemaining: remainingAttempts,
          failedAttempts: updatedUser?.mfa?.failedAttempts ?? 0,
        });
      }

      // Outside the try: a response-boundary failure is our bug and must not be booked as a
      // failed MFA attempt by the catch above.
      return respond(res, verifySetupResponseSchema, setupBody);
    })
  );

export default handler;
