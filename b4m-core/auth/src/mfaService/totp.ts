/**
 * TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30 s steps) over base32 secrets. Dependency-free so the
 * e2e suite and test-only routes can mint codes through `@bike4mind/auth/mfaService/totp`.
 */
import { createHmac, randomBytes } from 'node:crypto';

export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, unpadded. */
export function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Decodes base32 the way speakeasy's base32.js did, so every secret already stored keeps its key:
 * case-insensitive, `=` skipped, `0`/`1` read as O/I, any other unknown character read as A, and
 * nonzero leftover bits kept as a final byte.
 */
export function decodeBase32(text: string): Buffer {
  const upper = text.toUpperCase();
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (let i = 0; i < upper.length; i++) {
    const char = upper[i];
    if (char === '=') continue;
    const symbol = char === '0' ? 14 : char === '1' ? 8 : Math.max(ALPHABET.indexOf(char), 0);
    value = ((value << 5) | symbol) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) bytes.push((value << (8 - bits)) & 0xff);
  return Buffer.from(bytes);
}

/** A new secret: 32 random bytes, so 52 base32 characters. */
export function generateTOTPSecret(): string {
  return encodeBase32(randomBytes(32));
}

/** The code an authenticator app shows for `secret` during time step `step`. */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The otpauth URI an authenticator app scans from the QR code. */
export function totpAuthUrl(secret: string, label: string): string {
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${encodeURIComponent(secret)}`;
}
