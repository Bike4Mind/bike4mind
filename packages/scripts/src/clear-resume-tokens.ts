#!/usr/bin/env tsx

/**
 * Script to clear resume tokens when MongoDB change streams are out of sync
 * This happens when the MongoDB oplog has cycled and old resume points are no longer available
 *
 * Usage: pnpm --filter scripts clear-resume-tokens
 */

import { connectDB } from '@bike4mind/database';
import { QuerySubscription } from '@bike4mind/database';
import { Config } from '../utils/config';
import { Resource } from 'sst';

async function clearResumeTokens() {
  const mongoURI = process.env.MONGODB_URI ?? Config.MONGODB_URI;
  const url = mongoURI.replace('%STAGE%', Resource.App.stage);

  console.log('Connecting to MongoDB...');
  await connectDB(url);

  const DRY_RUN = process.argv.includes('--dry-run');
  if (!DRY_RUN) {
    try {
      const result = await QuerySubscription.updateMany(
        { lastChange: { $exists: true } },
        { $unset: { lastChange: '' } }
      );

      console.log(`✅ Cleared ${result.modifiedCount} resume tokens`);

      // Also clear any subscriptions with errors
      const errorResult = await QuerySubscription.updateMany(
        { 'subscribers.errorReason': { $exists: true } },
        { $pull: { subscribers: { errorReason: { $exists: true } } } }
      );

      if (errorResult.modifiedCount > 0) {
        console.log(`✅ Cleaned up ${errorResult.modifiedCount} subscriptions with errors`);
      }

      const SUBSCRIPTION_ID = process.argv.find(arg => arg.startsWith('--subscription='))?.split('=')[1];
      if (SUBSCRIPTION_ID) {
        // Clear specific subscription only
      }
    } catch (error) {
      console.error('❌ Error clearing resume tokens:', error);
      process.exit(1);
    }
  }

  process.exit(0);
}

clearResumeTokens();
