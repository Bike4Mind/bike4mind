/**
 * Secret encryption utility.
 *
 * The implementation now lives in @bike4mind/utils so the database layer (which
 * cannot import from apps/client) can share it. This module is kept as a re-export
 * so existing server routes and webhooks keep importing it from here
 * (`@bike4mind/server-utils/security/secretEncryption`).
 */
export {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  generateEncryptionKey,
  isValidEncryptionKey,
} from '@bike4mind/utils/security';
