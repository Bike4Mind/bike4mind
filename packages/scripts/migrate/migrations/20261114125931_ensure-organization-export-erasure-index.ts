import { OrganizationAuditEventModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20261114125931,
  name: 'ensure organization export erasure index',

  up: async () => {
    await OrganizationAuditEventModel.collection.createIndex(
      { actorUserId: 1, action: 1, _id: 1 },
      { name: 'organization_export_erasure_locators' }
    );
  },

  down: async () => {},
};

export default migration;
