import { USER_AUTH_AUDIT_LOG_RETENTION_SECONDS, UserAuthAuditLogModel } from '@bike4mind/database';
import { setTtlIndexRetention } from '../setTtlIndexRetention';
import { type MigrationFile } from './index';

/** Raise the user auth audit log TTL on createdAt to 12 months; see setTtlIndexRetention for why this needs collMod. */
const migration: MigrationFile = {
  id: 20260921235950,
  name: 'set user auth audit log retention to 12 months',

  up: async () => {
    await setTtlIndexRetention(UserAuthAuditLogModel, { createdAt: 1 }, USER_AUTH_AUDIT_LOG_RETENTION_SECONDS);
  },

  down: async () => {
    // One-way. Shortening the TTL would immediately delete up to nine months of audit history.
  },
};

export default migration;
