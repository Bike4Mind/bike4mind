import { isValidEncryptionKey } from '../secretEncryption';
import type { KeyProvider } from '../keyring';

/** Self-host provider: the operator-supplied SECRET_ENCRYPTION_KEY is the data key. */
export function createStaticKeyProvider(key: string | undefined): KeyProvider {
  return {
    name: 'static',
    load: async () => (key && isValidEncryptionKey(key) ? { id: 'static', key } : null),
  };
}
