import { FeedbackModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the unique partial `feedback_helpContext_eventId` index exists on feedback.
 *
 * This index is not a query optimization: the help router finds-or-creates one report per help
 * event across two round trips, and the unique constraint is the only thing that serializes two
 * concurrent submissions (a double-submit, a retry, a second tab). Without it, both inserts
 * succeed and the user's comment lands on a permanent report twice, with a text sibling each.
 *
 * Migration rather than autoIndex, for the same reason as
 * 20260902000000_ensure-quest-retrieval-index: prod runs DocumentDB, where an index build takes a
 * foreground collection lock. A partial filter narrows what the index *stores*, not what the build
 * *scans*, so "the filter matches nothing on the deploy that ships it" does not make the build
 * free on a collection this size. Left to autoIndex it would build on whichever Lambda cold-boots
 * onto feedback first after deploy, and `connectMongo` only awaits the connection, so a failed
 * build is silent - the router would then run its find-or-create against no constraint at all.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist. It builds every index the
 * schema declares, so it also backfills any of this model's other declared indexes an environment
 * happens to be missing.
 */
const migration: MigrationFile = {
  id: 20260916000000,
  name: 'ensure feedback helpContext eventId index',

  up: async () => {
    await FeedbackModel.createIndexes();
  },

  down: async () => {
    // Dropping this would put the help router back on an unserialized find-or-create, which is
    // the defect it exists to prevent. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
