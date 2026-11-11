import { Session } from '@bike4mind/database';
import type { MigrationFile } from './index';

/** Build the colleague lookup's group arm before serving it; autoIndex is not awaited on boot. */
const migration: MigrationFile = {
  id: 20260921240080,
  name: 'ensure session group read index',
  up: async () => {
    await Session.createIndexes();
  },
  down: async () => {
    // Additive performance index; removing it is a deliberate forward migration.
  },
};
export default migration;
