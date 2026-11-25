import { createHash } from 'node:crypto';
import type { KeyProvider } from '../keyring';

export interface KmsDecryptArgs {
  ciphertext: Uint8Array;
  encryptionContext: Record<string, string>;
}

export interface AwsKmsKeyProviderOptions {
  /** Base64 KMS ciphertext of the 32-byte stage data key. */
  wrappedKey: string;
  stage: string;
  /** Injectable for tests; defaults to a lazily imported KMS client. */
  decrypt?: (args: KmsDecryptArgs) => Promise<Uint8Array>;
  /** Bound on the unwrap so a function with no KMS network path fails instead of hanging. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

async function kmsDecrypt({ ciphertext, encryptionContext }: KmsDecryptArgs): Promise<Uint8Array> {
  const { KMSClient, DecryptCommand } = await import('@aws-sdk/client-kms');
  const out = await new KMSClient({}).send(
    new DecryptCommand({ CiphertextBlob: ciphertext, EncryptionContext: encryptionContext })
  );
  if (!out.Plaintext) throw new Error('KMS Decrypt returned no plaintext');
  return out.Plaintext;
}

export function createAwsKmsKeyProvider(opts: AwsKmsKeyProviderOptions): KeyProvider {
  const { wrappedKey, stage, decrypt = kmsDecrypt, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  return {
    name: 'aws-kms',
    async load() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`KMS unwrap timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      try {
        const plaintext = await Promise.race([
          decrypt({
            ciphertext: Buffer.from(wrappedKey, 'base64'),
            encryptionContext: { purpose: 'secrets-at-rest', stage },
          }),
          timeout,
        ]);
        if (plaintext.length !== 32) throw new Error('KMS unwrap returned a key of the wrong length');
        return {
          id: createHash('sha256').update(wrappedKey).digest('hex').slice(0, 16),
          key: Buffer.from(plaintext).toString('hex'),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
