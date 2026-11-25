/**
 * Manual health check for the secrets-at-rest key: unwraps the stage's wrapped data key from inside the
 * VPC, to show a VPC-attached function reaches KMS (through the NAT) and how long a Decrypt takes.
 * The plaintext is discarded at once; only { ok, decryptMs, coldStart } is returned or logged.
 */
import { Resource } from 'sst';

/** Must match secretsAtRestEncryptionContext in infra/secretsAtRestKey.ts. */
const PURPOSE = 'secrets-at-rest';
/** A missing route to KMS must fail fast rather than hang until the function timeout. */
const CONNECT_TIMEOUT_MS = 3000;

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
    await input.decrypt(Buffer.from(input.blobBase64, 'base64'), { purpose: PURPOSE, stage: input.stage });
    return { ok: true, decryptMs: Math.round(now() - started), coldStart };
  } catch (error) {
    // Name only: an SDK error message can carry request detail.
    const name = error instanceof Error ? error.name : 'UnknownError';
    return { ok: false, decryptMs: Math.round(now() - started), coldStart, error: name };
  }
}

export const handler = async (): Promise<UnwrapProbeResult> => {
  // Imported here so the client is built after the handler's cold-start flag is read.
  const { KMSClient, DecryptCommand } = await import('@aws-sdk/client-kms');
  const kms = new KMSClient({ requestHandler: { connectionTimeout: CONNECT_TIMEOUT_MS } });
  const stage = process.env.SST_STAGE ?? '';
  const result = await runUnwrapProbe({
    blobBase64: Resource.SECRET_ENCRYPTION_KEY_WRAPPED.value,
    stage,
    decrypt: async (blob, context) => {
      // The response, which holds the plaintext data key, is dropped without being read.
      await kms.send(new DecryptCommand({ CiphertextBlob: blob, EncryptionContext: context }));
    },
  });
  console.log(JSON.stringify(result));
  return result;
};
