import { IUserDocument, IUserRepository } from '@bike4mind/common';
import { generateTOTPSetup, generateBackupCodes, hashBackupCode, userEligibleForMFA } from './utils';
import { claimTOTPCode, MfaAttemptRejectedError, withReservedMfaAttempt, type MfaAttemptRepository } from './attempt';

export interface SetupMFARequest {
  user: IUserDocument;
  appName?: string;
}

/**
 * How long an unconfirmed TOTP secret is re-served by setupMFA. Bounded so a secret handed to a
 * briefly hijacked session cannot become the factor the real user enrolls days later.
 */
export const PENDING_SECRET_REUSE_MS = 60 * 60 * 1000;

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

  // A repeat call (reload, second tab, step-up retry) keeps a recent unconfirmed secret, so the
  // QR code the user already scanned stays valid. Needs the user loaded via findByIdWithMfaSecrets.
  const pending = user.mfa && user.mfa.totpEnabled === false ? user.mfa : null;
  const reusableSecret =
    pending?.totpSecret && Date.now() - new Date(pending.setupAt).getTime() < PENDING_SECRET_REUSE_MS
      ? pending.totpSecret
      : undefined;

  const email = user.email || '';
  const setup = await generateTOTPSetup(email, appName, reusableSecret);
  const backupCodes = generateBackupCodes();
  const hashedBackupCodes = backupCodes.map(hashBackupCode);

  // Store hashed codes; return plaintext codes to the caller for one-time display.
  const updatedUser = await userRepository.update({
    id: user.id,
    mfa: {
      totpSecret: setup.secret,
      totpEnabled: false,
      backupCodes: hashedBackupCodes,
      // Kept on reuse so repeat calls cannot stretch the reuse window indefinitely.
      setupAt: reusableSecret && pending ? pending.setupAt : new Date(),
      lastUsedAt: undefined,
    },
    // The step counter is a global clock, not tied to this secret: clear it so a code from the
    // NEW secret is not refused as a replay of one claimed before re-enrollment.
    totpLastStep: null,
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
  userRepository: Pick<IUserRepository, 'atomicEnableMfa'> & MfaAttemptRepository
): Promise<{ success: boolean; user: IUserDocument }> {
  if (!user.mfa || !user.mfa.totpSecret) {
    throw new Error('No MFA setup in progress for this user.');
  }

  if (user.mfa.totpEnabled) {
    throw new Error('MFA is already enabled for this user.');
  }

  const mfa = user.mfa;
  return withReservedMfaAttempt(user.id, userRepository, async attemptState => {
    if ((await claimTOTPCode(user.id, mfa.totpSecret, token, userRepository)) === null) {
      throw new MfaAttemptRejectedError('Invalid TOTP code.', attemptState);
    }

    // Field-level write, NOT a whole-`mfa` `$set`: rebuilding the subdocument from `user` (or,
    // worse, from a secret-less echo) risks wiping the select:false totpSecret/backupCodes and
    // would clear attempts reserved since the snapshot. Enabling MFA plus clearing the
    // attempt/lockout state touches only those fields, leaving the secrets untouched. It is
    // conditional on the verified secret so a setup that replaced it in the meantime is not
    // enabled behind the user's back.
    const updatedUser = await userRepository.atomicEnableMfa(user.id, mfa.totpSecret);

    if (!updatedUser) {
      throw new MfaAttemptRejectedError('MFA setup changed. Please restart enrollment.', attemptState);
    }

    return { success: true, user: updatedUser };
  });
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
