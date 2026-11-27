import { DlqTriageDeliveryModel, type MigrationFile } from '@bike4mind/database';

const migration: MigrationFile = {
  id: 20261116061739,
  name: 'ensure DLQ triage delivery deduplication and retention indexes',
  up: async () => {
    await DlqTriageDeliveryModel.createIndexes();
  },
  down: async () => {},
};
export default migration;
