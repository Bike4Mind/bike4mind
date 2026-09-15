import { randomBytes } from 'crypto';

/**
 * Publish - generate the unguessable capability token behind a no-sign-in
 * `/a/<shareToken>` link. 256 bits of entropy (vs `publicId`'s ~48-bit UUID slice)
 * because possession of this value IS the read grant. base64url so it is URL-safe
 * with no padding to strip.
 */
export function generateShareToken(): string {
  return randomBytes(32).toString('base64url');
}
