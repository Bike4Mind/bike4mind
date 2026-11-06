import { Quest, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

export const SIGNUP_ACTIVITY_INDEX_NAME = 'signupActivity_user_status_startedAt';
const SIGNUP_ACTIVITY_INDEX_KEY = { 'signupActivity.userId': 1, status: 1, 'signupActivity.startedAt': 1 } as const;
const BATCH_SIZE = 1000;

/**
 * Clear the retired `signupActivity` turn provenance from quests and drop the index that served it.
 * The signup grant drip reads `User.signupGrant.activity`; nothing reads this field any more.
 *
 * Every stamped quest carried `signupActivity.userId`, so the clear filters on it to use the
 * partial index, and runs before the drop. Id stays below SeedSignupGrantPools (its test orders
 * every signup migration before it). down rebuilds the index only; cleared values are not restorable.
 */
const migration: MigrationFile = {
  id: 20260921237490,
  name: 'drop quest signup activity',

  up: async () => {
    const filter = { 'signupActivity.userId': { $exists: true } };
    for (;;) {
      const ids = (
        await Quest.collection
          .find(filter, { projection: { _id: 1 } })
          .limit(BATCH_SIZE)
          .toArray()
      ).map(doc => doc._id);
      if (ids.length === 0) break;
      await Quest.collection.updateMany({ _id: { $in: ids } }, { $unset: { signupActivity: '' } });
    }
    await safeDropIndex(Quest.collection, SIGNUP_ACTIVITY_INDEX_NAME);
  },

  down: async () => {
    await Quest.collection.createIndex(SIGNUP_ACTIVITY_INDEX_KEY, {
      name: SIGNUP_ACTIVITY_INDEX_NAME,
      partialFilterExpression: { 'signupActivity.userId': { $exists: true } },
    });
  },
};

export default migration;
