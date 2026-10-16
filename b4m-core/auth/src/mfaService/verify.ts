import { IUserDocument, IUserRepository } from '@bike4mind/common';
import { verifyBackupCode, clearFailedAttempts } from './utils';
import { claimTOTPCode, MfaAttemptRejectedError, reserveMfaAttempt, type MfaAttemptRepository } from './attempt';

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

  const attemptState = await reserveMfaAttempt(user.id, userRepository);

  let usedBackupCode: string | undefined;
  const totpStep = await claimTOTPCode(user.id, user.mfa.totpSecret, token, userRepository);
  if (totpStep === null) {
    const backupResult = verifyBackupCode(user.mfa.backupCodes, token);
    if (!backupResult.isValid) {
      throw new MfaAttemptRejectedError('Invalid TOTP or backup code.', attemptState);
    }
    usedBackupCode = backupResult.usedBackupCode;
  }

  // Build the write from `user` (loaded via findByIdWithMfaSecrets, so it carries the
  // select:false totpSecret + backupCodes) and clear the failed-attempt/lockout state in
  // this SAME write. Clearing must happen here, not from this function's return value: the
  // repository echo is not +selected, so a caller-side `update({ mfa })` built from it would
  // omit - and thus `$set`-replace-wipe - the plaintext secrets, permanently bricking MFA.
  const updatedMFA = clearFailedAttempts(user.mfa);
  updatedMFA.lastUsedAt = new Date();
  // This write replaces the whole subdocument, so it must carry the step just claimed.
  if (totpStep !== null) updatedMFA.lastTotpStep = totpStep;

  // Remove used backup code if applicable
  if (usedBackupCode) {
    updatedMFA.backupCodes = user.mfa.backupCodes.filter(code => code !== usedBackupCode);
  }

  const updateData = {
    id: user.id,
    mfa: updatedMFA,
    updatedAt: new Date(),
  };

  const updatedUser = await userRepository.update(updateData);

  if (!updatedUser) {
    throw new Error('Failed to update user MFA data');
  }

  return {
    verified: true,
    usedBackupCode,
    user: updatedUser,
  };
}
