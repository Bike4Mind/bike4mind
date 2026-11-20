import { AdminAiAttemptModel, type MigrationFile } from '@bike4mind/database';

const migration: MigrationFile = {
  id: 20260921241039,
  name: 'expire AI attempt metadata after 400 days',
  up: async () => {
    await AdminAiAttemptModel.createIndexes();
  },
  down: async () => {},
};
export default migration;
