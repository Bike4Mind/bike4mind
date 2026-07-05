import { CreditTransaction } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20250917124558,
  name: 'migrate old credits txn history',

  up: async () => {
    // Remove old index. New index will be created automatically by mongoose
    const dropResult = await CreditTransaction.collection.dropIndex('stripePaymentIntentId_1');
    console.log(`Dropped index: ${JSON.stringify(dropResult)}`);

    // Backfill 'type' as 'purchase' for old transactions that lack it.
    const result = await CreditTransaction.updateMany({ type: { $exists: false } }, { $set: { type: 'purchase' } });
    console.log(`Migration completed: Updated ${result.modifiedCount} credit transactions with type 'purchase'`);
  },

  down: async () => {},
};

export default migration;
