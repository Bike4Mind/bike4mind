import { FeedbackModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the `feedback_org_createdAt` index exists on feedback.
 *
 * The org feedback report matches `{ organizationId, createdAt: { $gte, $lt } }` and reads newest
 * first. The existing `feedback_org_subject_createdAt` cannot serve that: `createdAt` sits behind
 * `subject` there and DocumentDB has no skip-scan, so a report that spans all subjects gets no
 * range bound on the date and falls back to scanning every row stamped with the org.
 *
 * Migration rather than autoIndex, for the same reason as
 * 20260909000000_ensure-quest-images-index: prod runs DocumentDB, where an index build takes a
 * foreground collection lock. Feedback is written on every user report (the create handler at
 * apps/client/pages/api/feedback/index.ts), so leaving the build to whichever Lambda cold-boots
 * first after deploy would block those writes at an arbitrary moment rather than a chosen one.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist, and builds every index the
 * schema declares (so it also backfills any other declared index an environment is missing). The
 * index name matches the schema declaration byte-for-byte, so this build and autoIndex cannot
 * produce an IndexKeySpecsConflict.
 */
const migration: MigrationFile = {
  id: 20260918000000,
  name: 'ensure feedback org createdAt index',

  up: async () => {
    await FeedbackModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive, and dropping this one would put the org report back on a collection
    // scan. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
