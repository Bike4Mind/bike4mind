#!/usr/bin/env node

/**
 * SRE Multi-Repo Migration Script (v1 → v2)
 *
 * Run ONCE after deploying the v2 config schema to production.
 * Safe to re-run — all operations are idempotent (updateMany with $exists: false).
 *
 * What it does:
 *   1. Backfills repoSlug on SreErrorTracking docs (pipeline state)
 *   2. Backfills repoSlug on SreErrorPattern docs (pattern library)
 *   3. Verifies the SRE config document was auto-migrated to v2 shape
 *
 * Prerequisites:
 *   - MONGODB_URI environment variable set to the target database
 *   - Node.js 20+
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://..." node scripts/migrate-sre-v2.mjs
 *   MONGODB_URI="mongodb+srv://..." node scripts/migrate-sre-v2.mjs --dry-run
 */

import { MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI;
const DRY_RUN = process.argv.includes('--dry-run');
const DEFAULT_REPO_SLUG = 'MillionOnMars/lumina5';

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI environment variable is required');
  console.error('   Usage: MONGODB_URI="mongodb+srv://..." node scripts/migrate-sre-v2.mjs');
  process.exit(1);
}

async function main() {
  console.log(`\n🔧 SRE v2 Migration${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`   Target: ${MONGODB_URI.replace(/\/\/[^@]+@/, '//***@')}`);
  console.log(`   Default repo slug: ${DEFAULT_REPO_SLUG}\n`);

  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    const db = client.db();

    // --- Step 1: Backfill repoSlug on SreErrorTracking ---
    const trackingCollection = db.collection('sreerrortrackings');
    const trackingCount = await trackingCollection.countDocuments({ repoSlug: { $exists: false } });
    console.log(`📊 SreErrorTracking docs missing repoSlug: ${trackingCount}`);

    if (trackingCount > 0) {
      if (DRY_RUN) {
        console.log(`   ⏭️  Would set repoSlug="${DEFAULT_REPO_SLUG}" on ${trackingCount} docs`);
      } else {
        const result = await trackingCollection.updateMany(
          { repoSlug: { $exists: false } },
          { $set: { repoSlug: DEFAULT_REPO_SLUG } }
        );
        console.log(`   ✅ Updated ${result.modifiedCount} tracking docs`);
      }
    } else {
      console.log('   ✅ All tracking docs already have repoSlug');
    }

    // --- Step 2: Backfill repoSlug on SreErrorPattern ---
    const patternCollection = db.collection('sreerrorpatterns');
    const patternCount = await patternCollection.countDocuments({ repoSlug: { $exists: false } });
    console.log(`\n📊 SreErrorPattern docs missing repoSlug: ${patternCount}`);

    if (patternCount > 0) {
      if (DRY_RUN) {
        console.log(`   ⏭️  Would set repoSlug="${DEFAULT_REPO_SLUG}" on ${patternCount} docs`);
      } else {
        const result = await patternCollection.updateMany(
          { repoSlug: { $exists: false } },
          { $set: { repoSlug: DEFAULT_REPO_SLUG } }
        );
        console.log(`   ✅ Updated ${result.modifiedCount} pattern docs`);
      }
    } else {
      console.log('   ✅ All pattern docs already have repoSlug');
    }

    // --- Step 3: Verify config migration ---
    const settingsCollection = db.collection('adminsettings');
    const configDoc = await settingsCollection.findOne({ settingName: 'sreAgentConfig' });
    console.log('\n📊 SRE config document:');

    if (!configDoc) {
      console.log('   ⚠️  No sreAgentConfig found in AdminSettings (pipeline not configured yet)');
    } else {
      const config = configDoc.settingValue;
      const isV2 = config?.schemaVersion >= 2 || config?.defaults || config?.repos;
      const repoCount = config?.repos?.length ?? 0;
      const hasDefaults = !!config?.defaults;

      console.log(`   Shape: ${isV2 ? 'v2' : 'v1 (will auto-migrate on next read)'}`);
      console.log(`   Has defaults: ${hasDefaults}`);
      console.log(`   Repos configured: ${repoCount}`);

      if (isV2 && repoCount > 0) {
        console.log('   Repos:');
        for (const repo of config.repos) {
          console.log(`     - ${repo.owner}/${repo.repo}`);
        }
      }

      if (!isV2) {
        console.log('   ℹ️  Config will auto-migrate to v2 shape on next read via z.preprocess.');
        console.log('   ℹ️  Visit the SRE admin page or trigger any pipeline event to persist v2 shape.');
      }
    }

    // --- Summary ---
    console.log('\n' + '─'.repeat(50));
    if (DRY_RUN) {
      console.log('🏁 Dry run complete. Re-run without --dry-run to apply changes.');
    } else {
      console.log('🏁 Migration complete.');
      console.log('   Next steps:');
      console.log('   1. Visit Admin → SRE Agent to verify config loaded correctly');
      console.log('   2. Check Pipeline Status shows existing tracking docs');
      console.log('   3. Check Pattern Library shows existing patterns');
    }
    console.log('');
  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
