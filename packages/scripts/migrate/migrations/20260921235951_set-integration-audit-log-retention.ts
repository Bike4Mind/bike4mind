import { INTEGRATION_AUDIT_LOG_RETENTION_SECONDS, IntegrationAuditLogModel } from '@bike4mind/database';
import { setTtlIndexRetention } from '../setTtlIndexRetention';
import { type MigrationFile } from './index';

/** Raise the integration audit log TTL on createdAt to 12 months; see setTtlIndexRetention for why this needs collMod. */
const migration: MigrationFile = {
  id: 20260921235951,
  name: 'set integration audit log retention to 12 months',

  up: async () => {
    await setTtlIndexRetention(IntegrationAuditLogModel, { createdAt: 1 }, INTEGRATION_AUDIT_LOG_RETENTION_SECONDS);
  },

  down: async () => {
    // One-way. Shortening the TTL would immediately delete up to nine months of audit history.
  },
};

export default migration;
