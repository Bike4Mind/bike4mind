import { CounterLog, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20251010091008,
  name: 'drop conflicting counterlog index',

  up: async () => {
    await safeDropIndex(CounterLog.collection, 'userId_1_createdAt_-1_counterName_1');
  },

  down: async () => {},
};

export default migration;
