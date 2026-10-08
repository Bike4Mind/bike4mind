import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { timingSafeEqual, createHash } from 'crypto';
import { IUserDocument, IMFAConfig, MFA_MAX_FAILED_ATTEMPTS } from '@bike4mind/common';

export interface TOTPSetupData {
  secret: string;
  qrCodeUrl: string;
  manualEntryKey: string;
}

export interface TOTPVerificationResult {
  isValid: boolean;
  usedBackupCode?: string;
}

/**
 * Generate TOTP setup data including secret and QR code
 */
export async function generateTOTPSetup(
  userEmail: string,
  appName: string = process.env.APP_NAME || ''
): Promise<TOTPSetupData> {
  // No brand fallback: when APP_NAME is unconfigured, label the TOTP entry with just
  // the user's email rather than emitting a stray "(email)" with a leading space.
  const secret = speakeasy.generateSecret({ name: appName ? `${appName} (${userEmail})` : userEmail });
  const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url!);
  return {
    secret: secret.base32,
    qrCodeUrl,
    manualEntryKey: secret.base32,
  };
}

/**
 * Verify a TOTP token against a secret
 * Using industry-standard window to handle minor clock drift
 */
export function verifyTOTPToken(secret: string, token: string, window = 1): boolean {
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    window, // Allow ±30 seconds for clock drift (industry standard)
  });
}

/**
 * Hash a backup code for at-rest storage.
 * Codes are high-entropy random strings (speakeasy base32, ~50 bits), so a
 * fast SHA-256 is appropriate - no dictionary attack risk, and the migration
 * backfill over thousands of users stays instantaneous.
 */
export function hashBackupCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

/**
 * Generate cryptographically secure backup codes for MFA.
 * Returns plaintext codes for display to the user; callers are responsible for
 * hashing them (via hashBackupCode) before storing in the database.
 */
export function generateBackupCodes(count: number = 10): string[] {
  return Array.from({ length: count }, () => {
    // crypto.randomBytes-backed CSPRNG via speakeasy
    const secret = speakeasy.generateSecret({ length: 20 });
    return secret.base32.substring(0, 10).toUpperCase();
  });
}

/**
 * Verify a backup code against stored hashes.
 * Hashes the provided code and compares against stored SHA-256 hashes using
 * constant-time comparison to prevent timing attacks.
 */
export function verifyBackupCode(userBackupCodes: string[], providedCode: string): TOTPVerificationResult {
  if (!userBackupCodes || !providedCode) {
    return { isValid: false };
  }

  const providedHash = hashBackupCode(providedCode);
  const providedBuf = Buffer.from(providedHash, 'utf8');

  // Use constant-time comparison - all stored hashes are 64-char hex so buffers
  // are always the same length, satisfying timingSafeEqual's requirement.
  let matchIdx = -1;
  for (let i = 0; i < userBackupCodes.length; i++) {
    const storedBuf = Buffer.from(userBackupCodes[i], 'utf8');
    if (storedBuf.length === providedBuf.length && timingSafeEqual(storedBuf, providedBuf)) {
      matchIdx = i;
      break;
    }
  }

  if (matchIdx !== -1) {
    return { isValid: true, usedBackupCode: userBackupCodes[matchIdx] };
  }

  return { isValid: false };
}

/**
 * Check if a user requires MFA based on enforcement settings
 * When MFA is enforced, it applies to ALL users
 */
export function userRequiresMFA(user: IUserDocument, enforceMFASetting: boolean): boolean {
  return enforceMFASetting; // Enforcement applies to all users
}

/**
 * Check if a user has MFA configured
 */
export function userHasMFAConfigured(user: IUserDocument): user is IUserDocument & { mfa: IMFAConfig } {
  // totpEnabled is the source of truth and is NOT select:false - so this works even
  // when the user was loaded without the (select:false) totpSecret (e.g. OTC login).
  return !!(user.mfa && user.mfa.totpEnabled);
}

export const MAX_FAILED_ATTEMPTS = MFA_MAX_FAILED_ATTEMPTS;

/**
 * Check if user is currently locked out from MFA attempts
 */
export function isUserLockedOut(user: IUserDocument): boolean {
  if (!user.mfa?.lockedUntil) return false;
  return new Date() < new Date(user.mfa.lockedUntil);
}

/**
 * Get remaining lockout time in minutes
 */
export function getLockoutTimeRemaining(user: IUserDocument): number {
  if (!user.mfa?.lockedUntil) return 0;
  const remaining = new Date(user.mfa.lockedUntil).getTime() - Date.now();
  return Math.max(0, Math.ceil(remaining / (60 * 1000)));
}

/**
 * Clear failed attempts on successful verification
 */
export function clearFailedAttempts(mfa: IMFAConfig): IMFAConfig {
  return { ...mfa, failedAttempts: 0, lastFailedAttempt: undefined, lockedUntil: undefined };
}

/**
 * Check if a user is eligible to set up MFA
 */
export function userEligibleForMFA(user: IUserDocument): boolean {
  // All users can enable MFA
  return true;
}

/**
 * Check if a user can disable MFA based on enforcement settings
 * When MFA is enforced, NO user can disable it
 */
export function userCanDisableMFA(user: IUserDocument, enforceMFASetting: boolean): boolean {
  return !enforceMFASetting;
}
