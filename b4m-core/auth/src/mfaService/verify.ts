import { IUserDocument, IUserRepository } from '@bike4mind/common';
import { verifyBackupCode } from './utils';
import { claimTOTPCode, MfaAttemptRejectedError, withReservedMfaAttempt, type MfaAttemptRepository } from './attempt';

export interface VerifyMFARequest {
  user: IUserDocument;
  token: string;
}

export interface VerifyMFAResponse {
  verified: boolean;
  usedBackupCode?: string;
  user: IUserDocument;
}

/**
 * Verify MFA token (TOTP or backup code) for a user during login. The attempt is counted toward
 * the lockout before the code is compared; a refusal throws MfaAttemptRejectedError.
 */
export async function verifyMFA(
  { user, token }: VerifyMFARequest,
  userRepository: Pick<IUserRepository, 'update'> & MfaAttemptRepository
): Promise<VerifyMFAResponse> {
  if (!user.mfa || !user.mfa.totpEnabled) {
    throw new Error('MFA is not enabled for this user.');
  }

  const mfa = user.mfa;
  return withReservedMfaAttempt(user.id, userRepository, async attemptState => {
    let usedBackupCode: string | undefined;
    const totpStep = await claimTOTPCode(user.id, mfa.totpSecret, token, userRepository);
    if (totpStep === null) {
      const backupResult = verifyBackupCode(mfa.backupCodes, token);
      if (!backupResult.isValid || !backupResult.usedBackupCode) {
        throw new MfaAttemptRejectedError('Invalid TOTP or backup code.', attemptState);
      }
      // Consume the matched code atomically: only the request that pulls it from the stored set
      // accepts it, so one code cannot sign in twice and a code spent by a concurrent request is
      // not re-accepted from this pre-reservation snapshot.
      const consumed = await userRepository.atomicConsumeBackupCode(user.id, backupResult.usedBackupCode);
      if (!consumed) {
        throw new MfaAttemptRejectedError('Invalid TOTP or backup code.', attemptState);
      }
      usedBackupCode = backupResult.usedBackupCode;
    }

    // Field-level write, NOT a whole-`mfa` `$set`. Replacing the subdocument would rebuild
    // `backupCodes` from this pre-reservation snapshot - restoring a code a concurrent request
    // just spent - and erase attempts reserved since the snapshot; it would also risk writing a
    // secret-less `mfa` and wiping the select:false totpSecret/backupCodes. Touching only the
    // attempt/lockout fields leaves both the secrets and concurrent claims untouched.
    const updatedUser = await userRepository.update(
      {
        id: user.id,
        'mfa.failedAttempts': 0,
        'mfa.lastUsedAt': new Date(),
        updatedAt: new Date(),
      },
      { unset: ['mfa.lastFailedAttempt', 'mfa.lockedUntil'] }
    );

    if (!updatedUser) {
      throw new Error('Failed to update user MFA data');
    }

    return { verified: true, usedBackupCode, user: updatedUser };
  });
}
