import { FeedbackModel, SreErrorTrackingModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the status indexes behind the admin sidebar's action counts exist:
 * `feedback_status_createdAt` on feedbacks (New reports) and `{ status: 1 }` on the SRE error
 * tracking collection (failed pipelines). /api/admin/action-counts is polled by every open admin
 * page, so these counts must not fall back to collection scans.
 *
 * Migration rather than autoIndex: autoIndex builds are fire-and-forget (a failure is silent) and
 * run on whichever Lambda cold-boots first. See 20260902000000_ensure-quest-retrieval-index.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist, and also backfills any of
 * these models' other declared indexes an environment happens to be missing.
 */
const migration: MigrationFile = {
  id: 20260921240050,
  name: 'ensure admin action count indexes',

  up: async () => {
    await FeedbackModel.createIndexes();
    await SreErrorTrackingModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive, and dropping these would put the polled counts back on collection
    // scans. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
