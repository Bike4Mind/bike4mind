import { User, withTransaction } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20240312000000,
  name: 'add mementos to users',

  up: async () => {
    const users = await User.find({ mementos: { $exists: false } });

    for (const user of users) {
      console.log(`Adding mementos array to user ${user.id}`);
      await withTransaction(async session => {
        await User.updateOne({ _id: user.id }, { $set: { mementos: [] } }).session(session);
      });
    }
  },

  down: async () => {
    const users = await User.find();
    for (const user of users) {
      await withTransaction(async session => {
        await User.updateOne({ _id: user.id }, { $unset: { mementos: 1 } }).session(session);
        console.log(`Removed mementos from user ${user.id}`);
      });
    }
  },
};

export default migration;
