import crypto from 'crypto';
import bcrypt from 'bcryptjs';

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
    code += charset[Math.floor(Math.random() * charset.length)];
  }

  return code;
}

/**
 * Generate 64-byte device code
 */
export function generateDeviceCode(): string {
  return crypto.randomBytes(64).toString('hex');
}

/**
 * Hash device code for secure storage
 */
export async function hashDeviceCode(deviceCode: string): Promise<string> {
  return bcrypt.hash(deviceCode, 10);
}
