/* eslint-disable @typescript-eslint/no-explicit-any */
import { QuestMasterPlan, Session } from '@bike4mind/database';
import mongoose from 'mongoose';
import { type MigrationFile } from './index';

/**
 * Migration to add userId and other new fields to existing QuestMasterPlan documents
 * This enables cross-session quest persistence
 */
const migration: MigrationFile = {
  id: 20251014000000,
  name: 'Enhance QuestMaster Plans for cross-session persistence',

  up: async () => {
    console.log('Starting QuestMasterPlan enhancement migration...');

    try {
      // Find all quest plans that don't have userId field
      const plans = await QuestMasterPlan.find({ userId: { $exists: false } });
      console.log(`Found ${plans.length} quest plans to migrate`);

      let successCount = 0;
      let failureCount = 0;

      // Track orphaned plans for reporting
      const orphanedPlans: { id: string; notebookId: string }[] = [];

      // Batch fetch all sessions for efficiency (avoid N+1 queries)
      const notebookIds = plans.map(p => p.notebookId);
      const sessions = await Session.find({ _id: { $in: notebookIds } }).select('_id userId');
      const sessionMap = new Map(sessions.map(s => [s._id.toString(), s.userId]));

      // Build bulk operations for efficient batch update
      const bulkOps: {
        updateOne: {
          filter: { _id: any };
          update: { $set: Record<string, unknown> };
        };
      }[] = [];

      for (const plan of plans) {
        const userId = sessionMap.get(plan.notebookId);

        if (!userId) {
          // Mark as orphaned but still migrate with a placeholder
          console.warn(`Session not found for plan ${plan._id}, notebook ${plan.notebookId}`);
          console.warn(`Plan will be migrated with visibility='session' (legacy access only)`);
          orphanedPlans.push({ id: plan._id.toString(), notebookId: plan.notebookId });
        }

        // Calculate initial metrics with defensive null checks
        const allSubQuests = (plan.quests || []).flatMap((q: any) => q.subQuests || []);
        const completed = allSubQuests.filter((sq: any) => sq.status === 'completed').length;
        const total = allSubQuests.length;

        // Build update object - only include userId if we have one
        const updateFields: Record<string, unknown> = {
          // Default visibility to session (conservative approach)
          // Orphaned plans stay session-scoped until claimed
          visibility: 'session',

          // Set state based on completion
          state: completed === total && total > 0 ? 'completed' : 'active',

          // Access tracking
          lastAccessedAt: plan.updatedAt || new Date(),

          // Session history
          sessionHistory: [
            {
              sessionId: plan.notebookId,
              lastAccessed: plan.updatedAt || new Date(),
              actions: 1,
            },
          ],

          // Initial metrics
          metrics: {
            totalTimeSpent: 0,
            completionRate: total > 0 ? Math.round((completed / total) * 100) : 0,
            subQuestsCompleted: completed,
            subQuestsTotal: total,
            lastProgress: plan.updatedAt || new Date(),
          },

          // Initialize empty arrays
          tags: [],
          sharedWith: [],
        };

        // Only set userId if we found one
        if (userId) {
          updateFields.userId = userId;
        }

        bulkOps.push({
          updateOne: {
            filter: { _id: plan._id },
            update: { $set: updateFields },
          },
        });
      }

      // Bulk-write all updates at once for throughput.
      if (bulkOps.length > 0) {
        try {
          const bulkResult = await QuestMasterPlan.bulkWrite(bulkOps, { ordered: false });
          successCount = bulkResult.modifiedCount;
          console.log(`✓ Bulk migrated ${successCount} plans`);
        } catch (error) {
          console.error('Bulk write failed:', error);
          // Fall back to counting partial success from error
          if (error && typeof error === 'object' && 'result' in error) {
            const partialResult = (error as { result: { nModified: number } }).result;
            successCount = partialResult?.nModified || 0;
          }
          failureCount += bulkOps.length - successCount;
        }
      }

      // Indexes are defined in the Mongoose schema (QuestMasterPlanModel.ts) and
      // created automatically on model init - no need to create them here.

      console.log('\n=== Migration Complete ===');
      console.log(`Successfully migrated: ${successCount} plans`);
      console.log(`Failed: ${failureCount} plans`);
      console.log(`Orphaned (no session): ${orphanedPlans.length} plans`);
      console.log(`Total processed: ${plans.length} plans`);

      if (orphanedPlans.length > 0) {
        console.log('\n=== Orphaned Plans (migrated without userId) ===');
        console.log('These plans were migrated but have no owner.');
        console.log('They remain accessible via their original session only.');
        console.log('Users can claim ownership through the backfill mechanism when accessing.');
        orphanedPlans.forEach(p => console.log(`  - Plan ${p.id} (notebook: ${p.notebookId})`));
      }

      if (failureCount > 0) {
        console.log('\nNote: Some plans failed to migrate due to errors.');
        console.log('Check the error logs above for details.');
      }
    } catch (error) {
      console.error('Migration failed:', error);
      throw error;
    }
  },

  /**
   * Rollback migration - remove added fields
   */
  down: async () => {
    console.log('Rolling back QuestMasterPlan enhancement migration...');

    try {
      // Remove added fields from all documents
      await QuestMasterPlan.updateMany(
        {},
        {
          $unset: {
            userId: 1,
            visibility: 1,
            state: 1,
            lastAccessedAt: 1,
            sessionHistory: 1,
            metrics: 1,
            tags: 1,
            priority: 1,
            parentPlanId: 1,
            sharedWith: 1,
          },
        }
      );

      console.log('✓ Removed new fields from all quest plans');

      // Drop the indexes we created
      const collection = mongoose.connection.collection('questmasterplans');

      try {
        await collection.dropIndex('userId_1_state_1');
        console.log('✓ Dropped index: userId_1_state_1');
      } catch (e) {
        console.log('Index userId_1_state_1 not found (may not exist)');
      }

      try {
        await collection.dropIndex('userId_1_lastAccessedAt_-1');
        console.log('✓ Dropped index: userId_1_lastAccessedAt_-1');
      } catch (e) {
        console.log('Index userId_1_lastAccessedAt_-1 not found (may not exist)');
      }

      try {
        await collection.dropIndex('visibility_1_sharedWith_1');
        console.log('✓ Dropped index: visibility_1_sharedWith_1');
      } catch (e) {
        console.log('Index visibility_1_sharedWith_1 not found (may not exist)');
      }

      console.log('\n=== Rollback Complete ===');
    } catch (error) {
      console.error('Rollback failed:', error);
      throw error;
    }
  },
};

export default migration;
