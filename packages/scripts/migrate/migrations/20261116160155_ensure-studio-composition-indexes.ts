import { StudioComposition } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20261116160155,
  name: 'ensure-studio-composition-indexes',

  // Builds the owner list index declared on StudioCompositionModel. createIndexes is idempotent.
  up: async () => {
    await StudioComposition.createIndexes();
  },

  // A new collection's indexes are additive; nothing to undo.
  down: async () => {},
};

export default migration;
