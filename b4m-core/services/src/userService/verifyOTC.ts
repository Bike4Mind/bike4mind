import bcrypt from 'bcryptjs';

/**
 * Verifies an OTC against the code hash the caller read from the server-side pending record
 * (PendingOtcTokenRepository.validateAndRotateNonce). Pure function - no DB lookup.
 * Deliberately no length check: a 6-digit code issued before codes grew to 8 digits must still
 * verify while its record is live.
 */
export const verifyPendingOTC = async (code: string, otcHash: string): Promise<boolean> => {
  // Guard null/undefined/non-string input: bcrypt.compare throws on non-string
  // args, which would leak a 500 instead of a clean "invalid code".
  if (!code || !otcHash || typeof code !== 'string' || typeof otcHash !== 'string') {
    return false;
  }
  return bcrypt.compare(code, otcHash);
};
