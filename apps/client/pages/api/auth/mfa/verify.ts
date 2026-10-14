import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { mfaService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database';
import { completeMfaLogin } from '@server/auth/completeMfaLogin';
import { redactUserSecretsForSelf } from '@bike4mind/common';
import * as z from 'zod';

const tokenBodySchema = z.object({
  token: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{6,10}$/i, 'Invalid token format.'),
  rememberDevice: z.boolean().optional(),
});

const handler = baseApi() // Now requires authentication
  // No rate limiting - using 3-strike abort for stronger security
  .post(
    asyncHandler(async (req, res) => {
      const user = req.user;
      const { token: cleanToken, rememberDevice } = tokenBodySchema.parse(req.body);

      if (!user) {
        return res.status(401).json({ error: 'Authentication required.' });
      }

      // Get fresh user data (incl. select:false MFA secrets) to verify the code + check lockout
      const freshUser = await userRepository.findByIdWithMfaSecrets(user.id);
      if (!freshUser) {
        return res.status(400).json({ error: 'User not found.' });
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
        if (!freshUser.mfa || !freshUser.mfa.totpEnabled) {
          return res.status(400).json({ error: 'MFA is not enabled for this user.' });
        }

        // verifyMFA clears any failed-attempt/lockout state as part of its single
        // secret-preserving write - a separate clear here (built from the not-+selected
        // `result.user`) would wipe the select:false totpSecret/backupCodes.
        const result = await mfaService.verifyMFA({ user: freshUser, token: cleanToken }, userRepository);

        const { accessToken, deviceRemembered } = await completeMfaLogin(req, res, result.user, { rememberDevice });

        res.json({
          verified: true,
          usedBackupCode: result.usedBackupCode,
          deviceRemembered,
          accessToken,
          user: redactUserSecretsForSelf(result.user),
        });
      } catch (error: unknown) {
        // Atomically increment the failed-attempt counter - concurrent requests each reading
        // the same count and all writing count+1 would let an attacker batch many concurrent
        // requests and defeat the 3-strike lockout. $inc + pipeline update is one atomic op.
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
        const errMessage = error instanceof Error ? error.message : 'MFA verification failed';
        res.status(400).json({
          error: errMessage,
          attemptsRemaining: remainingAttempts,
          failedAttempts: updatedUser?.mfa?.failedAttempts ?? 0,
        });
      }
    })
  );

export default handler;
