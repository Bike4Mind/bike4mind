import { ApiKeyUsageLog, AuthSessionModel, Organization } from '@bike4mind/database';
import { type MigrationFile } from './index';

// Below the fail-closed OAuth backfill so these indexes can deploy independently.
const migration: MigrationFile = {
  id: 20260921239987,
  name: 'ensure admin search indexes',
  up: async () => {
    await AuthSessionModel.collection.createIndex(
      { 'device.ip': 1, lastUsedAt: -1 },
      { name: 'auth_session_ip_search' }
    );
    await ApiKeyUsageLog.collection.createIndex({ ipAddress: 1, timestamp: -1 }, { name: 'api_usage_ip_search' });
    await Organization.collection.createIndex(
      { name: 1 },
      { collation: { locale: 'en', strength: 2 }, name: 'organization_name_ci' }
    );
  },
  down: async () => {
    // Keep additive read indexes available to deployed application versions.
  },
};

export default migration;
