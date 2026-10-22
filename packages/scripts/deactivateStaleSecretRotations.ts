#!/usr/bin/env tsx
/**
 * One-off script: soft-delete secretRotation DB records whose keyName is no
 * longer present in the rotation config (core entries plus registered contributions).
 *
 * After trimming or renaming entries in the manifest, stale DB records keep
 * isActive: true and the cron + admin UI keep alerting on them.  This script
 * sets isActive: false on every such record so they fall silent immediately.
 *
 * Run:
 *   npx sst shell --stage dev -- pnpm tsx packages/scripts/deactivateStaleSecretRotations.ts
 *   npx sst shell --stage production -- pnpm tsx packages/scripts/deactivateStaleSecretRotations.ts
 *
 * Add --dry-run to preview without writing.
 *
 * Refuses to run when no package in this tree declares a rotation, since records owned by
 * a package that is not mounted here would all look stale. On a stage that has no such
 * records, pass --no-contributed-rotations to confirm.
 */

import { connectDB, mongoose } from '@bike4mind/database';
import { secretRotationRepository } from '@bike4mind/database/infra';
import {
  declaresContributedRotations,
  getSecretRotationConfig,
  getUnregisteredContributedRotations,
} from '@bike4mind/server-utils/lib/secretRotation/constants';
import { Resource } from 'sst';
import { Config } from '@bike4mind/server-utils/utils/config';

const isDryRun = process.argv.includes('--dry-run');
const confirmedNoContributedRotations = process.argv.includes('--no-contributed-rotations');

async function main() {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));

  const unregistered = getUnregisteredContributedRotations();
  if (unregistered.length > 0) {
    throw new Error(
      `Refusing to deactivate: declared rotation(s) failed to register (${unregistered.join(', ')}), ` +
        'so their records would look stale. Fix the declaration and re-run.'
    );
  }
  if (!declaresContributedRotations() && !confirmedNoContributedRotations) {
    throw new Error(
      'Refusing to deactivate: no package in this tree declares a rotation, so records owned by a ' +
        'package that is not mounted would look stale. Run from a tree with every package mounted ' +
        'and its glue regenerated, or pass --no-contributed-rotations if this stage has none.'
    );
  }
  const configKeys = new Set(Object.keys(getSecretRotationConfig()));
  const allActive = await secretRotationRepository.find({ isActive: true });

  const stale = allActive.filter(r => !configKeys.has(r.keyName));

  if (stale.length === 0) {
    console.log('✅  No stale secretRotation records found — nothing to do.');
    return;
  }

  console.log(`Found ${stale.length} stale record(s) to deactivate:`);
  stale.forEach(r => console.log(`  - ${r.keyName}`));

  if (isDryRun) {
    console.log('\n🔍  Dry-run mode — no changes written.');
    return;
  }

  const staleIds = stale.map(r => r._id);
  const result = await secretRotationRepository.updateMany({ _id: { $in: staleIds } }, { isActive: false });

  console.log(`\n✅  Deactivated ${result.modifiedCount} record(s).`);
}

main()
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  })
  .finally(() => mongoose.disconnect());
