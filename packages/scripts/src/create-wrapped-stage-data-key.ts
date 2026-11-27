#!/usr/bin/env tsx

/**
 * Mints the wrapped stage data key and stores it as an SST secret. Idempotent: a stage that already has one is left alone.
 *
 * Usage (with credentials for the stage's account):
 *   pnpm --filter @bike4mind/scripts create-wrapped-stage-data-key --stage <stage> [--key <alias|arn>] [--dry-run]
 */

import { DescribeKeyCommand, GenerateDataKeyWithoutPlaintextCommand, KMSClient } from '@aws-sdk/client-kms';
import {
  createSstSecretStore,
  createWrappedStageDataKey,
  parseCliOptions,
  type WrappedKeyDeps,
  type WrappedKeyOptions,
} from './createWrappedStageDataKey';

let options: WrappedKeyOptions;
try {
  options = parseCliOptions(process.argv.slice(2), process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
const kms = new KMSClient({});
const store = createSstSecretStore(options.appName);

const deps: WrappedKeyDeps = {
  ...store,
  describeKey: async key => {
    const { KeyMetadata } = await kms.send(new DescribeKeyCommand({ KeyId: key }));
    return { enabled: KeyMetadata?.Enabled === true, arn: KeyMetadata?.Arn ?? key };
  },
  generateWrappedKey: async (key, context) => {
    const out = await kms.send(
      new GenerateDataKeyWithoutPlaintextCommand({ KeyId: key, KeySpec: 'AES_256', EncryptionContext: context })
    );
    if (!out.CiphertextBlob) throw new Error('KMS returned no ciphertext blob');
    return out.CiphertextBlob;
  },
  log: line => console.log(line),
};

createWrappedStageDataKey(options, deps).catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
