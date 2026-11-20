import { HeldCreditRewardModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the HeldCreditReward indexes: the unique transactionId behind the queued reward hold, and the
 * (status, heldAt, _id) index the release job and the queue-head check scan oldest first.
 *
 * heldCreditRewardRepository.hold() dedupes a repeat or concurrent hold with an upsert on
 * transactionId, and only the unique index makes that upsert collapse two simultaneous claims into one
 * row. `autoIndex` is off in the deployed environments, so without this migration the declaration
 * never builds and a double claim on a dry pool queues the same reward twice.
 *
 * Idempotent: createIndexes is a no-op for an index that already matches.
 */
const migration: MigrationFile = {
  id: 20260921237600,
  name: 'ensure heldcreditreward indexes',

  up: async () => {
    await HeldCreditRewardModel.createIndexes();
  },

  down: async () => {
    // One-way. Dropping the unique index would let duplicate held rows accumulate.
  },
};

export default migration;
