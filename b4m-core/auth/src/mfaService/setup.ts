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

  // A repeat call (reload, second tab, step-up retry) re-serves a recent unconfirmed secret AND its
  // backup codes, so the QR code scanned and the codes saved from the first call both stay valid.
  // Needs the user loaded via findByIdWithMfaSecrets. Rows missing either value get a fresh pair
  // (as does a passkey-only user adding an app, who has no secret to re-serve).
  const pending = user.mfa && user.mfa.totpEnabled === false ? user.mfa : null;
  const pendingCodes = pending?.pendingBackupCodes?.split(',').filter(Boolean) ?? [];
  const reused =
    pending?.totpSecret &&
    pendingCodes.length > 0 &&
    Date.now() - new Date(pending.setupAt).getTime() < PENDING_SECRET_REUSE_MS
      ? { secret: pending.totpSecret, backupCodes: pendingCodes, setupAt: pending.setupAt }
      : null;

  const email = user.email || '';
  const setup = await generateTOTPSetup(email, appName, reused?.secret);
  const backupCodes = reused?.backupCodes ?? generateBackupCodes();
  const hashedBackupCodes = backupCodes.map(hashBackupCode);

  // The step counter is a global clock, not tied to this secret: clear it so a code from a NEW
  // secret is not refused as a replay. Kept on reuse, where clearing it would let a code already
  // claimed by a concurrent verify be accepted again.
  const stepReset = reused ? {} : { totpLastStep: null };

  // Store hashed codes for verification; the plaintext copy lives only until enable clears it.
  // Kept on reuse so repeat calls cannot stretch the reuse window indefinitely.
  const setupAt = reused ? reused.setupAt : new Date();
  const updatedUser = user.mfa?.passkeyEnabled
    ? // A passkey-only user adding an app already has a factor. Field-level writes leave its backup
      // codes, attempt counter and lockout live until the app is confirmed; verifyMFASetup swaps
      // the new codes in at enable, so an abandoned setup costs the user nothing.
      await userRepository.update({
        id: user.id,
        'mfa.totpSecret': setup.secret,
        'mfa.totpEnabled': false,
        'mfa.pendingBackupCodes': backupCodes.join(','),
        'mfa.setupAt': setupAt,
        ...stepReset,
        updatedAt: new Date(),
      })
    : await userRepository.update({
        id: user.id,
        mfa: {
          totpSecret: setup.secret,
          totpEnabled: false,
          passkeyEnabled: false,
          backupCodes: hashedBackupCodes,
          pendingBackupCodes: backupCodes.join(','),
          setupAt,
          lastUsedAt: undefined,
        },
        ...stepReset,
        updatedAt: new Date(),
      });

  if (!updatedUser) {
    throw new Error('Failed to save MFA setup data.');
  }

  return {
    secret: setup.secret,
    qrCodeUrl: setup.qrCodeUrl,
    manualEntryKey: setup.manualEntryKey,
    backupCodes, // plaintext; re-served by a repeat call until enable
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

  const { totpSecret } = user.mfa;
  return withReservedMfaAttempt(user.id, userRepository, async attemptState => {
    if ((await claimTOTPCode(user.id, totpSecret, token, userRepository)) === null) {
      throw new MfaAttemptRejectedError('Invalid TOTP code.', attemptState);
    }

    // Field-level write, NOT a whole-`mfa` `$set`: rebuilding the subdocument from `user` (or,
    // worse, from a secret-less echo) risks wiping the select:false totpSecret/backupCodes and
    // would clear attempts reserved since the snapshot. Enabling MFA plus clearing the
    // attempt/lockout state touches only those fields, leaving the secrets untouched. It is
    // conditional on the verified secret so a setup that replaced it in the meantime is not
    // enabled behind the user's back.
    // A passkey-only user's backup codes stay the passkey's until now (see setupMFA): swap in the
    // codes this setup showed, in the same conditional write that enables the app.
    const pendingCodes = user.mfa?.passkeyEnabled ? user.mfa.pendingBackupCodes?.split(',').filter(Boolean) : undefined;
    const updatedUser = pendingCodes?.length
      ? await userRepository.atomicEnableMfa(user.id, totpSecret, pendingCodes.map(hashBackupCode))
      : await userRepository.atomicEnableMfa(user.id, totpSecret);

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

  // A passkey-only user abandoning an app setup keeps their passkey factor: drop only the
  // unconfirmed app secret. Everyone else has no factor yet, so the whole subdocument goes.
  const updatedUser = user.mfa.passkeyEnabled
    ? await userRepository.update(
        { id: user.id, updatedAt: new Date() },
        { unset: ['mfa.totpSecret', 'mfa.pendingBackupCodes'] }
      )
    : await userRepository.update({
        id: user.id,
        mfa: null,
      });

  if (!updatedUser) {
    throw new Error('Failed to cancel MFA setup.');
  }

  return { success: true };
}
