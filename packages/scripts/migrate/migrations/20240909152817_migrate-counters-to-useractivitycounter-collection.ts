import { IUser } from '@bike4mind/common';
import { ICounters } from '@bike4mind/common';
import { UserActivityCounter, User, withTransaction } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20240909152817,
  name: 'migrate counters to UserActivityCounter collection',

  up: async () => {
    const users = await User.find({}, { counters: 1 });

    for (const user of users) {
      console.log(`Migrating counters for user ${user.id}`);
      await withTransaction(async session => {
        // Cast to reach the legacy counters field, removed from IUser after it was migrated to its own collection.
        const counters = (user as unknown as IUser & { counters: ICounters })?.counters?.counters ?? [];

        if (!counters.length) {
          console.log(`No counters to migrate for user ${user.id}. Skipping...`);
          return;
        }

        // Upsert and increment in bulk
        await UserActivityCounter.bulkWrite(
          counters.map(counter => {
            return {
              updateOne: {
                filter: { userId: user.id, action: counter.type },
                update: {
                  $inc: { count: counter.value },
                  $set: { tags: counter.tags ?? [] },
                },
                upsert: true,
              },
            };
          }),
          { session }
        );

        // Remove the counters field from the user document
        await User.updateOne({ _id: user.id }, { $unset: { counters: 1 } }).session(session);
        console.log(`Migrated ${counters.length} counters for user ${user.id}`);
      });
    }
  },

  down: async () => {
    const users = await User.find();
    for (const user of users) {
      await withTransaction(async session => {
        const counters = await UserActivityCounter.find({ userId: user.id }).session(session);
        await User.updateOne(
          { _id: user.id },
          {
            $set: {
              counters: {
                counters: counters.map(counter => ({
                  type: counter.action,
                  value: counter.count,
                  tags: counter.tags,
                })),
              },
            },
          }
        ).session(session);

        // Clear the user activity counters
        await UserActivityCounter.deleteMany({ userId: user.id }).session(session);
      });

      console.log(`Reverted counters for user ${user.id}`);
    }
  },
};

export default migration;
