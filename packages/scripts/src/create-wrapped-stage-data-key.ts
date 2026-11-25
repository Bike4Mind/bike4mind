#!/usr/bin/env tsx

/**
 * Mints the wrapped stage data key and stores it as an SST secret. Idempotent: a stage that already has one is left alone.
 *
 * Usage (with credentials for the stage's account):
 *   pnpm --filter @bike4mind/scripts create-wrapped-stage-data-key --stage <stage> [--key <alias|arn>] [--dry-run] [--force]
 */

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { DescribeKeyCommand, GenerateDataKeyWithoutPlaintextCommand, KMSClient } from '@aws-sdk/client-kms';
import { createWrappedStageDataKey, WRAPPED_SECRET_NAME, type WrappedKeyDeps } from './createWrappedStageDataKey';

const { values } = parseArgs({
  options: {
    stage: { type: 'string' },
    key: { type: 'string' },
    app: { type: 'string', default: 'bike4mind' },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  },
});

if (!values.stage) {
  console.error('--stage is required');
  process.exit(1);
}
const stage = values.stage;
const kms = new KMSClient({});

const deps: WrappedKeyDeps = {
  readSecret: async s => {
    const listing = execFileSync('npx', ['sst', 'secret', 'list', '--stage', s], { encoding: 'utf8' });
    const line = listing.split('\n').find(l => l.startsWith(`${WRAPPED_SECRET_NAME}=`));
    return line?.slice(WRAPPED_SECRET_NAME.length + 1).trim();
  },
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
  // The value goes on stdin so the blob stays out of the process list and shell history.
  setSecret: async (s, value) => {
    execFileSync('npx', ['sst', 'secret', 'set', WRAPPED_SECRET_NAME, '--stage', s], { input: value });
  },
  log: line => console.log(line),
};

createWrappedStageDataKey(
  {
    stage,
    key: values.key,
    appName: values.app,
    dryRun: values['dry-run'],
    force: values.force,
    isPreview: /^pr\d+$/.test(stage),
  },
  deps
).catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
