import { FeedbackModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the `feedback_status_contentStored_createdAt` index exists on feedback.
 *
 * The admin triage list's has-comment filter matches `{ status: { $in }, contentStored, createdAt }`
 * and reads newest first. `feedback_status_createdAt` alone would bound the status and date but
 * fetch every row in that range to test `contentStored`.
 *
 * Migration rather than autoIndex, for the same reason as 20260918000000_ensure-feedback-org-createdat-index:
 * autoIndex builds are fire-and-forget (a failure is silent) and would block report writes on
 * whichever Lambda cold-boots first after deploy.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist, and builds every index the
 * schema declares. The name matches the schema declaration, so this build and autoIndex cannot
 * produce an IndexKeySpecsConflict.
 */
const migration: MigrationFile = {
  id: 20261113124253,
  name: 'ensure feedback status contentStored index',

  up: async () => {
    await FeedbackModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
