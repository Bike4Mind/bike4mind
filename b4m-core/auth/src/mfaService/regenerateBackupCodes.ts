import { IUserDocument, IUserRepository } from '@bike4mind/common';
import { generateBackupCodes, hashBackupCode, userHasMFAConfigured } from './utils';

export interface RegenerateBackupCodesRequest {
  user: IUserDocument;
}

export interface RegenerateBackupCodesResponse {
  backupCodes: string[];
  user: IUserDocument;
}

/**
 * Regenerate backup codes for a user with MFA enabled
 * This invalidates all existing backup codes and generates new ones
 */
export async function regenerateBackupCodes(
  { user }: RegenerateBackupCodesRequest,
  userRepository: Pick<IUserRepository, 'update'>
): Promise<RegenerateBackupCodesResponse> {
  if (!userHasMFAConfigured(user)) {
    throw new Error('MFA is not enabled for this user.');
  }
  // An empty secret on an authenticator-app user means the stored one could not be decrypted
  // (findByIdWithMfaSecrets), so the account's TOTP is broken: refuse rather than paper over it.
  if (user.mfa.totpEnabled && !user.mfa.totpSecret) {
    throw new Error('MFA secret is unavailable; backup codes cannot be regenerated.');
  }

  const newBackupCodes = generateBackupCodes();

  // Field-level write: a passkey-only user has no totpSecret, so a whole-`mfa` write would be
  // dropped by the user model's secret-less guard and the new codes never saved.
  const updatedUser = await userRepository.update({
    id: user.id,
    'mfa.backupCodes': newBackupCodes.map(hashBackupCode),
    updatedAt: new Date(),
  });

  if (!updatedUser) {
    throw new Error('Failed to regenerate backup codes.');
  }

  return {
    backupCodes: newBackupCodes, // plaintext — shown once; not stored
    user: updatedUser,
  };
}
