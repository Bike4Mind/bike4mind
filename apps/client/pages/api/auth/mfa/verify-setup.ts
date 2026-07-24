import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { mfaService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { logAuthAudit } from '@server/utils/authAudit';
import { redactUserSecretsForSelf } from '@bike4mind/common';

const handler = baseApi()
  // No rate limiting - using server-side lockout for stronger security
  .post(
    asyncHandler(async (req, res) => {
      const user = req.user;
      const { token } = req.body as { token?: string };

      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      if (!token || typeof token !== 'string') {
        return res.status(400).json({ error: 'Valid token is required' });
      }

      // Basic token format validation
      const cleanToken = token.trim();
      if (!/^[A-Z0-9]{6,10}$/i.test(cleanToken)) {
        return res.status(400).json({ error: 'Invalid token format.' });
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

      try {
        // verifyMFASetup clears any failed-attempt/lockout state as part of its single
        // secret-preserving write - a separate clear here (built from the not-+selected
        // `result.user`) would wipe the select:false totpSecret/backupCodes and brick MFA.
        const result = await mfaService.verifyMFASetup(freshUser, cleanToken, userRepository);

        // Enabling MFA is a security-relevant change: bump tokenVersion to
        // invalidate any other active sessions. Mint the completion token with
        // the new version so this session stays valid.
        const newTokenVersion = await userRepository.incrementTokenVersion(result.user.id);
        const tokens = authTokenGenerator.createAccessToken(result.user.id, newTokenVersion);

        await logAuthAudit(req, { userId: result.user.id, event: 'mfa_enrolled' });

        res.json({
          ...result,
          ...tokens,
          user: redactUserSecretsForSelf(result.user),
        });
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

        const remainingAttempts = 3 - (updatedUser?.mfa?.failedAttempts ?? 0);
        const errMessage = error instanceof Error ? error.message : 'Invalid MFA code';
        res.status(400).json({
          error: errMessage,
          attemptsRemaining: remainingAttempts,
          failedAttempts: updatedUser?.mfa?.failedAttempts ?? 0,
        });
      }
    })
  );

export default handler;
