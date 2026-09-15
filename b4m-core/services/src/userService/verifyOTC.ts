import bcrypt from 'bcryptjs';

/**
 * OTC verification is token-based: the hashed code travels inside the signed
 * pending token issued by sendOTC, so verification is a pure comparison with no
 * database lookup.
 */

/**
 * Verifies a 6-digit OTC against the hash carried in the signed pending token.
 * Pure function - no DB lookup.
 */
export const verifyPendingOTC = async (code: string, otcHash: string): Promise<boolean> => {
  // Guard null/undefined/non-string input: bcrypt.compare throws on non-string
  // args, which would leak a 500 instead of a clean "invalid code".
  if (!code || !otcHash || typeof code !== 'string' || typeof otcHash !== 'string') {
    return false;
  }
  return bcrypt.compare(code, otcHash);
};
