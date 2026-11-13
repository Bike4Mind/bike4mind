import { FeedbackNoteModel, scrubLegacyFeedbackNotes, type MigrationFile } from '@bike4mind/database';

const migration: MigrationFile = {
  id: 20260921240086,
  name: 'move private feedback note bodies to retained storage',
  up: async () => {
    await FeedbackNoteModel.createIndexes();
    while ((await scrubLegacyFeedbackNotes()).scanned > 0) {
      // Repeat the bounded, idempotent pass until this deployment's snapshot is drained.
    }
  },
  down: async () => {
    // Never restore expired text or inline bodies to the general audit collection.
  },
};
export default migration;
