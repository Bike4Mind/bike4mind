import { BusinessMetricState, Organization, User } from '@bike4mind/database';
import type { MigrationFile } from './index';

const migration: MigrationFile = {
  // Keep below BackfillOAuthClientTokenEndpointAuthMethod, whose test requires the highest ID.
  id: 20260921235899,
  name: 'ensure business metric indexes',
  up: async () => {
    await BusinessMetricState.createIndexes();
    await User.collection.createIndex({ stripeCustomerId: 1 }, { name: 'user_stripeCustomerId' });
    await Organization.collection.createIndex({ stripeCustomerId: 1 }, { name: 'organization_stripeCustomerId' });
  },
  down: async () => {
    // Retention remains useful on rollback; deleting receipts could resend alerts on redeploy.
  },
};

export default migration;
