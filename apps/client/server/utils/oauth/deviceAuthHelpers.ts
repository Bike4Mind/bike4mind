import crypto from 'crypto';

// Shared by device/initiate (hard cap) and device/token (global poll ceiling = cap * 12, one poll per 5s each).
export const MAX_LIVE_PENDING_DEVICE_AUTHORIZATIONS = 500;

/**
 * Generate 8-character user code (base32, no confusing characters)
 * Format: XXXX-XXXX (e.g., "WXYZ-1234")
 */
export function generateUserCode(): string {
  // Exclude confusing chars: 0, 1, 8, O, I, L
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';

  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-'; // Add separator
    // crypto.randomInt is a CSPRNG; Math.random is predictable and must never mint a credential.
    code += charset[crypto.randomInt(charset.length)];
  }

  return code;
}

/**
 * Generate 64-byte device code
 */
export function generateDeviceCode(): string {
  return crypto.randomBytes(64).toString('hex');
}
