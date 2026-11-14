import {
  GeneratedFileCleanupModel,
  Organization,
  Session,
  FabFile,
  OrganizationGeneratedObject,
  OrganizationRetentionEstimate,
} from '@bike4mind/database';
import type { MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20261113185006,
  name: 'ensure organization retention erasure indexes',
  up: async () => {
    await Session.collection.createIndex(
      { retentionOrganizationId: 1, deletedAt: 1, _id: 1 },
      { name: 'retention_sessions_present', partialFilterExpression: { retentionOrganizationId: { $exists: true } } }
    );
    await FabFile.collection.createIndex(
      { organizationId: 1, deletedAt: 1, createdAt: 1, _id: 1 },
      { name: 'retention_files_present', partialFilterExpression: { organizationId: { $exists: true } } }
    );
    await FabFile.collection.createIndex(
      { 'sourceMetadata.retentionOrganizationId': 1, deletedAt: 1, createdAt: 1, _id: 1 },
      {
        name: 'retention_generated_files_present',
        partialFilterExpression: { 'sourceMetadata.retentionOrganizationId': { $exists: true } },
      }
    );
    await Organization.collection.createIndex(
      { personal: 1, retentionLastSweptAt: 1, _id: 1 },
      { name: 'retention_opted_in_sweep', partialFilterExpression: { retentionVersion: { $gt: 0 } } }
    );
    await GeneratedFileCleanupModel.createIndexes();
    await OrganizationGeneratedObject.collection.createIndex({ userId: 1 });
    await OrganizationRetentionEstimate.collection.createIndex({ actorUserId: 1 });
  },
  down: async () => {},
};
export default migration;
