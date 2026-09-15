import { Session as SessionModel } from '@bike4mind/database/auth';
import { MigrationFile } from '.';

const migration: MigrationFile = {
  id: 20250123223300,
  name: 'Add clonedSourceId and forkedSourceId to sessionmodels',

  up: async () => {
    await SessionModel.updateMany({ clonedSourceId: { $exists: false } }, { $set: { clonedSourceId: null } });

    await SessionModel.updateMany({ forkedSourceId: { $exists: false } }, { $set: { forkedSourceId: null } });
  },

  down: async () => {
    await SessionModel.updateMany({}, { $unset: { clonedSourceId: '', forkedSourceId: '' } });
  },
};

export default migration;
