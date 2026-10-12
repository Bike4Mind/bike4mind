import { Session } from '@bike4mind/database';
import { type MigrationFile } from './index';

// Keep the five-minute stale-hold sweep off a collection scan in production.
const migration: MigrationFile = {
  id: 20260921235993,
  name: 'ensure stale voice hold index',
  up: async () => {
    await Session.createIndexes();
  },
  down: async () => {
    // The sweep depends on this index; removal needs a forward migration.
  },
};

export default migration;
