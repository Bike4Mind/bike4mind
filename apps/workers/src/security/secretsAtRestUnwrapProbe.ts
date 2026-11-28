/**
 * Manual health check for the secrets-at-rest key: unwraps the stage's wrapped data key from inside the
 * VPC, to show a VPC-attached function reaches KMS (through the NAT) and how long a Decrypt takes.
 * The plaintext is discarded at once; only { ok, decryptMs, coldStart } is returned.
 */
import { DecryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { SECRETS_AT_REST_PURPOSE } from '@bike4mind/common';
import { Resource } from 'sst';

/** A missing route or a stalled response must fail fast, well inside the 10 s function timeout. */
const TIMEOUT_MS = 3000;

// Module level so warm invocations reuse the connection and decryptMs excludes the TLS handshake.
// One attempt: the default retries would stack three timeouts against the function timeout.
const kms = new KMSClient({
  maxAttempts: 1,
  requestHandler: { connectionTimeout: TIMEOUT_MS, socketTimeout: TIMEOUT_MS },
});

let warm = false;

export interface UnwrapProbeResult {
  ok: boolean;
  decryptMs: number;
  coldStart: boolean;
  error?: string;
}

export type DecryptFn = (blob: Uint8Array, context: Record<string, string>) => Promise<void>;

export async function runUnwrapProbe(input: {
  blobBase64: string;
  stage: string;
  decrypt: DecryptFn;
  now?: () => number;
}): Promise<UnwrapProbeResult> {
  const now = input.now ?? (() => performance.now());
  const coldStart = !warm;
  warm = true;
  const started = now();
  try {
    await input.decrypt(Buffer.from(input.blobBase64, 'base64'), {
      purpose: SECRETS_AT_REST_PURPOSE,
      stage: input.stage,
    });
    return { ok: true, decryptMs: Math.round(now() - started), coldStart };
  } catch (error) {
    // Name only: an SDK error message can carry request detail.
    const name = error instanceof Error ? error.name : 'UnknownError';
    return { ok: false, decryptMs: Math.round(now() - started), coldStart, error: name };
  }
}

export const handler = async (): Promise<UnwrapProbeResult> => {
  return runUnwrapProbe({
    blobBase64: Resource.SECRET_DATA_KEY_WRAPPED.value,
    stage: Resource.App.stage,
    decrypt: async (blob, context) => {
      // The response, which holds the plaintext data key, is dropped without being read.
      await kms.send(new DecryptCommand({ CiphertextBlob: blob, EncryptionContext: context }));
    },
  });
};
