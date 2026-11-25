import { Resource } from 'sst';
import {
  createAwsKmsKeyProvider,
  createStaticKeyProvider,
  ensureKeyring,
  isKeyringSettled,
  type KeyProvider,
} from '@bike4mind/utils/security';

/** Guarded read: an unlinked/unprovisioned SST secret throws in the getter itself. */
function readSecretFromResource(name: string): string | undefined {
  try {
    return (Resource as unknown as Record<string, { value?: string } | undefined>)[name]?.value;
  } catch {
    return undefined;
  }
}

const isSet = (v: string | undefined): v is string => !!v && v !== 'not-configured';

/** `aws-kms` when the wrapped data key secret is set, else `static` (self-host and unmigrated stages). */
export function selectKeyProvider(
  legacyKey: string | undefined,
  read: (name: string) => string | undefined = readSecretFromResource
): KeyProvider {
  const wrapped = read('SECRET_DATA_KEY_WRAPPED');
  if (isSet(wrapped)) {
    let stage = 'unknown';
    try {
      stage = (Resource as unknown as { App: { stage: string } }).App.stage;
    } catch {
      // Stage is part of the KMS encryption context; an unresolvable one makes the unwrap fail and retry.
    }
    return createAwsKmsKeyProvider({ wrappedKey: wrapped, stage });
  }
  return createStaticKeyProvider(legacyKey);
}

/**
 * Loads the at-rest keyring from SST resources. connectDB calls it on every connect, so every
 * process that reaches Mongo is covered; a failed unwrap is retried on the next call. Non-DB entry
 * points that encrypt or decrypt without connecting first must await this themselves.
 */
export async function ensureKeyringLoaded(): Promise<void> {
  if (isKeyringSettled()) return;
  const legacyKey = readSecretFromResource('SECRET_ENCRYPTION_KEY');
  await ensureKeyring({
    provider: selectKeyProvider(legacyKey),
    legacyKey,
    legacyPrevious: readSecretFromResource('SECRET_ENCRYPTION_KEY_PREVIOUS'),
  });
}
