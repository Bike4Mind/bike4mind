#!/usr/bin/env tsx
/**
 * One-off script: soft-delete secretRotation DB records whose keyName is no
 * longer present in SECRET_ROTATION_CONFIG.
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
 */

import { connectDB, mongoose } from '@bike4mind/database';
import { secretRotationRepository } from '@bike4mind/database/infra';
import { SECRET_ROTATION_CONFIG } from '../../apps/client/lib/secretRotation/constants';
import { Resource } from 'sst';
import { Config } from '../../apps/client/server/utils/config';

const isDryRun = process.argv.includes('--dry-run');

async function main() {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));

  const configKeys = new Set(Object.keys(SECRET_ROTATION_CONFIG));
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
