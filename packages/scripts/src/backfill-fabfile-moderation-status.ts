#!/usr/bin/env tsx

/**
 * Backfill script: Set moderationStatus='clean' on all pre-existing FabFiles
 *
 * Rationale: FabFiles uploaded before Q2b moderation feature have moderationStatus === undefined.
 * The isImageServeable gate refuses images with moderationStatus !== 'clean', so legacy images
 * would stop serving after deploy. This marks the existing corpus as 'clean' (forward-looking
 * control, not a retroactive scan of history).
 *
 * Idempotent: Re-runs match nothing (all undefined are already set to 'clean').
 *
 * Usage: pnpm --filter scripts backfill:fabfile-moderation-status
 */

import { connectDB, FabFile } from '@bike4mind/database';
import { Config } from '../utils/config';
import { Resource } from 'sst';

async function backfillFabFileModeration() {
  const mongoURI = process.env.MONGODB_URI ?? Config.MONGODB_URI;
  const url = mongoURI.replace('%STAGE%', Resource.App.stage);

  console.log('Connecting to MongoDB...');
  await connectDB(url);

  try {
    console.log('Backfilling FabFiles with moderationStatus: "clean"...');

    const result = await FabFile.updateMany(
      { moderationStatus: { $exists: false } },
      { $set: { moderationStatus: 'clean' } }
    );

    console.log(`✅ Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`);

    if (result.modifiedCount === 0) {
      console.log('ℹ️  No FabFiles to backfill (all already have moderationStatus set)');
    }
  } catch (error) {
    console.error('❌ Error backfilling FabFile moderation status:', error);
    process.exit(1);
  }

  process.exit(0);
}

backfillFabFileModeration();
