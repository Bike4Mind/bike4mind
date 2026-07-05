import { IUserDocument, IUserRepository } from '@bike4mind/common';
import {
  generateTOTPSetup,
  generateBackupCodes,
  hashBackupCode,
  userEligibleForMFA,
  clearFailedAttempts,
} from './utils';

export interface SetupMFARequest {
  user: IUserDocument;
  appName?: string;
}

export interface SetupMFAResponse {
  secret: string;
  qrCodeUrl: string;
  manualEntryKey: string;
  backupCodes: string[];
}

/**
 * Set up MFA for a user
 * This generates the secret and backup codes but doesn't enable MFA yet
 * The user must verify the setup before MFA is enabled
 */
export async function setupMFA(
  { user, appName = process.env.APP_NAME || '' }: SetupMFARequest, // no brand fallback
  userRepository: Pick<IUserRepository, 'update'>
): Promise<SetupMFAResponse> {
  if (!userEligibleForMFA(user)) {
    throw new Error('User is not eligible for MFA setup.');
  }

  if (user.mfa && user.mfa.totpEnabled) {
    throw new Error('MFA is already enabled for this user.');
  }

  // Clear any previous incomplete setup
  if (user.mfa && user.mfa.totpEnabled === false) {
    user.mfa = null;
  }

  const email = user.email || '';
  const setup = await generateTOTPSetup(email, appName);
  const backupCodes = generateBackupCodes();
  const hashedBackupCodes = backupCodes.map(hashBackupCode);

  // Store hashed codes; return plaintext codes to the caller for one-time display.
  const updatedUser = await userRepository.update({
    id: user.id,
    mfa: {
      totpSecret: setup.secret,
      totpEnabled: false,
      backupCodes: hashedBackupCodes,
      setupAt: new Date(),
      lastUsedAt: undefined,
    },
    updatedAt: new Date(),
  });

  if (!updatedUser) {
    throw new Error('Failed to save MFA setup data.');
  }

  return {
    secret: setup.secret,
    qrCodeUrl: setup.qrCodeUrl,
    manualEntryKey: setup.manualEntryKey,
    backupCodes, // plaintext — shown once at setup; not stored
  };
}

/**
 * Verify MFA setup and enable MFA for the user
 */
export async function verifyMFASetup(
  user: IUserDocument,
  token: string,
  userRepository: Pick<IUserRepository, 'update'>
): Promise<{ success: boolean; user: IUserDocument }> {
  if (!user.mfa || !user.mfa.totpSecret) {
    throw new Error('No MFA setup in progress for this user.');
  }

  if (user.mfa.totpEnabled) {
    throw new Error('MFA is already enabled for this user.');
  }

  // Import the verification function here to avoid circular dependencies
  const { verifyTOTPToken } = await import('./utils');

  if (!verifyTOTPToken(user.mfa.totpSecret, token)) {
    throw new Error('Invalid TOTP code.');
  }

  // Enable MFA. `user` came from findByIdWithMfaSecrets and carries the select:false
  // totpSecret + backupCodes; build the write from it - and clear any failed-attempt/lockout
  // state in this SAME write - so the secrets survive. Clearing from this function's
  // (not-+selected) return value would omit and `$set`-replace-wipe the secrets, leaving
  // totpEnabled:true with no secret and permanently bricking sign-in.
  const updatedMFA = clearFailedAttempts(user);
  updatedMFA.totpEnabled = true;
  updatedMFA.lastUsedAt = new Date();

  const updatedUser = await userRepository.update({
    id: user.id,
    mfa: updatedMFA,
    updatedAt: new Date(),
  });

  if (!updatedUser) {
    throw new Error('Failed to enable MFA.');
  }

  return { success: true, user: updatedUser };
}

/**
 * Cancel MFA setup for a user
 */
export async function cancelMFASetup(
  user: IUserDocument,
  userRepository: Pick<IUserRepository, 'update'>
): Promise<{ success: boolean }> {
  if (!user.mfa) {
    throw new Error('No MFA setup in progress to cancel.');
  }

  if (user.mfa.totpEnabled) {
    throw new Error('Cannot cancel MFA setup - MFA is already enabled. Use disable instead.');
  }

  const updatedUser = await userRepository.update({
    id: user.id,
    mfa: null,
  });

  if (!updatedUser) {
    throw new Error('Failed to cancel MFA setup.');
  }

  return { success: true };
}
