import { BusinessMetricState } from '@bike4mind/database';
import type { MigrationFile } from './index';

const migration: MigrationFile = {
  // Keep below BackfillOAuthClientTokenEndpointAuthMethod, whose test requires the highest ID.
  id: 20260921235899,
  name: 'ensure business metric state TTL',
  up: async () => {
    await BusinessMetricState.createIndexes();
  },
  down: async () => {
    // Retention remains useful on rollback; deleting receipts could resend alerts on redeploy.
  },
};

export default migration;
