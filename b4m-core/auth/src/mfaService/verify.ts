import { IUserDocument, IUserRepository } from '@bike4mind/common';
import { verifyTOTPToken, verifyBackupCode, clearFailedAttempts } from './utils';

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
 * Verify MFA token (TOTP or backup code) for a user during login
 */
export async function verifyMFA(
  { user, token }: VerifyMFARequest,
  userRepository: Pick<IUserRepository, 'update'>
): Promise<VerifyMFAResponse> {
  if (!user.mfa || !user.mfa.totpEnabled) {
    throw new Error('MFA is not enabled for this user.');
  }

  let usedBackupCode: string | undefined;
  let isValid = false;

  // Try TOTP first
  if (verifyTOTPToken(user.mfa.totpSecret, token)) {
    isValid = true;
  } else {
    // Try backup codes
    const backupResult = verifyBackupCode(user.mfa.backupCodes, token);
    if (backupResult.isValid) {
      isValid = true;
      usedBackupCode = backupResult.usedBackupCode;
    }
  }

  if (!isValid) {
    throw new Error('Invalid TOTP or backup code.');
  }

  // Build the write from `user` (loaded via findByIdWithMfaSecrets, so it carries the
  // select:false totpSecret + backupCodes) and clear the failed-attempt/lockout state in
  // this SAME write. Clearing must happen here, not from this function's return value: the
  // repository echo is not +selected, so a caller-side `update({ mfa })` built from it would
  // omit - and thus `$set`-replace-wipe - the plaintext secrets, permanently bricking MFA.
  const updatedMFA = clearFailedAttempts(user);
  updatedMFA.lastUsedAt = new Date();

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
