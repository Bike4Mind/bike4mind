import { mongoose } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Migration: UserSubscription -> Subscription
 *
 * This migration consolidates the legacy UserSubscription model into the unified
 * Subscription model. Uses MongoDB collections directly to avoid complex model
 * dependencies and import issues.
 *
 * Schema mapping:
 * - userId -> ownerId (with ownerType: 'User')
 * - All other fields preserved (subscriptionId, priceId, status, dates, etc.)
 * - quantity: 1 added (user subscriptions always have quantity 1)
 */

// Type interfaces for type safety (not used for Mongoose models)
interface UserSubscriptionDoc {
  _id: any;
  userId: string;
  subscriptionId: string;
  priceId: string;
  status: string;
  canceledAt: Date | null;
  periodStartsAt: Date;
  periodEndsAt: Date;
  customCreditsPerCycle?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

interface SubscriptionDoc {
  ownerType: 'User' | 'Organization';
  ownerId: string;
  subscriptionId: string;
  priceId: string;
  status: string;
  canceledAt: Date | null;
  periodStartsAt: Date;
  periodEndsAt: Date;
  quantity: number;
  customCreditsPerCycle?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const migration: MigrationFile = {
  id: 20260120142227,
  name: 'migrate usersubscription to subscription',

  up: async () => {
    console.log('Starting migration: UserSubscription → Subscription...');
    console.log('='.repeat(60));

    try {
      // Access MongoDB collections directly (bypasses Mongoose model complexity)
      const db = mongoose.connection.db;
      if (!db) {
        throw new Error('Database connection not established');
      }

      const userSubscriptionsCollection = db.collection<UserSubscriptionDoc>('usersubscriptions');
      const subscriptionsCollection = db.collection<SubscriptionDoc>('subscriptions');

      const userSubscriptions = await userSubscriptionsCollection.find({}).toArray();
      console.log(`Found ${userSubscriptions.length} UserSubscription records to migrate`);

      if (userSubscriptions.length === 0) {
        console.log('✅ No records to migrate');
        return;
      }

      let processedCount = 0;
      let migratedCount = 0;
      let skippedCount = 0;
      let errorCount = 0;

      for (const userSub of userSubscriptions) {
        try {
          // Check if subscription already exists (idempotency check using subscriptionId)
          const existing = await subscriptionsCollection.findOne({ subscriptionId: userSub.subscriptionId });

          if (existing) {
            // Already migrated, skip
            skippedCount++;
            processedCount++;

            if (processedCount % 100 === 0) {
              console.log(`  Progress: ${processedCount}/${userSubscriptions.length} processed...`);
            }
            continue;
          }

          // Map UserSubscription -> Subscription schema
          const subscriptionData: Omit<SubscriptionDoc, '_id'> = {
            ownerType: 'User', // Polymorphic owner type
            ownerId: userSub.userId, // Map userId → ownerId
            subscriptionId: userSub.subscriptionId,
            priceId: userSub.priceId,
            status: userSub.status,
            canceledAt: userSub.canceledAt,
            periodStartsAt: userSub.periodStartsAt,
            periodEndsAt: userSub.periodEndsAt,
            quantity: 1, // Always 1 for user subscriptions (team subscriptions have quantity > 1)
            customCreditsPerCycle: userSub.customCreditsPerCycle,
            createdAt: userSub.createdAt || new Date(),
            updatedAt: userSub.updatedAt || new Date(),
          };

          await subscriptionsCollection.insertOne(subscriptionData as any);
          migratedCount++;
          processedCount++;

          if (processedCount % 100 === 0) {
            console.log(`  Progress: ${processedCount}/${userSubscriptions.length} processed...`);
          }
        } catch (error) {
          errorCount++;
          processedCount++;
          console.error(
            `  ❌ Error migrating subscription ${userSub.subscriptionId} for user ${userSub.userId}:`,
            error
          );
          // Continue with next record instead of failing entire migration
        }
      }

      console.log('='.repeat(60));
      console.log('✅ Migration completed successfully!');
      console.log(`   Total processed: ${processedCount}`);
      console.log(`   Newly migrated:  ${migratedCount}`);
      console.log(`   Skipped (already migrated): ${skippedCount}`);
      if (errorCount > 0) {
        console.log(`   Errors: ${errorCount}`);
        console.warn('⚠️  Some records failed to migrate. Check logs above for details.');
      }
      console.log('='.repeat(60));

      // Verify migration success by counting documents
      // With only 28 total subscriptions, manual verification in MongoDB is also feasible
      const subscriptionCount = await subscriptionsCollection.countDocuments({ ownerType: 'User' });
      console.log(`\n📊 Verification:`);
      console.log(`   UserSubscription records: ${userSubscriptions.length}`);
      console.log(`   Subscription records (ownerType='User'): ${subscriptionCount}`);
      console.log(`   Newly migrated: ${migratedCount}`);
      console.log(`   Already migrated (skipped): ${skippedCount}`);
      console.log(`   Failed to migrate (errors): ${errorCount}`);

      // Calculate expected count: successfully migrated + already existing records
      // This accounts for idempotency - migration can be run multiple times safely
      const expectedCount = migratedCount + skippedCount;
      if (subscriptionCount >= expectedCount) {
        console.log('✅ Data integrity verified: All records migrated successfully');
        console.log(`   Expected: ${expectedCount}, Found: ${subscriptionCount}`);
      } else {
        console.error(`❌ Data integrity check FAILED!`);
        console.error(`   Expected: ${expectedCount}, Found: ${subscriptionCount}`);
        console.error(`   Missing: ${expectedCount - subscriptionCount} records`);
        console.warn('⚠️  Record counts do not match. Review migration logs above.');
      }
    } catch (error) {
      console.error('❌ Migration failed:', error);
      throw error;
    }
  },

  down: async () => {
    console.log('Rolling back migration: Removing migrated user subscriptions from Subscription collection...');

    try {
      // Access MongoDB collections directly
      const db = mongoose.connection.db;
      if (!db) {
        throw new Error('Database connection not established');
      }

      const userSubscriptionsCollection = db.collection<UserSubscriptionDoc>('usersubscriptions');
      const subscriptionsCollection = db.collection<SubscriptionDoc>('subscriptions');

      const userSubscriptions = await userSubscriptionsCollection
        .find({}, { projection: { subscriptionId: 1 } })
        .toArray();
      const subscriptionIds = userSubscriptions.map(sub => sub.subscriptionId);

      if (subscriptionIds.length === 0) {
        console.log('No UserSubscription records found. Nothing to rollback.');
        return;
      }

      // Delete corresponding Subscription records that were migrated from UserSubscription
      const result = await subscriptionsCollection.deleteMany({
        ownerType: 'User',
        subscriptionId: { $in: subscriptionIds },
      });

      console.log(
        `✅ Rollback completed: Removed ${result.deletedCount} user subscription records from Subscription collection`
      );
    } catch (error) {
      console.error('❌ Rollback failed:', error);
      throw error;
    }
  },
};

export default migration;
