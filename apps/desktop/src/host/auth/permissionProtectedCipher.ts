import type { SecretCipher } from '../../main/auth/tokenVault';

/**
 * Threat model: a headless host reached over SSH has no OS keychain, and a key stored beside the
 * vault would protect nothing, so tokens rest unencrypted in an owner-only file (0600 in a 0700
 * directory), like `~/.ssh`. Anyone with that OS account's or root's file access can read them.
 *
 * This is an encoding, not encryption: it reports `isEncryptionAvailable()` false and declares
 * `file-permissions`, which is what lets the vault persist under it and report so.
 */
export const permissionProtectedCipher: SecretCipher = {
  atRestProtection: 'file-permissions',
  isEncryptionAvailable: () => false,
  encryptString: plainText => Buffer.from(plainText, 'utf8'),
  decryptString: encoded => encoded.toString('utf8'),
};
