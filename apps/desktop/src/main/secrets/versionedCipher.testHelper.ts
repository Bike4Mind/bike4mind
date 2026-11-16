import type { SecretCipher } from '../chat/mcp/McpServerStore';

/**
 * A cipher in the shape AppSecretCipher takes in secret-key mode: it writes `new:` blobs, opens
 * `old:` ones unless `opensOld` is false, and asks for every non-`new:` blob to be re-saved. With
 * `writes: 'old'` it plays the safeStorage the blobs were first written with.
 */
export function versionedCipher(
  writes: 'old' | 'new',
  { opensOld = true, available = true }: { opensOld?: boolean; available?: boolean } = {}
): SecretCipher & { decrypted: string[] } {
  const decrypted: string[] = [];
  return {
    decrypted,
    isEncryptionAvailable: () => available,
    encryptString: plain => {
      if (!available) throw new Error('unavailable');
      return Buffer.from(`${writes}:${plain}`, 'utf8');
    },
    decryptString: encrypted => {
      const text = encrypted.toString('utf8');
      if (text.startsWith('new:') || (text.startsWith('old:') && opensOld)) {
        decrypted.push(text);
        return text.slice(4);
      }
      throw new Error('cannot open');
    },
    ...(writes === 'new'
      ? { needsReencrypt: (encrypted: Buffer) => !encrypted.toString('utf8').startsWith('new:') }
      : {}),
  };
}

export const sealedAs = (prefix: 'old' | 'new', plain: string) => Buffer.from(`${prefix}:${plain}`).toString('base64');
export const openedAs = (sealed: string) => Buffer.from(sealed, 'base64').toString('utf8');
