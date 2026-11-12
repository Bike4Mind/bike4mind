import { FeedbackAiModel, type MigrationFile } from '@bike4mind/database';

const migration: MigrationFile = {
  id: 20261112010000,
  name: 'ensure feedback AI indexes',
  up: async () => {
    await FeedbackAiModel.createIndexes();
  },
  down: async () => {},
};
export default migration;
