import {
  FabFile,
  Organization,
  OrganizationGeneratedObject,
  OrganizationRetentionEstimate,
  Session,
} from '@bike4mind/database';
import type { MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20261113125201,
  name: 'ensure organization retention indexes',
  up: async () => {
    await Session.collection.createIndex({ retentionOrganizationId: 1, deletedAt: 1, _id: 1 });
    await FabFile.collection.createIndex({ organizationId: 1, deletedAt: 1, createdAt: 1, _id: 1 });
    await Organization.collection.createIndex({ personal: 1, retentionLastSweptAt: 1, _id: 1 });
    await OrganizationGeneratedObject.createIndexes();
    await OrganizationRetentionEstimate.createIndexes();
  },
  down: async () => {},
};
export default migration;
