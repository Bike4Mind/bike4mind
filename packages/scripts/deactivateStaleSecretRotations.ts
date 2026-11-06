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
 * Writes require --confirm-complete-rotation-inventory after mounting every package deployed
 * to the target stage and regenerating glue. For a stage with no contributed rotations, use
 * --no-contributed-rotations. Either way the script checks the stage itself: it refuses when a
 * stale record names a non-core secret the stage still deploys, since `sst shell` links every
 * resource on the stage and such a record belongs to a package missing from the local tree.
 * It refuses under `sst shell --target`, which links only part of the stage.
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
import { coreResourceNames } from '@bike4mind/server-utils/premium-generated/infraResources.generated';
import { deactivateStaleSecretRotations } from './src/staleSecretRotationCleanup';

const isDryRun = process.argv.includes('--dry-run');
const confirmedNoContributedRotations = process.argv.includes('--no-contributed-rotations');
const confirmedCompleteInventory = process.argv.includes('--confirm-complete-rotation-inventory');

// The sst Resource proxy throws on a name the stage does not link.
function isDeployedOnStage(name: string): boolean {
  try {
    return (Resource as unknown as Record<string, unknown>)[name] !== undefined;
  } catch {
    return false;
  }
}

async function main() {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));

  const { staleRecords: stale, modifiedCount } = await deactivateStaleSecretRotations(
    {
      isDryRun,
      confirmedCompleteInventory,
      confirmedNoContributedRotations,
      hasContributedRotations: declaresContributedRotations(),
      unregisteredRotations: getUnregisteredContributedRotations(),
      configKeys: new Set(Object.keys(getSecretRotationConfig())),
      coreResourceNames,
      isDeployedOnStage,
    },
    {
      findActive: async () => secretRotationRepository.find({ isActive: true }),
      deactivate: async records =>
        secretRotationRepository.updateMany({ _id: { $in: records.map(record => record._id) } }, { isActive: false }),
    }
  );

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

  console.log(`\n\u2705  Deactivated ${modifiedCount} record(s).`);
}

main()
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  })
  .finally(() => mongoose.disconnect());
