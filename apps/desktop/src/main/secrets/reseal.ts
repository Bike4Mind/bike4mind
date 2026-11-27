interface ResealCipher {
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  needsReencrypt?(encrypted: Buffer): boolean;
}

/**
 * A stored base64 blob sealed again in the cipher's current format. Null when it needs no change,
 * or cannot be opened or sealed now; the store then keeps the old blob for its read path.
 */
export function resealed(cipher: ResealCipher, sealed: string): string | null {
  const blob = Buffer.from(sealed, 'base64');
  if (!cipher.needsReencrypt?.(blob)) return null;
  try {
    return cipher.encryptString(cipher.decryptString(blob)).toString('base64');
  } catch {
    return null;
  }
}
