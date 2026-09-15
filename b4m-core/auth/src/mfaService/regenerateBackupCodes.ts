import { IUserDocument, IUserRepository } from '@bike4mind/common';
import { generateBackupCodes, hashBackupCode } from './utils';

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
  if (!user.mfa || !user.mfa.totpEnabled) {
    throw new Error('MFA is not enabled for this user.');
  }

  const newBackupCodes = generateBackupCodes();
  const hashedBackupCodes = newBackupCodes.map(hashBackupCode);

  // Store hashed codes; return plaintext for one-time display.
  const updatedMFA = { ...user.mfa };
  updatedMFA.backupCodes = hashedBackupCodes;

  const updatedUser = await userRepository.update({
    id: user.id,
    mfa: updatedMFA,
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
