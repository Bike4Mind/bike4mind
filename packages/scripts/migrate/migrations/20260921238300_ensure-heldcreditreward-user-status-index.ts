import { HeldCreditRewardModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the HeldCreditReward (userId, status) index that pauseForUser and resumeForUser filter on, so
 * pausing or resuming one user's queued rewards reads that user's rows instead of every row of the status.
 * `autoIndex` is off in the deployed environments, so without this migration the declaration never builds.
 *
 * Idempotent: createIndexes is a no-op for an index that already matches.
 */
const migration: MigrationFile = {
  id: 20260921238300,
  name: 'ensure heldcreditreward user status index',

  up: async () => {
    await HeldCreditRewardModel.createIndexes();
  },

  down: async () => {
    await HeldCreditRewardModel.collection.dropIndex('userId_1_status_1');
  },
};

export default migration;
