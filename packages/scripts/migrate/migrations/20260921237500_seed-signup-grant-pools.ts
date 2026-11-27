import { AdminSettings, seedSignupGrantPools } from '@bike4mind/database';
import type { MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20260921237500,
  name: 'seed-signup-grant-pools',
  up: async () => {
    await seedSignupGrantPools(AdminSettings);
  },
  // Preserve pool values changed by an operator after migration.
  down: async () => {},
};

export default migration;
