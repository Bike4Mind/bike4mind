#!/usr/bin/env tsx

/**
 * Mints the wrapped stage data key and stores it as an SST secret. Idempotent: a stage that already has one is left alone.
 *
 * Usage (with credentials for the stage's account):
 *   pnpm --filter @bike4mind/scripts create-wrapped-stage-data-key --stage <stage> [--key <alias|arn>] [--dry-run]
 */

import { parseArgs } from 'node:util';
import { DescribeKeyCommand, GenerateDataKeyWithoutPlaintextCommand, KMSClient } from '@aws-sdk/client-kms';
import { isPreviewStageName } from '@bike4mind/common';
import { createSstSecretStore, createWrappedStageDataKey, type WrappedKeyDeps } from './createWrappedStageDataKey';

const { values } = parseArgs({
  options: {
    stage: { type: 'string' },
    key: { type: 'string' },
    app: { type: 'string', default: process.env.SEED_APP_NAME || 'bike4mind' },
    'dry-run': { type: 'boolean', default: false },
  },
});

if (!values.stage) {
  console.error('--stage is required');
  process.exit(1);
}
const stage = values.stage;
const kms = new KMSClient({});
const store = createSstSecretStore(values.app);

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

createWrappedStageDataKey(
  {
    stage,
    key: values.key,
    appName: values.app,
    dryRun: values['dry-run'],
    // Same rule as isPreviewStage in infra/constants.ts.
    isPreview: process.env.IS_PREVIEW === 'true' || isPreviewStageName(stage),
  },
  deps
).catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
