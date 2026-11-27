import { decryptAtRest } from '@bike4mind/utils/security';

/**
 * Returns the plaintext blog API key for the stored (possibly encrypted) value.
 * decryptAtRest yields '' when ciphertext cannot be decrypted, so that case throws
 * here rather than sending an empty or encrypted header. Messages never carry the value.
 */
export function resolveBlogApiKey(stored: string | undefined): string {
  if (!stored) {
    throw new Error(
      'Blog integration not configured. Please add your blog API key in Settings \u2192 Integrations \u2192 Blog Publishing.'
    );
  }
  const apiKey = decryptAtRest(stored);
  if (!apiKey) {
    throw new Error('Blog integration API key could not be read. Please reconnect your blog in Settings.');
  }
  return apiKey;
}
