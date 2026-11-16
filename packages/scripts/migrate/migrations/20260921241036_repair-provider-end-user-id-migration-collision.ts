import { Migration, type MigrationFile } from '@bike4mind/database';
import providerBackfill from './20260921241030_backfill-user-provider-end-user-id';

/** A payments-only preview may have recorded the provider backfill's original numeric identity. */
const migration: MigrationFile = {
  id: 20260921241036,
  name: 'repair provider end-user id migration collision',
  up: async ctx => {
    const paymentsClaimedProviderId = await Migration.exists({
      id: 20260921241030,
      name: 'ensure payments report indexes',
    });
    if (paymentsClaimedProviderId) return providerBackfill.up(ctx);
  },
  down: async () => {
    // Preserve the original backfill's stored values and index.
  },
};

export default migration;
