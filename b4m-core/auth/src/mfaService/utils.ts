// speakeasy calls `new Buffer()` internally, which Node >=10 flags as a DeprecationWarning
// (DEP0005). The warning fires synchronously during the speakeasy import, before any
// test/app code runs, and cannot be silenced via command-line flags at that point.
// We suppress only the specific Buffer deprecation here and restore the original handler
// immediately after the import so no other warnings are affected.
const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning: any, name?: any) => {
  if (name === 'DeprecationWarning' && warning?.toString().includes('Buffer')) {
    return; // Suppress speakeasy's Buffer deprecation warning only
  }
  return originalEmitWarning.call(process, warning, name);
};

import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { timingSafeEqual, createHash } from 'crypto';
import { IUserDocument } from '@bike4mind/common';

// Restore original warning handler after import
process.emitWarning = originalEmitWarning;

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
 * In lumina5, when MFA is enforced, it applies to ALL users
 */
export function userRequiresMFA(user: IUserDocument, enforceMFASetting: boolean): boolean {
  return enforceMFASetting; // In lumina5, enforcement applies to all users
}

/**
 * Check if a user has MFA configured
 */
export function userHasMFAConfigured(user: IUserDocument): boolean {
  // totpEnabled is the source of truth and is NOT select:false - so this works even
  // when the user was loaded without the (select:false) totpSecret (e.g. OTC login).
  return !!(user.mfa && user.mfa.totpEnabled);
}

/**
 * Server-side attempt tracking to prevent bypass via refresh/cancel
 * Constants for lockout policy
 */
const MAX_FAILED_ATTEMPTS = 3;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const ATTEMPT_RESET_WINDOW_MS = 60 * 60 * 1000; // 1 hour

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
 * Reset failed attempts if enough time has passed since last failure
 */
export function shouldResetFailedAttempts(user: IUserDocument): boolean {
  if (!user.mfa?.lastFailedAttempt) return false;
  const timeSinceLastFailure = Date.now() - new Date(user.mfa.lastFailedAttempt).getTime();
  return timeSinceLastFailure > ATTEMPT_RESET_WINDOW_MS;
}

/**
 * Record a failed MFA attempt and return updated MFA object
 */
export function recordFailedAttempt(user: IUserDocument): any {
  const currentAttempts = shouldResetFailedAttempts(user) ? 0 : user.mfa?.failedAttempts || 0;
  const newAttempts = currentAttempts + 1;
  const now = new Date();

  const updatedMFA = { ...user.mfa };
  updatedMFA.failedAttempts = newAttempts;
  updatedMFA.lastFailedAttempt = now;

  // Lock user if max attempts reached
  if (newAttempts >= MAX_FAILED_ATTEMPTS) {
    updatedMFA.lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
  }

  return updatedMFA;
}

/**
 * Clear failed attempts on successful verification
 */
export function clearFailedAttempts(user: IUserDocument): any {
  if (!user.mfa) return null;

  const updatedMFA = { ...user.mfa };
  updatedMFA.failedAttempts = 0;
  updatedMFA.lastFailedAttempt = undefined;
  updatedMFA.lockedUntil = undefined;

  return updatedMFA;
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
 * In lumina5, when MFA is enforced, NO user can disable it
 */
export function userCanDisableMFA(user: IUserDocument, enforceMFASetting: boolean): boolean {
  return !enforceMFASetting;
}
