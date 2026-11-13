import { FeedbackAiModel, AdminAiSuggestionModel, type MigrationFile } from '@bike4mind/database';

const migration: MigrationFile = {
  id: 20260921241037,
  name: 'ensure feedback AI and readiness evidence indexes',
  up: async () => {
    await FeedbackAiModel.createIndexes();
    await AdminAiSuggestionModel.createIndexes();
  },
  down: async () => {},
};
export default migration;
